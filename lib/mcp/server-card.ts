import { createHash } from 'node:crypto';
import { APP_BASE_URL } from '../config.ts';

export const MCP_SERVER_NAME = 'dev.telegraphic/jean-ci';
export const MCP_SERVER_TITLE = 'Jean CI';
export const MCP_SERVER_VERSION = '0.13.0';
export const MCP_SERVER_DESCRIPTION =
  'Inspect, retrigger, override, and run local PR reviews, and query CI pipelines, deployments, tasks, and webhook events in Jean CI.';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'] as const;

export const SERVER_CARD_MEDIA_TYPE = 'application/mcp-server-card+json';
export const AI_CATALOG_MEDIA_TYPE = 'application/ai-catalog+json';

function normalizeBaseUrl(baseUrl?: string): string {
  const candidate = (baseUrl || APP_BASE_URL).trim();
  return candidate.replace(/\/+$/, '');
}

export function buildMcpServerCard(baseUrl?: string) {
  const origin = normalizeBaseUrl(baseUrl);
  const endpointUrl = `${origin}/mcp`;
  return {
    name: MCP_SERVER_NAME,
    title: MCP_SERVER_TITLE,
    description: MCP_SERVER_DESCRIPTION,
    version: MCP_SERVER_VERSION,
    supportedVersions: [...MCP_SUPPORTED_VERSIONS],
    remotes: [
      {
        type: 'streamable-http',
        url: endpointUrl,
        authentication: {
          type: 'oauth2',
          protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource/mcp`,
          authorizationServerMetadata: `${origin}/.well-known/oauth-authorization-server`,
          description:
            'Automatic MCP OAuth 2.1 (PKCE S256, DCR + CIMD, GitHub admin sign-in) or static Jean CI Public API Bearer token.',
        },
      },
    ],
    capabilities: {
      tools: true,
      resources: true,
      prompts: true,
      extensions: [
        'io.modelcontextprotocol/ui',
        'io.modelcontextprotocol/tasks',
        'io.modelcontextprotocol/skills',
        'io.modelcontextprotocol/events',
      ],
    },
    documentationUrl: `${origin}/api/public/openapi.json`,
  };
}

export function buildAiCatalog(baseUrl?: string) {
  const origin = normalizeBaseUrl(baseUrl);
  const host = (() => {
    try {
      return new URL(origin).hostname;
    } catch {
      return 'localhost';
    }
  })();

  return {
    specVersion: '1.0',
    entries: [
      {
        identifier: `urn:air:${host}:mcp:jean-ci`,
        type: SERVER_CARD_MEDIA_TYPE,
        url: `${origin}/api/mcp/server-card`,
      },
    ],
  };
}

export function computeWeakEtag(body: string): string {
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 24);
  return `W/"${hash}"`;
}

export function buildDiscoveryCorsHeaders(contentType: string, etag: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=3600',
    ETag: etag,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type, If-None-Match',
    'Access-Control-Expose-Headers': 'ETag',
    Vary: 'Accept',
  };
}

export function isIfNoneMatchHit(request: Request, etag: string): boolean {
  const header = request.headers.get('if-none-match');
  if (!header) return false;
  return header
    .split(',')
    .map((part) => part.trim())
    .some((candidate) => candidate === '*' || candidate === etag || candidate === etag.replace(/^W\//, ''));
}

export function buildDiscoveryJsonResponse(
  request: Request,
  payload: unknown,
  preferredMediaType: string,
): Response {
  const body = JSON.stringify(payload, null, 2);
  const etag = computeWeakEtag(body);
  const accept = (request.headers.get('accept') || '').toLowerCase();
  const contentType =
    accept.includes('application/json') && !accept.includes(preferredMediaType.toLowerCase()) && !accept.includes('*/*')
      ? 'application/json; charset=utf-8'
      : `${preferredMediaType}; charset=utf-8`;

  const headers = buildDiscoveryCorsHeaders(contentType, etag);
  if (isIfNoneMatchHit(request, etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status: 200, headers });
}
