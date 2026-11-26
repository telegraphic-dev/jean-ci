import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { APP_BASE_URL } from '../config.ts';
import {
  createMcpOAuthClient,
  createMcpOAuthCode,
  createMcpOAuthPending,
  createMcpOAuthToken,
  consumeMcpOAuthPending,
  exchangeMcpOAuthCodeAtomic,
  getMcpOAuthClient,
  getMcpOAuthCode,
  getMcpOAuthPending,
  getMcpOAuthToken,
  markMcpOAuthCodeUsed,
  revokeMcpOAuthToken,
  revokeMcpOAuthTokensByCode,
  revokeMcpOAuthTokensByFamily,
  rotateMcpOAuthRefreshTokenAtomic,
  type AtomicOAuthCodeExchangeResult,
  type AtomicOAuthRefreshRotateResult,
  type McpOAuthClientDbRecord,
  type McpOAuthCodeDbRecord,
  type McpOAuthPendingDbRecord,
  type McpOAuthTokenDbRecord,
} from '../db.ts';

export const MCP_OAUTH_SCOPES = ['mcp:read', 'mcp:write'] as const;
export const MCP_OAUTH_DEFAULT_SCOPE = 'mcp:read mcp:write';
export const MCP_OAUTH_ACCESS_TOKEN_PREFIX = 'jci_oauth_at_';
export const MCP_OAUTH_REFRESH_TOKEN_PREFIX = 'jci_oauth_rt_';

export const ACCESS_TOKEN_TTL_SEC = 3600; // 1 hour
export const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 3600; // 30 days
export const AUTH_CODE_TTL_SEC = 300; // 5 minutes
export const PENDING_AUTH_TTL_SEC = 600; // 10 minutes
export const OAUTH_CSRF_COOKIE_NAME = 'jean-ci-mcp-oauth-csrf';

const MAX_CIMD_BYTES = 64 * 1024;
const MAX_OAUTH_STATE_LEN = 2048;
const MAX_REDIRECT_URIS = 100;
const CIMD_TIMEOUT_MS = 5000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface McpOAuthClient {
  clientId: string;
  clientSecretHash: string | null;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: 'none' | 'client_secret_post' | 'client_secret_basic';
  scope: string;
  isCimd?: boolean;
}

export interface McpOAuthPending {
  requestId: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  scope: string;
  state: string | null;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  resource: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface McpOAuthCode {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  userId: string;
  userLogin: string;
  usedAt: Date | null;
  expiresAt: Date;
}

export interface McpOAuthTokenRecord {
  tokenHash: string;
  tokenType: 'access' | 'refresh';
  familyId: string;
  sourceCodeHash: string | null;
  clientId: string;
  resource: string;
  scope: string;
  userId: string;
  userLogin: string;
  revokedAt: Date | null;
  expiresAt: Date;
}

export interface McpOAuthStore {
  createClient(client: McpOAuthClient): Promise<McpOAuthClient>;
  getClient(clientId: string): Promise<McpOAuthClient | null>;
  createPending(pending: McpOAuthPending): Promise<McpOAuthPending>;
  getPending(requestId: string): Promise<McpOAuthPending | null>;
  consumePending(requestId: string): Promise<McpOAuthPending | null>;
  createCode(code: McpOAuthCode): Promise<McpOAuthCode>;
  getCode(codeHash: string): Promise<McpOAuthCode | null>;
  markCodeUsed(codeHash: string): Promise<McpOAuthCode | null>;
  createToken(token: McpOAuthTokenRecord): Promise<McpOAuthTokenRecord>;
  getToken(tokenHash: string): Promise<McpOAuthTokenRecord | null>;
  revokeToken(tokenHash: string): Promise<boolean>;
  revokeTokensByFamily(familyId: string): Promise<number>;
  revokeTokensByCode(sourceCodeHash: string): Promise<number>;
  exchangeCodeAtomic(params: {
    codeHash: string;
    accessToken: Omit<McpOAuthTokenRecord, 'tokenType' | 'sourceCodeHash' | 'revokedAt'>;
    refreshToken: Omit<McpOAuthTokenRecord, 'tokenType' | 'sourceCodeHash' | 'revokedAt'>;
  }): Promise<AtomicOAuthCodeExchangeResult>;
  rotateRefreshTokenAtomic(params: {
    refreshTokenHash: string;
    familyId: string;
    accessToken: Omit<McpOAuthTokenRecord, 'tokenType' | 'familyId' | 'revokedAt'>;
    nextRefreshToken: Omit<McpOAuthTokenRecord, 'tokenType' | 'familyId' | 'revokedAt'>;
  }): Promise<AtomicOAuthRefreshRotateResult>;
}

function mapClientRow(row: McpOAuthClientDbRecord): McpOAuthClient {
  const method =
    row.token_endpoint_auth_method === 'client_secret_post' ||
    row.token_endpoint_auth_method === 'client_secret_basic'
      ? row.token_endpoint_auth_method
      : 'none';
  return {
    clientId: row.client_id,
    clientSecretHash: row.client_secret_hash,
    clientName: row.client_name,
    redirectUris: Array.isArray(row.redirect_uris) ? row.redirect_uris : [],
    grantTypes: Array.isArray(row.grant_types) ? row.grant_types : ['authorization_code'],
    tokenEndpointAuthMethod: method,
    scope: row.scope || MCP_OAUTH_DEFAULT_SCOPE,
  };
}

function mapPendingRow(row: McpOAuthPendingDbRecord): McpOAuthPending {
  return {
    requestId: row.request_id,
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUri: row.redirect_uri,
    scope: row.scope,
    state: row.state,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: 'S256',
    resource: row.resource,
    csrfToken: row.csrf_token,
    expiresAt: new Date(row.expires_at),
  };
}

function mapCodeRow(row: McpOAuthCodeDbRecord): McpOAuthCode {
  return {
    codeHash: row.code_hash,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    resource: row.resource,
    scope: row.scope,
    userId: row.user_id,
    userLogin: row.user_login,
    usedAt: row.used_at ? new Date(row.used_at) : null,
    expiresAt: new Date(row.expires_at),
  };
}

function mapTokenRow(row: McpOAuthTokenDbRecord): McpOAuthTokenRecord {
  return {
    tokenHash: row.token_hash,
    tokenType: row.token_type,
    familyId: row.family_id,
    sourceCodeHash: row.source_code_hash,
    clientId: row.client_id,
    resource: row.resource,
    scope: row.scope,
    userId: row.user_id,
    userLogin: row.user_login,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    expiresAt: new Date(row.expires_at),
  };
}

let sharedDbOAuthStore: McpOAuthStore | null = null;

export function createDbMcpOAuthStore(): McpOAuthStore {
  if (sharedDbOAuthStore) return sharedDbOAuthStore;
  sharedDbOAuthStore = {
    createClient: async (client) => mapClientRow(await createMcpOAuthClient(client)),
    getClient: async (clientId) => {
      const row = await getMcpOAuthClient(clientId);
      return row ? mapClientRow(row) : null;
    },
    createPending: async (pending) => mapPendingRow(await createMcpOAuthPending(pending)),
    getPending: async (requestId) => {
      const row = await getMcpOAuthPending(requestId);
      return row ? mapPendingRow(row) : null;
    },
    consumePending: async (requestId) => {
      const row = await consumeMcpOAuthPending(requestId);
      return row ? mapPendingRow(row) : null;
    },
    createCode: async (code) => mapCodeRow(await createMcpOAuthCode(code)),
    getCode: async (codeHash) => {
      const row = await getMcpOAuthCode(codeHash);
      return row ? mapCodeRow(row) : null;
    },
    markCodeUsed: async (codeHash) => {
      const row = await markMcpOAuthCodeUsed(codeHash);
      return row ? mapCodeRow(row) : null;
    },
    createToken: async (token) => mapTokenRow(await createMcpOAuthToken(token)),
    getToken: async (tokenHash) => {
      const row = await getMcpOAuthToken(tokenHash);
      return row ? mapTokenRow(row) : null;
    },
    revokeToken: async (tokenHash) => revokeMcpOAuthToken(tokenHash),
    revokeTokensByFamily: async (familyId) => revokeMcpOAuthTokensByFamily(familyId),
    revokeTokensByCode: async (sourceCodeHash) => revokeMcpOAuthTokensByCode(sourceCodeHash),
    exchangeCodeAtomic: async (params) => exchangeMcpOAuthCodeAtomic(params),
    rotateRefreshTokenAtomic: async (params) => rotateMcpOAuthRefreshTokenAtomic(params),
  };
  return sharedDbOAuthStore;
}

export class InMemoryMcpOAuthStore implements McpOAuthStore {
  private readonly clients = new Map<string, McpOAuthClient>();
  private readonly pending = new Map<string, McpOAuthPending>();
  private readonly codes = new Map<string, McpOAuthCode>();
  private readonly tokens = new Map<string, McpOAuthTokenRecord>();

  async createClient(client: McpOAuthClient): Promise<McpOAuthClient> {
    const copy = { ...client, redirectUris: [...client.redirectUris], grantTypes: [...client.grantTypes] };
    this.clients.set(client.clientId, copy);
    return copy;
  }

  async getClient(clientId: string): Promise<McpOAuthClient | null> {
    return this.clients.get(clientId) || null;
  }

  async createPending(pending: McpOAuthPending): Promise<McpOAuthPending> {
    const copy = { ...pending };
    this.pending.set(pending.requestId, copy);
    return copy;
  }

  async getPending(requestId: string): Promise<McpOAuthPending | null> {
    const row = this.pending.get(requestId);
    if (!row || row.expiresAt.getTime() <= Date.now()) {
      this.pending.delete(requestId);
      return null;
    }
    return row;
  }

  async consumePending(requestId: string): Promise<McpOAuthPending | null> {
    const row = await this.getPending(requestId);
    if (!row) return null;
    this.pending.delete(requestId);
    return row;
  }

  async createCode(code: McpOAuthCode): Promise<McpOAuthCode> {
    const copy = { ...code };
    this.codes.set(code.codeHash, copy);
    return copy;
  }

  async getCode(codeHash: string): Promise<McpOAuthCode | null> {
    return this.codes.get(codeHash) || null;
  }

  async markCodeUsed(codeHash: string): Promise<McpOAuthCode | null> {
    const row = this.codes.get(codeHash);
    if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) return null;
    row.usedAt = new Date();
    return row;
  }

  async createToken(token: McpOAuthTokenRecord): Promise<McpOAuthTokenRecord> {
    const copy = { ...token };
    this.tokens.set(token.tokenHash, copy);
    return copy;
  }

  async getToken(tokenHash: string): Promise<McpOAuthTokenRecord | null> {
    return this.tokens.get(tokenHash) || null;
  }

  async revokeToken(tokenHash: string): Promise<boolean> {
    const row = this.tokens.get(tokenHash);
    if (!row || row.revokedAt) return false;
    row.revokedAt = new Date();
    return true;
  }

  async revokeTokensByFamily(familyId: string): Promise<number> {
    let count = 0;
    const now = new Date();
    for (const row of this.tokens.values()) {
      if (row.familyId === familyId && !row.revokedAt) {
        row.revokedAt = now;
        count += 1;
      }
    }
    return count;
  }

  async revokeTokensByCode(sourceCodeHash: string): Promise<number> {
    let count = 0;
    const now = new Date();
    for (const row of this.tokens.values()) {
      if (row.sourceCodeHash === sourceCodeHash && !row.revokedAt) {
        row.revokedAt = now;
        count += 1;
      }
    }
    return count;
  }

  async exchangeCodeAtomic(params: {
    codeHash: string;
    accessToken: Omit<McpOAuthTokenRecord, 'tokenType' | 'sourceCodeHash' | 'revokedAt'>;
    refreshToken: Omit<McpOAuthTokenRecord, 'tokenType' | 'sourceCodeHash' | 'revokedAt'>;
  }): Promise<AtomicOAuthCodeExchangeResult> {
    const row = this.codes.get(params.codeHash);
    if (!row) return { status: 'not_found' };
    if (row.usedAt) {
      const now = new Date();
      for (const tok of this.tokens.values()) {
        if (tok.sourceCodeHash === params.codeHash && !tok.revokedAt) tok.revokedAt = now;
      }
      return { status: 'replayed' };
    }
    if (row.expiresAt.getTime() <= Date.now()) return { status: 'expired' };

    row.usedAt = new Date();
    this.tokens.set(params.accessToken.tokenHash, {
      ...params.accessToken,
      tokenType: 'access',
      sourceCodeHash: params.codeHash,
      revokedAt: null,
    });
    this.tokens.set(params.refreshToken.tokenHash, {
      ...params.refreshToken,
      tokenType: 'refresh',
      sourceCodeHash: params.codeHash,
      revokedAt: null,
    });
    return { status: 'issued' };
  }

  async rotateRefreshTokenAtomic(params: {
    refreshTokenHash: string;
    familyId: string;
    accessToken: Omit<McpOAuthTokenRecord, 'tokenType' | 'familyId' | 'revokedAt'>;
    nextRefreshToken: Omit<McpOAuthTokenRecord, 'tokenType' | 'familyId' | 'revokedAt'>;
  }): Promise<AtomicOAuthRefreshRotateResult> {
    const row = this.tokens.get(params.refreshTokenHash);
    if (!row || row.tokenType !== 'refresh' || row.familyId !== params.familyId) {
      return { status: 'not_found' };
    }
    if (row.revokedAt) {
      const now = new Date();
      for (const tok of this.tokens.values()) {
        if (tok.familyId === params.familyId && !tok.revokedAt) tok.revokedAt = now;
      }
      return { status: 'replayed' };
    }
    if (row.expiresAt.getTime() <= Date.now()) return { status: 'expired' };

    row.revokedAt = new Date();
    this.tokens.set(params.accessToken.tokenHash, {
      ...params.accessToken,
      tokenType: 'access',
      familyId: params.familyId,
      revokedAt: null,
    });
    this.tokens.set(params.nextRefreshToken.tokenHash, {
      ...params.nextRefreshToken,
      tokenType: 'refresh',
      familyId: params.familyId,
      revokedAt: null,
    });
    return { status: 'rotated' };
  }
}

export function hashOAuthSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function normalizeOrigin(baseUrl?: string): string {
  const raw = (baseUrl || APP_BASE_URL).trim();
  return new URL(raw).origin;
}

export function buildOAuthCorsHeaders(methods = 'GET, POST, OPTIONS'): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, MCP-Protocol-Version',
    'Access-Control-Max-Age': '86400',
  };
}

export function buildProtectedResourceMetadata(baseUrl?: string, resourcePath: '/mcp' | '/api/mcp' = '/mcp') {
  const origin = normalizeOrigin(baseUrl);
  return {
    resource: `${origin}${resourcePath}`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: [...MCP_OAUTH_SCOPES],
    resource_name: 'Jean CI MCP Server',
    resource_documentation: `${origin}/api/mcp/server-card`,
  };
}

export function buildAuthorizationServerMetadata(baseUrl?: string) {
  const origin = normalizeOrigin(baseUrl);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [...MCP_OAUTH_SCOPES],
    client_id_metadata_document_supported: true,
  };
}

function escapeHeaderQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ');
}

export function buildWwwAuthenticateHeader(
  baseUrl?: string,
  resourcePath: '/mcp' | '/api/mcp' = '/mcp',
  error?: 'invalid_token' | 'insufficient_scope',
  errorDescription?: string,
): string {
  const origin = normalizeOrigin(baseUrl);
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource${resourcePath}`;
  const parts = [
    'realm="jean-ci-mcp"',
    `resource_metadata="${escapeHeaderQuoted(metadataUrl)}"`,
    `scope="${MCP_OAUTH_DEFAULT_SCOPE}"`,
  ];
  if (error) {
    parts.push(`error="${error}"`);
  }
  if (errorDescription) {
    parts.push(`error_description="${escapeHeaderQuoted(errorDescription)}"`);
  }
  return `Bearer ${parts.join(', ')}`;
}

export function isValidRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.hash) return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol === 'https:') {
    return Boolean(parsed.hostname);
  }
  if (parsed.protocol === 'http:') {
    return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  }
  return false;
}

export function redirectUriMatches(registeredList: string[], candidate: string): boolean {
  if (!isValidRedirectUri(candidate)) return false;
  if (registeredList.includes(candidate)) return true;

  // RFC 8252 §7.3: loopback redirect URIs may vary port dynamically when
  // scheme, loopback host, pathname, and search match.
  let candUrl: URL;
  try {
    candUrl = new URL(candidate);
  } catch {
    return false;
  }
  if (candUrl.protocol !== 'http:' || !LOOPBACK_HOSTS.has(candUrl.hostname.toLowerCase())) {
    return false;
  }
  for (const reg of registeredList) {
    let regUrl: URL;
    try {
      regUrl = new URL(reg);
    } catch {
      continue;
    }
    if (
      regUrl.protocol === 'http:' &&
      regUrl.hostname.toLowerCase() === candUrl.hostname.toLowerCase() &&
      regUrl.pathname === candUrl.pathname &&
      regUrl.search === candUrl.search
    ) {
      return true;
    }
  }
  return false;
}

function normalizeResourceUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.hash || parsed.search || parsed.username || parsed.password) return null;
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${cleanPath}`;
  } catch {
    return null;
  }
}

export function validateResourceIndicator(
  rawResource: string | null | undefined,
  baseUrl?: string,
  defaultPath: '/mcp' | '/api/mcp' = '/mcp',
): string | null {
  const origin = normalizeOrigin(baseUrl);
  if (!rawResource) {
    return `${origin}${defaultPath}`;
  }
  const normalized = normalizeResourceUrl(rawResource.trim());
  if (!normalized) return null;
  const allowed = new Set([origin, `${origin}/mcp`, `${origin}/api/mcp`]);
  return allowed.has(normalized) ? normalized : null;
}

export function isTokenAudienceValid(
  tokenResource: string,
  requestResourcePath: '/mcp' | '/api/mcp',
  baseUrl?: string,
): boolean {
  const origin = normalizeOrigin(baseUrl);
  const normalized = normalizeResourceUrl(tokenResource);
  if (!normalized) return false;
  return normalized === origin || normalized === `${origin}${requestResourcePath}`;
}

export function normalizeRequestedScopes(rawScope: string | null | undefined, allowedScope = MCP_OAUTH_DEFAULT_SCOPE): string | null {
  const allowed = new Set(allowedScope.split(/\s+/).filter(Boolean));
  if (!rawScope || !rawScope.trim()) {
    return [...allowed].join(' ') || MCP_OAUTH_DEFAULT_SCOPE;
  }
  const requested = [...new Set(rawScope.trim().split(/\s+/).filter(Boolean))];
  if (requested.length === 0) return MCP_OAUTH_DEFAULT_SCOPE;
  for (const s of requested) {
    if (!allowed.has(s)) return null;
  }
  return requested.join(' ');
}

export function isValidPkceChallenge(challenge: unknown): challenge is string {
  return typeof challenge === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(challenge);
}

export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) return false;
  if (!isValidPkceChallenge(codeChallenge)) return false;
  const computed = createHash('sha256').update(codeVerifier).digest('base64url');
  return timingSafeEqualStrings(computed, codeChallenge);
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function parseIpv6Groups(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  const zoneIdx = addr.indexOf('%');
  if (zoneIdx !== -1) addr = addr.slice(0, zoneIdx);

  // Convert trailing dotted-quad IPv4 (e.g. ::ffff:127.0.0.1) into two 16-bit hex groups
  const lastColon = addr.lastIndexOf(':');
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes('.')) {
    const v4Part = addr.slice(lastColon + 1);
    const octets = v4Part.split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const parsePart = (part: string): number[] | null => {
    if (!part) return [];
    const tokens = part.split(':');
    const out: number[] = [];
    for (const token of tokens) {
      if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
      out.push(parseInt(token, 16));
    }
    return out;
  };

  if (halves.length === 1) {
    const groups = parsePart(halves[0]);
    return groups && groups.length === 8 ? groups : null;
  }

  const left = parsePart(halves[0]);
  const right = parsePart(halves[1]);
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function groupsToIpv4(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

export function isPrivateIpAddress(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const kind = net.isIP(clean);
  if (kind === 4) return isPrivateIpv4(clean);
  if (kind === 6) {
    const g = parseIpv6Groups(clean);
    if (!g) return true;
    const isAllZeroPrefix5 = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
    // :: (unspecified) and ::1 (loopback)
    if (isAllZeroPrefix5 && g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true;
    // ::ffff:0:0/96 (IPv4-mapped IPv6 in dotted or hex form)
    if (isAllZeroPrefix5 && g[5] === 0xffff) {
      return isPrivateIpv4(groupsToIpv4(g[6], g[7]));
    }
    // ::ffff:0:0:0/96 (IPv4-translated)
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0) {
      return isPrivateIpv4(groupsToIpv4(g[6], g[7]));
    }
    // ::/96 (deprecated IPv4-compatible IPv6)
    if (isAllZeroPrefix5 && g[5] === 0) {
      return isPrivateIpv4(groupsToIpv4(g[6], g[7]));
    }
    // 64:ff9b::/96 & 64:ff9b:1::/48 (NAT64)
    if (g[0] === 0x0064 && g[1] === 0xff9b) {
      if (g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
        return isPrivateIpv4(groupsToIpv4(g[6], g[7]));
      }
      if (g[2] === 1) return true;
    }
    // 2002::/16 (6to4 embeds IPv4 in groups 1..2)
    if (g[0] === 0x2002) {
      return isPrivateIpv4(groupsToIpv4(g[1], g[2]));
    }
    // 2001::/32 (Teredo), 2001:db8::/32 (documentation), 100::/64 (discard)
    if (g[0] === 0x2001 && (g[1] === 0x0000 || g[1] === 0x0db8)) return true;
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;
    // fc00::/7 (ULA)
    if ((g[0] & 0xfe00) === 0xfc00) return true;
    // fe80::/10 (link-local) and fec0::/10 (deprecated site-local)
    if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true;
    // ff00::/8 (multicast)
    if ((g[0] & 0xff00) === 0xff00) return true;
    return false;
  }
  return true;
}

export function isCimdClientId(clientId: string): boolean {
  if (!clientId || clientId.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(clientId);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.hash || parsed.username || parsed.password) return false;
  if (!parsed.pathname || parsed.pathname === '/') return false;
  if (parsed.pathname.split('/').some((seg) => seg === '.' || seg === '..')) return false;
  const host = parsed.hostname.toLowerCase();
  if (!host || LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) {
    return !isPrivateIpAddress(host);
  }
  return true;
}

export type CimdFetchFn = (url: string, init: RequestInit) => Promise<Response>;

async function readResponseBytesBounded(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const contentLengthHeader = res.headers.get('content-length');
  if (contentLengthHeader) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
  }
  if (!res.body) {
    return new Uint8Array(0);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

async function fetchCimdPinnedHttps(
  parsed: URL,
  lookupFn: (hostname: string) => Promise<Array<{ address: string; family?: number }>>,
  signal: AbortSignal,
): Promise<{ status: number; contentType: string; bytes: Uint8Array } | null> {
  const rawHost = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(rawHost) && isPrivateIpAddress(rawHost)) {
    return null;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (val: { status: number; contentType: string; bytes: Uint8Array } | null) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    const pinnedLookup = (
      hostname: string,
      options: unknown,
      callback: (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void,
    ) => {
      const cb = typeof options === 'function' ? (options as typeof callback) : callback;
      const opts = typeof options === 'object' && options !== null ? (options as { all?: boolean }) : {};
      void lookupFn(hostname)
        .then((entries) => {
          if (!entries.length || entries.some((entry) => isPrivateIpAddress(entry.address))) {
            cb(Object.assign(new Error('Blocked private or invalid CIMD IP address'), { code: 'ERR_SSRF_BLOCKED' }), '');
            return;
          }
          const normalized = entries.map((entry) => {
            const family = entry.family === 4 || entry.family === 6 ? entry.family : net.isIP(entry.address);
            return { address: entry.address, family: family === 6 ? 6 : 4 };
          });
          if (opts.all) {
            cb(null, normalized);
          } else {
            cb(null, normalized[0].address, normalized[0].family);
          }
        })
        .catch((err) => cb(err as NodeJS.ErrnoException, ''));
    };

    const req = https.request(
      {
        protocol: 'https:',
        hostname: rawHost,
        port: parsed.port ? Number(parsed.port) : 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'identity',
          'User-Agent': 'jean-ci-mcp-oauth/1.0',
          Host: parsed.host,
        },
        servername: net.isIP(rawHost) ? undefined : rawHost,
        lookup: pinnedLookup as unknown as typeof import('node:dns').lookup,
        signal,
      },
      (res) => {
        const status = res.statusCode || 0;
        const contentType = String(res.headers['content-type'] || '').toLowerCase();
        const contentLength = Number(res.headers['content-length']);
        if (
          status < 200 ||
          status >= 300 ||
          (!contentType.includes('application/json') && !contentType.includes('+json')) ||
          (Number.isFinite(contentLength) && contentLength > MAX_CIMD_BYTES)
        ) {
          res.resume();
          req.destroy();
          finish(null);
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          total += chunk.length;
          if (total > MAX_CIMD_BYTES) {
            res.destroy();
            req.destroy();
            finish(null);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (!res.complete) {
            finish(null);
            return;
          }
          finish({ status, contentType, bytes: new Uint8Array(Buffer.concat(chunks, total)) });
        });
        res.on('close', () => {
          if (!settled) finish(null);
        });
        res.on('error', () => finish(null));
      },
    );

    req.on('error', () => finish(null));
    req.end();
  });
}

export async function fetchCimdClient(
  clientId: string,
  fetchFn?: CimdFetchFn,
  lookupFn: (hostname: string) => Promise<Array<{ address: string; family?: number }>> = (h) =>
    dns.lookup(h, { all: true }),
): Promise<McpOAuthClient | null> {
  if (!isCimdClientId(clientId)) return null;
  const parsed = new URL(clientId);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateIpAddress(host)) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CIMD_TIMEOUT_MS);
  try {
    let contentType: string;
    let rawBytes: Uint8Array | null;

    if (fetchFn) {
      // Custom fetch injection (used in unit tests): validate DNS first and enforce streaming byte cap
      if (!net.isIP(host)) {
        const addresses = await lookupFn(host);
        if (!addresses.length || addresses.some((entry) => isPrivateIpAddress(entry.address))) {
          return null;
        }
      }
      const res = await fetchFn(clientId, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!res.ok) return null;
      contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('application/json') && !contentType.includes('+json')) return null;
      rawBytes = await readResponseBytesBounded(res, MAX_CIMD_BYTES);
    } else {
      // Production path: pin the TCP connection directly to the DNS-validated IP while preserving TLS SNI
      const pinned = await fetchCimdPinnedHttps(parsed, lookupFn, controller.signal);
      if (!pinned) return null;
      contentType = pinned.contentType;
      if (!contentType.includes('application/json') && !contentType.includes('+json')) return null;
      rawBytes = pinned.bytes;
    }

    if (!rawBytes) return null;

    const doc = JSON.parse(new TextDecoder().decode(rawBytes)) as Record<string, unknown>;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
    if (doc.client_id !== clientId) return null;

    const rawRedirectUris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris : [];
    if (rawRedirectUris.length === 0 || rawRedirectUris.length > MAX_REDIRECT_URIS) {
      return null;
    }
    const redirectUris = rawRedirectUris.filter(isValidRedirectUri);
    if (redirectUris.length === 0) {
      return null;
    }
    const authMethod = typeof doc.token_endpoint_auth_method === 'string' ? doc.token_endpoint_auth_method : 'none';
    if (authMethod !== 'none') {
      // CIMD clients must not rely on shared symmetric secrets
      return null;
    }
    const clientName =
      typeof doc.client_name === 'string' && doc.client_name.trim()
        ? doc.client_name.trim().slice(0, 120)
        : parsed.hostname;
    const grantTypes = Array.isArray(doc.grant_types)
      ? doc.grant_types.filter((g): g is string => g === 'authorization_code' || g === 'refresh_token')
      : ['authorization_code', 'refresh_token'];
    if (!grantTypes.includes('authorization_code')) return null;

    return {
      clientId,
      clientSecretHash: null,
      clientName,
      redirectUris,
      grantTypes,
      tokenEndpointAuthMethod: 'none',
      scope: MCP_OAUTH_DEFAULT_SCOPE,
      isCimd: true,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveOAuthClient(
  store: McpOAuthStore,
  clientId: string,
  fetchFn?: CimdFetchFn,
  lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>,
): Promise<McpOAuthClient | null> {
  if (!clientId || clientId.length > 2048) return null;
  const existing = await store.getClient(clientId);
  if (existing) return existing;
  if (isCimdClientId(clientId)) {
    return fetchCimdClient(clientId, fetchFn, lookupFn);
  }
  return null;
}

export interface DcrResult {
  status: number;
  body: Record<string, unknown>;
}

export async function registerOAuthClient(store: McpOAuthStore, payload: unknown): Promise<DcrResult> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      status: 400,
      body: { error: 'invalid_client_metadata', error_description: 'Registration payload must be a JSON object.' },
    };
  }
  const input = payload as Record<string, unknown>;
  const redirectUris = Array.isArray(input.redirect_uris) ? input.redirect_uris : [];
  if (redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
    return {
      status: 400,
      body: {
        error: 'invalid_redirect_uri',
        error_description: `redirect_uris must contain between 1 and ${MAX_REDIRECT_URIS} valid redirect URIs.`,
      },
    };
  }
  for (const uri of redirectUris) {
    if (!isValidRedirectUri(uri)) {
      return {
        status: 400,
        body: {
          error: 'invalid_redirect_uri',
          error_description: `Invalid redirect_uri: ${String(uri)}. Must be https:// or loopback http:// without fragments.`,
        },
      };
    }
  }

  const rawAuthMethod =
    typeof input.token_endpoint_auth_method === 'string' ? input.token_endpoint_auth_method : 'none';
  if (
    rawAuthMethod !== 'none' &&
    rawAuthMethod !== 'client_secret_post' &&
    rawAuthMethod !== 'client_secret_basic'
  ) {
    return {
      status: 400,
      body: {
        error: 'invalid_client_metadata',
        error_description: `Unsupported token_endpoint_auth_method: ${rawAuthMethod}`,
      },
    };
  }

  const rawGrantTypes = Array.isArray(input.grant_types)
    ? input.grant_types.map(String)
    : ['authorization_code', 'refresh_token'];
  const allowedGrants = new Set(['authorization_code', 'refresh_token']);
  if (rawGrantTypes.length === 0 || rawGrantTypes.some((g) => !allowedGrants.has(g)) || !rawGrantTypes.includes('authorization_code')) {
    return {
      status: 400,
      body: {
        error: 'invalid_client_metadata',
        error_description: 'grant_types must include authorization_code and only supported grants.',
      },
    };
  }

  const rawResponseTypes = Array.isArray(input.response_types) ? input.response_types.map(String) : ['code'];
  if (rawResponseTypes.length !== 1 || rawResponseTypes[0] !== 'code') {
    return {
      status: 400,
      body: {
        error: 'invalid_client_metadata',
        error_description: 'response_types must be ["code"].',
      },
    };
  }

  const rawScope = typeof input.scope === 'string' ? input.scope : undefined;
  const scope = normalizeRequestedScopes(rawScope);
  if (!scope) {
    return {
      status: 400,
      body: {
        error: 'invalid_client_metadata',
        error_description: `Unsupported scope. Allowed scopes: ${MCP_OAUTH_DEFAULT_SCOPE}`,
      },
    };
  }

  const clientName =
    typeof input.client_name === 'string' && input.client_name.trim()
      ? input.client_name.trim().slice(0, 120)
      : 'MCP Client';

  const clientId = `jci_client_${randomBytes(16).toString('hex')}`;
  const isConfidential = rawAuthMethod !== 'none';
  const clientSecret = isConfidential ? `jci_secret_${randomBytes(24).toString('hex')}` : null;
  const clientSecretHash = clientSecret ? hashOAuthSecret(clientSecret) : null;

  await store.createClient({
    clientId,
    clientSecretHash,
    clientName,
    redirectUris: [...new Set(redirectUris as string[])],
    grantTypes: [...new Set(rawGrantTypes)],
    tokenEndpointAuthMethod: rawAuthMethod,
    scope,
  });

  const issuedAt = Math.floor(Date.now() / 1000);
  const responseBody: Record<string, unknown> = {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_name: clientName,
    redirect_uris: [...new Set(redirectUris as string[])],
    grant_types: [...new Set(rawGrantTypes)],
    response_types: ['code'],
    token_endpoint_auth_method: rawAuthMethod,
    scope,
  };
  if (clientSecret) {
    responseBody.client_secret = clientSecret;
    responseBody.client_secret_expires_at = 0;
  }

  return { status: 201, body: responseBody };
}

export function buildOAuthErrorRedirect(
  redirectUri: string,
  error: string,
  errorDescription: string,
  state?: string | null,
): string {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', errorDescription);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

export type PendingAuthResult =
  | { ok: true; pending: McpOAuthPending }
  | { ok: false; status: number; error: string; errorDescription: string; redirectErrorUrl?: string };

export async function createPendingAuthorization(
  store: McpOAuthStore,
  searchParams: URLSearchParams,
  baseUrl?: string,
  fetchFn?: CimdFetchFn,
  lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>,
): Promise<PendingAuthResult> {
  const clientId = (searchParams.get('client_id') || '').trim();
  const redirectUri = (searchParams.get('redirect_uri') || '').trim();
  const responseType = (searchParams.get('response_type') || '').trim();
  const codeChallenge = (searchParams.get('code_challenge') || '').trim();
  const codeChallengeMethod = (searchParams.get('code_challenge_method') || '').trim();
  const state = searchParams.get('state');
  const rawScope = searchParams.get('scope');
  const rawResource = searchParams.get('resource');

  // Step 1: Validate client_id and redirect_uri FIRST. Never redirect to an unverified redirect_uri.
  if (!clientId) {
    return { ok: false, status: 400, error: 'invalid_request', errorDescription: 'Missing client_id.' };
  }
  const client = await resolveOAuthClient(store, clientId, fetchFn, lookupFn);
  if (!client) {
    return { ok: false, status: 400, error: 'invalid_client', errorDescription: 'Unknown or invalid client_id.' };
  }
  if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri)) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_redirect_uri',
      errorDescription: 'redirect_uri is missing or does not match any registered redirect URI for this client.',
    };
  }
  if (state !== null && state.length > MAX_OAUTH_STATE_LEN) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_request',
      errorDescription: `state parameter exceeds maximum length of ${MAX_OAUTH_STATE_LEN} characters.`,
    };
  }

  // From here on, client_id and redirect_uri are verified — protocol errors redirect back to client.
  const fail = (error: string, errorDescription: string): PendingAuthResult => ({
    ok: false,
    status: 302,
    error,
    errorDescription,
    redirectErrorUrl: buildOAuthErrorRedirect(redirectUri, error, errorDescription, state),
  });

  if (responseType !== 'code') {
    return fail('unsupported_response_type', 'Only response_type=code is supported.');
  }
  if (!codeChallenge || !isValidPkceChallenge(codeChallenge)) {
    return fail('invalid_request', 'Valid PKCE code_challenge is required (OAuth 2.1).');
  }
  if (codeChallengeMethod !== 'S256') {
    return fail('invalid_request', 'PKCE code_challenge_method must be S256.');
  }

  const resource = validateResourceIndicator(rawResource, baseUrl, '/mcp');
  if (!resource) {
    return fail('invalid_target', 'Invalid or unsupported RFC 8707 resource indicator.');
  }

  const scope = normalizeRequestedScopes(rawScope, client.scope);
  if (!scope) {
    return fail('invalid_scope', `Requested scope is not allowed. Supported scopes: ${client.scope}`);
  }

  const pending: McpOAuthPending = {
    requestId: randomBytes(16).toString('hex'),
    clientId: client.clientId,
    clientName: client.clientName,
    redirectUri,
    scope,
    state: state || null,
    codeChallenge,
    codeChallengeMethod: 'S256',
    resource,
    csrfToken: randomBytes(24).toString('hex'),
    expiresAt: new Date(Date.now() + PENDING_AUTH_TTL_SEC * 1000),
  };

  await store.createPending(pending);
  return { ok: true, pending };
}

export async function approvePendingAuthorization(
  store: McpOAuthStore,
  pending: McpOAuthPending,
  user: { id: string; login: string },
): Promise<{ redirectUrl: string; code: string }> {
  const rawCode = randomBytes(32).toString('base64url');
  const codeHash = hashOAuthSecret(rawCode);
  await store.createCode({
    codeHash,
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    resource: pending.resource,
    scope: pending.scope,
    userId: String(user.id),
    userLogin: user.login,
    usedAt: null,
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_SEC * 1000),
  });

  const redirect = new URL(pending.redirectUri);
  redirect.searchParams.set('code', rawCode);
  if (pending.state) {
    redirect.searchParams.set('state', pending.state);
  }
  return { redirectUrl: redirect.toString(), code: rawCode };
}

function parseClientCredentials(
  formParams: URLSearchParams,
  authHeader: string | null,
): { clientId: string | null; clientSecret: string | null; method: 'basic' | 'post' | 'none' } {
  if (authHeader && authHeader.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx > 0) {
        return {
          clientId: decodeURIComponent(decoded.slice(0, idx)),
          clientSecret: decodeURIComponent(decoded.slice(idx + 1)),
          method: 'basic',
        };
      }
    } catch {
      return { clientId: null, clientSecret: null, method: 'basic' };
    }
  }
  const postId = formParams.get('client_id')?.trim() || null;
  const postSecret = formParams.get('client_secret') || null;
  if (postSecret) {
    return { clientId: postId, clientSecret: postSecret, method: 'post' };
  }
  return { clientId: postId, clientSecret: null, method: 'none' };
}

async function authenticateOAuthClient(
  store: McpOAuthStore,
  formParams: URLSearchParams,
  authHeader: string | null,
  fetchFn?: CimdFetchFn,
  lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>,
): Promise<{ ok: true; client: McpOAuthClient } | { ok: false; status: number; error: string; errorDescription: string }> {
  const creds = parseClientCredentials(formParams, authHeader);
  if (!creds.clientId) {
    return { ok: false, status: 401, error: 'invalid_client', errorDescription: 'Missing client_id.' };
  }
  const client = await resolveOAuthClient(store, creds.clientId, fetchFn, lookupFn);
  if (!client) {
    return { ok: false, status: 401, error: 'invalid_client', errorDescription: 'Unknown OAuth client.' };
  }
  if (client.tokenEndpointAuthMethod === 'none') {
    return { ok: true, client };
  }
  if (!creds.clientSecret || !client.clientSecretHash) {
    return { ok: false, status: 401, error: 'invalid_client', errorDescription: 'Client authentication required.' };
  }
  if (
    (client.tokenEndpointAuthMethod === 'client_secret_basic' && creds.method !== 'basic') ||
    (client.tokenEndpointAuthMethod === 'client_secret_post' && creds.method !== 'post')
  ) {
    return {
      ok: false,
      status: 401,
      error: 'invalid_client',
      errorDescription: `Client must authenticate using ${client.tokenEndpointAuthMethod}.`,
    };
  }
  const presentedHash = hashOAuthSecret(creds.clientSecret);
  if (!timingSafeEqualStrings(presentedHash, client.clientSecretHash)) {
    return { ok: false, status: 401, error: 'invalid_client', errorDescription: 'Invalid client credentials.' };
  }
  return { ok: true, client };
}

export interface TokenEndpointResult {
  status: number;
  body: Record<string, unknown>;
}

export async function exchangeOAuthToken(
  store: McpOAuthStore,
  formParams: URLSearchParams,
  authHeader: string | null,
  baseUrl?: string,
  fetchFn?: CimdFetchFn,
  lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>,
): Promise<TokenEndpointResult> {
  const grantType = (formParams.get('grant_type') || '').trim();
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
    return {
      status: 400,
      body: { error: 'unsupported_grant_type', error_description: 'Supported grant types: authorization_code, refresh_token.' },
    };
  }

  const clientAuth = await authenticateOAuthClient(store, formParams, authHeader, fetchFn, lookupFn);
  if (!clientAuth.ok) {
    return {
      status: clientAuth.status,
      body: { error: clientAuth.error, error_description: clientAuth.errorDescription },
    };
  }
  const { client } = clientAuth;

  if (grantType === 'authorization_code') {
    const rawCode = (formParams.get('code') || '').trim();
    const redirectUri = (formParams.get('redirect_uri') || '').trim();
    const codeVerifier = (formParams.get('code_verifier') || '').trim();
    const rawResource = formParams.get('resource');

    if (!rawCode || !redirectUri || !codeVerifier) {
      return {
        status: 400,
        body: {
          error: 'invalid_request',
          error_description: 'code, redirect_uri, and code_verifier are required.',
        },
      };
    }

    const codeHash = hashOAuthSecret(rawCode);
    const existing = await store.getCode(codeHash);
    if (!existing) {
      return { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid authorization code.' } };
    }
    if (existing.clientId !== client.clientId) {
      return { status: 400, body: { error: 'invalid_grant', error_description: 'Authorization code was issued to another client.' } };
    }
    if (existing.redirectUri !== redirectUri) {
      return { status: 400, body: { error: 'invalid_grant', error_description: 'redirect_uri mismatch.' } };
    }
    if (existing.usedAt) {
      // OAuth 2.1 replay protection: revoke all tokens previously issued from this code
      await store.revokeTokensByCode(codeHash);
      return {
        status: 400,
        body: { error: 'invalid_grant', error_description: 'Authorization code was already used.' },
      };
    }
    if (existing.expiresAt.getTime() <= Date.now()) {
      return { status: 400, body: { error: 'invalid_grant', error_description: 'Authorization code expired.' } };
    }
    if (!verifyPkceS256(codeVerifier, existing.codeChallenge)) {
      return { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid PKCE code_verifier.' } };
    }

    let finalResource = existing.resource;
    if (rawResource) {
      const requestedResource = validateResourceIndicator(rawResource, baseUrl, '/mcp');
      if (!requestedResource || requestedResource !== existing.resource) {
        return {
          status: 400,
          body: { error: 'invalid_target', error_description: 'Token resource does not match authorized resource.' },
        };
      }
      finalResource = requestedResource;
    }

    const familyId = randomUUID();
    const accessToken = `${MCP_OAUTH_ACCESS_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const refreshToken = `${MCP_OAUTH_REFRESH_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

    const exchangeResult = await store.exchangeCodeAtomic({
      codeHash,
      accessToken: {
        tokenHash: hashOAuthSecret(accessToken),
        familyId,
        clientId: client.clientId,
        resource: finalResource,
        scope: existing.scope,
        userId: existing.userId,
        userLogin: existing.userLogin,
        expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SEC * 1000),
      },
      refreshToken: {
        tokenHash: hashOAuthSecret(refreshToken),
        familyId,
        clientId: client.clientId,
        resource: finalResource,
        scope: existing.scope,
        userId: existing.userId,
        userLogin: existing.userLogin,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000),
      },
    });
    if (exchangeResult.status !== 'issued') {
      return {
        status: 400,
        body: {
          error: 'invalid_grant',
          error_description:
            exchangeResult.status === 'expired'
              ? 'Authorization code expired.'
              : 'Authorization code was already used.',
        },
      };
    }

    return {
      status: 200,
      body: {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SEC,
        refresh_token: refreshToken,
        scope: existing.scope,
      },
    };
  }

  // grant_type === 'refresh_token'
  const rawRefresh = (formParams.get('refresh_token') || '').trim();
  if (!rawRefresh) {
    return { status: 400, body: { error: 'invalid_request', error_description: 'refresh_token is required.' } };
  }
  const refreshHash = hashOAuthSecret(rawRefresh);
  const tokenRow = await store.getToken(refreshHash);
  if (!tokenRow || tokenRow.tokenType !== 'refresh') {
    return { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid refresh token.' } };
  }
  if (tokenRow.clientId !== client.clientId) {
    return { status: 400, body: { error: 'invalid_grant', error_description: 'Refresh token belongs to another client.' } };
  }

  const rawResource = formParams.get('resource');
  if (rawResource) {
    const requestedResource = validateResourceIndicator(rawResource, baseUrl, '/mcp');
    if (!requestedResource || requestedResource !== tokenRow.resource) {
      return {
        status: 400,
        body: { error: 'invalid_target', error_description: 'Requested resource does not match grant resource.' },
      };
    }
  }

  const requestedScope = normalizeRequestedScopes(formParams.get('scope'), tokenRow.scope);
  if (!requestedScope) {
    return { status: 400, body: { error: 'invalid_scope', error_description: 'Cannot expand scope on refresh.' } };
  }

  const nextAccess = `${MCP_OAUTH_ACCESS_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const nextRefresh = `${MCP_OAUTH_REFRESH_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

  const rotationResult = await store.rotateRefreshTokenAtomic({
    refreshTokenHash: refreshHash,
    familyId: tokenRow.familyId,
    accessToken: {
      tokenHash: hashOAuthSecret(nextAccess),
      sourceCodeHash: tokenRow.sourceCodeHash,
      clientId: client.clientId,
      resource: tokenRow.resource,
      scope: requestedScope,
      userId: tokenRow.userId,
      userLogin: tokenRow.userLogin,
      expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SEC * 1000),
    },
    nextRefreshToken: {
      tokenHash: hashOAuthSecret(nextRefresh),
      sourceCodeHash: tokenRow.sourceCodeHash,
      clientId: client.clientId,
      resource: tokenRow.resource,
      scope: requestedScope,
      userId: tokenRow.userId,
      userLogin: tokenRow.userLogin,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000),
    },
  });
  if (rotationResult.status !== 'rotated') {
    return {
      status: 400,
      body: {
        error: 'invalid_grant',
        error_description:
          rotationResult.status === 'expired'
            ? 'Refresh token expired.'
            : 'Refresh token was revoked or already used.',
      },
    };
  }

  return {
    status: 200,
    body: {
      access_token: nextAccess,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SEC,
      refresh_token: nextRefresh,
      scope: requestedScope,
    },
  };
}

export async function revokeOAuthToken(
  store: McpOAuthStore,
  formParams: URLSearchParams,
  authHeader: string | null,
  fetchFn?: CimdFetchFn,
  lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = (formParams.get('token') || '').trim();
  if (!token) {
    return { status: 200, body: {} };
  }
  const tokenHash = hashOAuthSecret(token);
  const existing = await store.getToken(tokenHash);
  if (!existing) {
    return { status: 200, body: {} };
  }

  // If client credentials were presented, verify ownership before revoking.
  const creds = parseClientCredentials(formParams, authHeader);
  if (creds.clientId) {
    const auth = await authenticateOAuthClient(store, formParams, authHeader, fetchFn, lookupFn);
    if (!auth.ok) {
      return { status: auth.status, body: { error: auth.error, error_description: auth.errorDescription } };
    }
    if (auth.client.clientId !== existing.clientId) {
      return { status: 200, body: {} };
    }
  }

  if (existing.tokenType === 'refresh') {
    await store.revokeTokensByFamily(existing.familyId);
  } else {
    await store.revokeToken(tokenHash);
  }
  return { status: 200, body: {} };
}

export async function authenticateMcpOAuthToken(
  store: McpOAuthStore,
  token: string,
  resourcePath: '/mcp' | '/api/mcp',
  baseUrl?: string,
): Promise<
  | { authorized: true; authInfo: AuthInfo }
  | { authorized: false; error: 'invalid_token'; errorDescription: string }
> {
  const tokenHash = hashOAuthSecret(token);
  const record = await store.getToken(tokenHash);
  if (!record || record.tokenType !== 'access') {
    return { authorized: false, error: 'invalid_token', errorDescription: 'Unknown OAuth access token.' };
  }
  if (record.revokedAt) {
    return { authorized: false, error: 'invalid_token', errorDescription: 'OAuth access token was revoked.' };
  }
  if (record.expiresAt.getTime() <= Date.now()) {
    return { authorized: false, error: 'invalid_token', errorDescription: 'OAuth access token expired.' };
  }
  if (!isTokenAudienceValid(record.resource, resourcePath, baseUrl)) {
    return { authorized: false, error: 'invalid_token', errorDescription: 'OAuth token audience mismatch.' };
  }

  const scopes = record.scope.split(/\s+/).filter(Boolean);
  const ownerId = `oauth:${record.userId}:${hashOAuthSecret(record.clientId).slice(0, 16)}`;
  return {
    authorized: true,
    authInfo: {
      token: 'redacted',
      clientId: ownerId,
      scopes,
      expiresAt: Math.floor(record.expiresAt.getTime() / 1000),
      extra: {
        source: 'oauth',
        actor: `github:${record.userLogin}`,
        userId: record.userId,
        oauthClientId: record.clientId,
        resource: record.resource,
      },
    },
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function computeConsentCsrfToken(
  sessionCsrfSecret: string,
  requestId: string,
  pendingCsrfToken: string,
): string {
  return createHmac('sha256', sessionCsrfSecret)
    .update(`${requestId}:${pendingCsrfToken}`)
    .digest('hex');
}

export function isSameOriginConsentSubmission(req: Request, baseUrl?: string): boolean {
  const expectedOrigin = normalizeOrigin(baseUrl);
  const origin = req.headers.get('origin');
  if (origin) {
    if (origin !== expectedOrigin) return false;
  }
  const fetchSite = req.headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin') {
    return false;
  }
  return true;
}

export function renderConsentPageHtml(
  pending: McpOAuthPending,
  user: { id: string; login: string },
  csrfToken: string = pending.csrfToken,
): string {
  const scopes = pending.scope.split(/\s+/).filter(Boolean);
  let redirectOrigin = pending.redirectUri;
  try {
    redirectOrigin = new URL(pending.redirectUri).origin;
  } catch {
    // Keep verbatim
  }
  const scopeList = scopes
    .map((s) =>
      s === 'mcp:write'
        ? '<li><code>mcp:write</code> — Retrigger PR reviews, run local diff reviews, and record local manual overrides.</li>'
        : '<li><code>mcp:read</code> — Inspect open PRs, PR review checks, findings, CI pipelines, deployments, and stats.</li>',
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authorize MCP Client — Jean CI</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 24px;
    }
    .card {
      width: 100%; max-width: 520px; background: #161b22; border: 1px solid #30363d;
      border-radius: 12px; padding: 28px; box-shadow: 0 12px 32px rgba(0,0,0,0.45);
    }
    h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
    .sub { color: #8b949e; font-size: 14px; margin: 0 0 20px; line-height: 1.5; }
    .meta {
      background: #0d1117; border: 1px solid #21262d; border-radius: 8px; padding: 14px;
      margin-bottom: 18px; font-size: 13px; line-height: 1.6;
    }
    .meta dt { color: #8b949e; font-weight: 500; }
    .meta dd { margin: 0 0 8px; word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .meta dd:last-child { margin-bottom: 0; }
    ul { margin: 0 0 18px; padding-left: 20px; font-size: 13px; line-height: 1.6; color: #c9d1d9; }
    .notice {
      background: rgba(56, 139, 253, 0.1); border: 1px solid rgba(56, 139, 253, 0.35);
      border-radius: 8px; padding: 12px; font-size: 12px; color: #9ecbff; margin-bottom: 20px; line-height: 1.5;
    }
    .actions { display: flex; gap: 12px; }
    button {
      flex: 1; padding: 10px 16px; border-radius: 8px; font-size: 14px; font-weight: 600;
      cursor: pointer; border: 1px solid transparent;
    }
    .approve { background: #238636; color: #ffffff; border-color: #2ea043; }
    .approve:hover { background: #2ea043; }
    .deny { background: #21262d; color: #e6edf3; border-color: #30363d; }
    .deny:hover { background: #30363d; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Authorize ${escapeHtml(pending.clientName)}</h1>
    <p class="sub">Signed in as <strong>@${escapeHtml(user.login)}</strong>. This MCP client is requesting access to your Jean CI server.</p>
    <dl class="meta">
      <dt>Client ID</dt>
      <dd>${escapeHtml(pending.clientId)}</dd>
      <dt>Resource</dt>
      <dd>${escapeHtml(pending.resource)}</dd>
      <dt>Redirect Origin</dt>
      <dd>${escapeHtml(redirectOrigin)}</dd>
    </dl>
    <ul>
      ${scopeList}
    </ul>
    <div class="notice">
      <strong>Security boundary:</strong> Browser-session GitHub administrator controls for Hermes tool approvals (Approve once / Deny at <code>/checks/&lt;id&gt;</code>) are never granted to MCP OAuth tokens.
    </div>
    <form method="POST" action="/oauth/authorize" class="actions">
      <input type="hidden" name="request_id" value="${escapeHtml(pending.requestId)}" />
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}" />
      <button type="submit" name="decision" value="deny" class="deny">Deny</button>
      <button type="submit" name="decision" value="approve" class="approve">Approve</button>
    </form>
  </main>
</body>
</html>`;
}

export function buildConsentHtmlHeaders(_csrfToken?: string): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Frame-Options': 'DENY',
    // Omit form-action 'self' because Chromium/Safari apply form-action to the 302 OAuth callback
    // redirect target (e.g. https://app.mcpjam.com/oauth/callback or http://127.0.0.1:*/callback).
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  };
}
