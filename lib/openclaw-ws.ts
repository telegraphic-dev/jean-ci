/**
 * OpenClaw Gateway WebSocket Client
 *
 * Proper challenge-based device-auth WebSocket client for OpenClaw Gateway RPC.
 * Enable with OPENCLAW_USE_WEBSOCKET=true
 */

import { createRequire } from 'node:module';
import crypto, { randomUUID } from 'crypto';
import { getJsonState, setJsonState } from './db.ts';

process.env.WS_NO_BUFFER_UTIL ??= '1';
process.env.WS_NO_UTF_8_VALIDATE ??= '1';

const require = createRequire(import.meta.url);

const PROTOCOL_VERSION = 3;
const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_CHALLENGE_TIMEOUT_MS = 3_000;
const ROLE = 'operator';
const SCOPES = ['operator.read', 'operator.write'] as const;
const DEVICE_TOKEN_STORE_VERSION = 1;
const GATEWAY_CLIENT_ID = 'gateway-client';
const GATEWAY_CLIENT_MODE = 'backend';

type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

type StoredDeviceTokenRecord = {
  token: string;
  role: string;
  scopes: string[];
  updatedAtMs: number;
};

type StoredDeviceTokenStore = {
  version: number;
  deviceId: string;
  tokens: Record<string, StoredDeviceTokenRecord>;
};

export interface SessionDeleteResult {
  ok: boolean;
  key: string;
  deleted: boolean;
  archived: string[];
}

type RpcRequest = {
  type: 'req';
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

type RpcResponse = {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code?: number | string; message?: string; details?: Record<string, unknown> };
};

type GatewayEvent = {
  type: 'event';
  event: string;
  payload?: Record<string, unknown>;
  seq?: number;
};

type HelloOk = {
  auth?: {
    deviceToken?: string;
    role?: string;
    scopes?: string[];
  };
};

type GatewayMessage = RpcResponse | GatewayEvent | ({ type: 'hello-ok' } & HelloOk);

type GatewayRpcResult<T> = { success: true; result: T } | { success: false; error: string; errorDetails?: Record<string, unknown> };

type ConnectPlan = {
  role: string;
  scopes: string[];
  token?: string;
  deviceToken?: string;
  storedDeviceToken?: string;
  deviceIdentity: DeviceIdentity;
};

export function isWebSocketEnabled(): boolean {
  return process.env.OPENCLAW_USE_WEBSOCKET === 'true';
}

export function getWebSocketUrl(): string | null {
  const url = process.env.OPENCLAW_GATEWAY_URL;
  if (!url) return null;
  if (url.startsWith('https://')) return url.replace('https://', 'wss://');
  if (url.startsWith('http://')) return url.replace('http://', 'ws://');
  if (url.startsWith('ws://') || url.startsWith('wss://')) return url;
  return `ws://${url}`;
}

export async function callGatewayRpc<T>(
  method: string,
  params: Record<string, unknown> = {},
  authOverrides: { role?: string; scopes?: string[] } = {},
): Promise<GatewayRpcResult<T>> {
  return connectAndCallGatewayRpc<T>(method, params, {
    createWebSocket: (url: string) => {
      const WebSocket = getWebSocketCtor();
      return new WebSocket(url);
    },
    loadIdentity: () => loadOrCreateDeviceIdentity(),
    readDeviceTokenStore,
    writeDeviceTokenStore,
    clearStoredDeviceToken,
    now: () => Date.now(),
    randomId: () => randomUUID(),
    signPayload: signDevicePayload,
    publicKeyFromPem: publicKeyRawBase64UrlFromPem,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    challengeTimeoutMs: CONNECT_CHALLENGE_TIMEOUT_MS,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  }, authOverrides);
}

export async function deleteSession(
  sessionKey: string,
  options: {
    deleteTranscript?: boolean;
    emitLifecycleHooks?: boolean;
  } = {},
): Promise<GatewayRpcResult<SessionDeleteResult>> {
  const { deleteTranscript = true, emitLifecycleHooks = false } = options;

  console.log(`[openclaw-ws] Deleting session: ${sessionKey}`);

  const result = await callGatewayRpc<SessionDeleteResult>('sessions.delete', {
    key: sessionKey,
    deleteTranscript,
    emitLifecycleHooks,
  });

  if (result.success) {
    console.log(`[openclaw-ws] Session deleted: ${sessionKey}, archived: ${result.result.archived?.length || 0} files`);
  } else {
    console.error(`[openclaw-ws] Failed to delete session ${sessionKey}: ${result.error}`);
  }

  return result;
}

export async function listSessions(options: {
  limit?: number;
  activeMinutes?: number;
} = {}): Promise<GatewayRpcResult<unknown[]>> {
  return callGatewayRpc<unknown[]>('sessions.list', options);
}

export async function getOpenClawDeviceAuthDebugInfo() {
  const identity = await loadOrCreateDeviceIdentity();
  const storedToken = await readStoredDeviceToken(identity.deviceId, ROLE, readDeviceTokenStore);

  return {
    websocketEnabled: isWebSocketEnabled(),
    gatewayUrl: process.env.OPENCLAW_GATEWAY_URL || null,
    identityPath: 'postgres:jean_ci_openclaw_device_state:identity',
    identityExists: true,
    tokenStorePath: 'postgres:jean_ci_openclaw_device_state:token-store',
    tokenStoreExists: !!storedToken,
    deviceId: identity.deviceId,
    role: ROLE,
    scopes: [...SCOPES],
    hasSharedToken: !!process.env.OPENCLAW_GATEWAY_TOKEN?.trim(),
    hasStoredDeviceToken: !!storedToken?.token,
    storedDeviceTokenUpdatedAtMs: storedToken?.updatedAtMs ?? null,
  };
}

type RuntimeDeps = {
  createWebSocket: (url: string) => WebSocketLike;
  loadIdentity: () => Promise<DeviceIdentity> | DeviceIdentity;
  readDeviceTokenStore: (deviceId: string) => Promise<StoredDeviceTokenStore | null> | StoredDeviceTokenStore | null;
  writeDeviceTokenStore: (store: StoredDeviceTokenStore) => Promise<void> | void;
  clearStoredDeviceToken: (deviceId: string, role: string) => Promise<void> | void;
  now: () => number;
  randomId: () => string;
  signPayload: (privateKeyPem: string, payload: string) => string;
  publicKeyFromPem: (publicKeyPem: string) => string;
  connectTimeoutMs: number;
  challengeTimeoutMs: number;
  requestTimeoutMs: number;
};

type WebSocketLike = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: string, listener: (...args: any[]) => void) => void;
};

type WebSocketCtor = new (url: string) => WebSocketLike;

function getWebSocketCtor(): WebSocketCtor {
  return require('ws');
}

export async function connectAndCallGatewayRpc<T>(
  method: string,
  params: Record<string, unknown>,
  deps: RuntimeDeps,
  authOverrides: { role?: string; scopes?: string[] } = {},
): Promise<GatewayRpcResult<T>> {
  const wsUrl = getWebSocketUrl();
  const sharedToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();

  if (!wsUrl || !sharedToken) {
    return { success: false, error: 'WebSocket URL or token not configured' };
  }

  const selectedRole = authOverrides.role?.trim() || ROLE;
  const selectedScopes = [...new Set((authOverrides.scopes || [...SCOPES]).map((scope) => scope.trim()).filter(Boolean))];
  const identity = await deps.loadIdentity();
  const storedToken = (await readStoredDeviceToken(identity.deviceId, selectedRole, deps.readDeviceTokenStore))?.token;

  const firstPlan: ConnectPlan = {
    role: selectedRole,
    scopes: selectedScopes.length > 0 ? selectedScopes : [...SCOPES],
    token: sharedToken,
    deviceToken: undefined,
    storedDeviceToken: storedToken,
    deviceIdentity: identity,
  };

  logWs('starting rpc call', {
    method,
    wsUrl,
    deviceId: shortDeviceId(identity.deviceId),
    hasSharedToken: !!sharedToken,
    hasStoredDeviceToken: !!storedToken,
  });

  const firstAttempt = await runGatewayRpcAttempt<T>(wsUrl, method, params, deps, firstPlan);
  if (firstAttempt.success) return firstAttempt;

  const firstAttemptDetails = 'errorDetails' in firstAttempt ? firstAttempt.errorDetails : undefined;
  const advice = extractRecoveryAdvice(firstAttemptDetails);
  const code = readConnectErrorDetailCode(firstAttemptDetails);
  const canRetryWithDeviceToken =
    !!storedToken &&
    !firstPlan.deviceToken &&
    (advice.canRetryWithDeviceToken === true ||
      advice.recommendedNextStep === 'retry_with_device_token' ||
      code === 'AUTH_TOKEN_MISMATCH');

  if (canRetryWithDeviceToken) {
    logWs('retrying connect with stored device token', {
      method,
      code,
      recommendedNextStep: advice.recommendedNextStep,
      canRetryWithDeviceToken: advice.canRetryWithDeviceToken,
      deviceId: shortDeviceId(identity.deviceId),
    });

    const retryPlan: ConnectPlan = {
      ...firstPlan,
      deviceToken: storedToken,
    };
    const retry = await runGatewayRpcAttempt<T>(wsUrl, method, params, deps, retryPlan);
    if (retry.success) return retry;

    const retryDetails = 'errorDetails' in retry ? retry.errorDetails : undefined;
    const retryCode = readConnectErrorDetailCode(retryDetails);
    if (retryCode === 'AUTH_DEVICE_TOKEN_MISMATCH') {
      logWs('stored device token rejected; clearing cached token', {
        deviceId: shortDeviceId(identity.deviceId),
        role: ROLE,
      });
      await deps.clearStoredDeviceToken(identity.deviceId, ROLE);
    }
    return { success: false, error: retry.error, errorDetails: retryDetails };
  }

  if (code === 'AUTH_DEVICE_TOKEN_MISMATCH') {
    logWs('device token mismatch without retry path; clearing cached token', {
      deviceId: shortDeviceId(identity.deviceId),
      role: ROLE,
    });
    await deps.clearStoredDeviceToken(identity.deviceId, ROLE);
  }

  return { success: false, error: firstAttempt.error, errorDetails: firstAttemptDetails };
}

type AttemptFailure = {
  success: false;
  error: string;
  errorDetails?: Record<string, unknown>;
};

async function runGatewayRpcAttempt<T>(
  wsUrl: string,
  method: string,
  params: Record<string, unknown>,
  deps: RuntimeDeps,
  plan: ConnectPlan,
): Promise<GatewayRpcResult<T> | AttemptFailure> {
  return new Promise((resolve) => {
    let ws: WebSocketLike | null = null;
    let settled = false;
    let connectTimer: NodeJS.Timeout | null = null;
    let challengeTimer: NodeJS.Timeout | null = null;
    let connectResponseTimer: NodeJS.Timeout | null = null;
    let requestTimer: NodeJS.Timeout | null = null;
    const requestId = deps.randomId();
    let connected = false;

    const cleanup = () => {
      if (connectTimer) clearTimeout(connectTimer);
      if (challengeTimer) clearTimeout(challengeTimer);
      if (connectResponseTimer) clearTimeout(connectResponseTimer);
      if (requestTimer) clearTimeout(requestTimer);
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    };

    const settle = (result: GatewayRpcResult<T> | AttemptFailure) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const acceptConnectAndSendRpc = async (hello?: HelloOk) => {
      connected = true;
      const deviceToken = hello?.auth?.deviceToken;
      logWs('connect accepted', {
        method,
        role: hello?.auth?.role || plan.role,
        scopes: hello?.auth?.scopes || plan.scopes,
        receivedDeviceToken: !!deviceToken,
      });
      if (deviceToken) {
        logWs('persisting returned device token', {
          method,
          deviceId: shortDeviceId(plan.deviceIdentity.deviceId),
          role: hello?.auth?.role || plan.role,
        });
        await writeStoredDeviceToken({
          deviceId: plan.deviceIdentity.deviceId,
          role: hello?.auth?.role || plan.role,
          token: deviceToken,
          scopes: hello?.auth?.scopes || plan.scopes,
          updatedAtMs: deps.now(),
        }, deps.writeDeviceTokenStore, deps.readDeviceTokenStore);
      }

      requestTimer = setTimeout(() => {
        settle({ success: false, error: `Request timeout after ${deps.requestTimeoutMs}ms` });
      }, deps.requestTimeoutMs);

      logWs('sending rpc request', { method, requestId });

      const rpcReq: RpcRequest = {
        type: 'req',
        id: requestId,
        method,
        params,
      };
      ws!.send(JSON.stringify(rpcReq));
    };

    try {
      logWs('opening websocket', { wsUrl, method, deviceId: shortDeviceId(plan.deviceIdentity.deviceId) });
      ws = deps.createWebSocket(wsUrl);

      connectTimer = setTimeout(() => {
        settle({ success: false, error: `Connection timeout after ${deps.connectTimeoutMs}ms` });
      }, deps.connectTimeoutMs);

      ws.on('error', (err: Error) => {
        logWs('websocket error', { method, message: err.message });
        settle({ success: false, error: `WebSocket error: ${err.message}` });
      });

      ws.on('close', (code: number, reason?: Buffer | string) => {
        if (settled) return;
        logWs('websocket closed before request completion', {
          method,
          code,
          reason: reason?.toString() || '',
        });
        settle({ success: false, error: `WebSocket closed: ${code} ${reason?.toString() || ''}`.trim() });
      });

      ws.on('open', () => {
        logWs('websocket opened; waiting for connect challenge', { method });
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }

        challengeTimer = setTimeout(() => {
          settle({ success: false, error: `Connect challenge timeout after ${deps.challengeTimeoutMs}ms` });
        }, deps.challengeTimeoutMs);
      });

      ws.on('message', async (data: Buffer | string) => {
        let msg: GatewayMessage;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }

        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          const nonce = typeof msg.payload?.nonce === 'string' ? msg.payload.nonce.trim() : '';
          if (!nonce) {
            logWs('connect challenge missing nonce', { method });
            settle({ success: false, error: 'Gateway connect challenge missing nonce' });
            return;
          }

          logWs('received connect challenge', {
            method,
            nonceLength: nonce.length,
            retryingWithDeviceToken: !!plan.deviceToken,
          });
          if (challengeTimer) {
            clearTimeout(challengeTimer);
            challengeTimer = null;
          }

          const signedAt = deps.now();
          const payload = buildDeviceSignaturePayload({
            deviceId: plan.deviceIdentity.deviceId,
            clientId: GATEWAY_CLIENT_ID,
            clientMode: GATEWAY_CLIENT_MODE,
            role: plan.role,
            scopes: plan.scopes,
            signedAtMs: signedAt,
            token: plan.token,
            nonce,
          });
          const signature = deps.signPayload(plan.deviceIdentity.privateKeyPem, payload);

          logWs('sending connect request', {
            method,
            role: plan.role,
            scopes: plan.scopes,
            hasSharedToken: !!plan.token,
            hasDeviceToken: !!plan.deviceToken,
            deviceId: shortDeviceId(plan.deviceIdentity.deviceId),
          });

          connectResponseTimer = setTimeout(() => {
            logWs('connect response timeout', { method });
            settle({ success: false, error: `Connect response timeout after ${deps.connectTimeoutMs}ms` });
          }, deps.connectTimeoutMs);

          const connectReq: RpcRequest = {
            type: 'req',
            id: 'connect-1',
            method: 'connect',
            params: {
              minProtocol: PROTOCOL_VERSION,
              maxProtocol: PROTOCOL_VERSION,
              client: {
                id: GATEWAY_CLIENT_ID,
                version: process.env.npm_package_version || '1.0.0',
                platform: 'node',
                mode: GATEWAY_CLIENT_MODE,
              },
              role: plan.role,
              scopes: plan.scopes,
              caps: ['tool-events'],
              auth: compactObject({ token: plan.token, deviceToken: plan.deviceToken }),
              locale: 'en-US',
              userAgent: 'jean-ci/1.0.0',
              device: {
                id: plan.deviceIdentity.deviceId,
                publicKey: deps.publicKeyFromPem(plan.deviceIdentity.publicKeyPem),
                signature,
                signedAt,
                nonce,
              },
            },
          };
          ws!.send(JSON.stringify(connectReq));
          return;
        }

        if (msg.type === 'hello-ok') {
          logWs('received legacy hello-ok event', { method });
          const hello = msg as HelloOk;
          await acceptConnectAndSendRpc(hello);
          return;
        }

        if (msg.type === 'res' && msg.id === 'connect-1') {
          if (connectResponseTimer) {
            clearTimeout(connectResponseTimer);
            connectResponseTimer = null;
          }
          if (!msg.ok) {
            logWs('connect rejected', {
              method,
              message: msg.error?.message || 'unknown',
              code: readConnectErrorDetailCode(msg.error?.details),
              advice: extractRecoveryAdvice(msg.error?.details),
            });
            settle({
              success: false,
              error: `Connect failed: ${msg.error?.message || 'unknown'}`,
              errorDetails: msg.error?.details,
            });
            return;
          }

          logWs('connect accepted (rpc response)', { method });
          await acceptConnectAndSendRpc(msg.payload as HelloOk | undefined);
          return;
        }

        if (msg.type === 'res' && msg.id === requestId) {
          if (!connected) {
            logWs('rpc response arrived before hello-ok', { method, requestId });
            settle({ success: false, error: 'Gateway RPC response arrived before hello-ok' });
            return;
          }

          if (msg.ok) {
            logWs('rpc request succeeded', { method, requestId });
            settle({ success: true, result: msg.payload as T });
          } else {
            logWs('rpc request failed', {
              method,
              requestId,
              message: msg.error?.message || 'RPC request failed',
            });
            settle({ success: false, error: msg.error?.message || 'RPC request failed', errorDetails: msg.error?.details });
          }
        }
      });
    } catch (err) {
      settle({ success: false, error: `Failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}

function buildDeviceSignaturePayload(input: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string;
  nonce: string;
}) {
  return [
    'v2',
    input.deviceId,
    input.clientId,
    input.clientMode,
    input.role,
    input.scopes.join(','),
    String(input.signedAtMs),
    input.token ?? '',
    input.nonce,
  ].join('|');
}

function compactObject<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as T;
}

const DEVICE_IDENTITY_STATE_KEY = 'identity';
const DEVICE_TOKEN_STORE_STATE_KEY = 'token-store';

async function readDeviceTokenStore(deviceId: string): Promise<StoredDeviceTokenStore | null> {
  try {
    const raw = await getJsonState<StoredDeviceTokenStore>(DEVICE_TOKEN_STORE_STATE_KEY);
    if (!raw || raw.version !== DEVICE_TOKEN_STORE_VERSION || raw.deviceId !== deviceId || typeof raw.tokens !== 'object') {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

async function writeDeviceTokenStore(store: StoredDeviceTokenStore): Promise<void> {
  await setJsonState(DEVICE_TOKEN_STORE_STATE_KEY, store);
}

async function clearStoredDeviceToken(deviceId: string, role: string): Promise<void> {
  const existing = await readDeviceTokenStore(deviceId);
  if (!existing?.tokens?.[role]) return;
  const next: StoredDeviceTokenStore = {
    ...existing,
    tokens: { ...existing.tokens },
  };
  delete next.tokens[role];
  await writeDeviceTokenStore(next);
}

async function readStoredDeviceToken(
  deviceId: string,
  role: string,
  reader: (deviceId: string) => Promise<StoredDeviceTokenStore | null> | StoredDeviceTokenStore | null,
): Promise<StoredDeviceTokenRecord | null> {
  const store = await reader(deviceId);
  if (!store || store.deviceId !== deviceId) return null;
  return store.tokens?.[role] || null;
}

async function writeStoredDeviceToken(
  input: { deviceId: string; role: string; token: string; scopes: string[]; updatedAtMs: number },
  writer: (store: StoredDeviceTokenStore) => Promise<void> | void,
  reader: (deviceId: string) => Promise<StoredDeviceTokenStore | null> | StoredDeviceTokenStore | null,
) {
  const current = await reader(input.deviceId);
  const next: StoredDeviceTokenStore = {
    version: DEVICE_TOKEN_STORE_VERSION,
    deviceId: input.deviceId,
    tokens: current?.tokens ? { ...current.tokens } : {},
  };
  next.tokens[input.role] = {
    token: input.token,
    role: input.role,
    scopes: [...new Set(input.scopes)],
    updatedAtMs: input.updatedAtMs,
  };
  await writer(next);
}

async function loadOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  const existing = await getJsonState<{ version: number; deviceId: string; publicKeyPem: string; privateKeyPem: string }>(DEVICE_IDENTITY_STATE_KEY);
  if (
    existing?.version === 1 &&
    typeof existing.deviceId === 'string' &&
    typeof existing.publicKeyPem === 'string' &&
    typeof existing.privateKeyPem === 'string'
  ) {
    const derivedId = fingerprintPublicKey(existing.publicKeyPem);
    if (derivedId !== existing.deviceId) {
      const updated = { ...existing, deviceId: derivedId };
      await setJsonState(DEVICE_IDENTITY_STATE_KEY, updated);
      return {
        deviceId: derivedId,
        publicKeyPem: existing.publicKeyPem,
        privateKeyPem: existing.privateKeyPem,
      };
    }
    return {
      deviceId: existing.deviceId,
      publicKeyPem: existing.publicKeyPem,
      privateKeyPem: existing.privateKeyPem,
    };
  }

  const identity = generateDeviceIdentity();
  await setJsonState(DEVICE_IDENTITY_STATE_KEY, { version: 1, ...identity, createdAtMs: Date.now() });
  return identity;
}

function readConnectErrorDetailCode(details: unknown): string | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  return typeof (details as Record<string, unknown>).code === 'string'
    ? ((details as Record<string, string>).code || null)
    : null;
}

function extractRecoveryAdvice(details: unknown): {
  canRetryWithDeviceToken?: boolean;
  recommendedNextStep?: string;
} {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const raw = details as Record<string, unknown>;
  return {
    canRetryWithDeviceToken:
      typeof raw.canRetryWithDeviceToken === 'boolean' ? raw.canRetryWithDeviceToken : undefined,
    recommendedNextStep:
      typeof raw.recommendedNextStep === 'string' ? raw.recommendedNextStep : undefined,
  };
}


function base64UrlEncode(buffer: Uint8Array | Buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function derivePublicKeyRaw(publicKeyPem: string) {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: 'spki', format: 'der' }) as Buffer;
  const ed25519SpkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  if (spki.length === ed25519SpkiPrefix.length + 32 && spki.subarray(0, ed25519SpkiPrefix.length).equals(ed25519SpkiPrefix)) {
    return spki.subarray(ed25519SpkiPrefix.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem: string) {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function generateDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return {
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
  };
}

function signDevicePayload(privateKeyPem: string, payload: string) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, 'utf8'), key));
}

function publicKeyRawBase64UrlFromPem(publicKeyPem: string) {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function logWs(message: string, details?: Record<string, unknown>) {
  if (details && Object.keys(details).length > 0) {
    console.log(`[openclaw-ws] ${message}`, details);
  } else {
    console.log(`[openclaw-ws] ${message}`);
  }
}

function shortDeviceId(deviceId: string) {
  if (!deviceId) return deviceId;
  return `${deviceId.slice(0, 8)}…${deviceId.slice(-6)}`;
}
