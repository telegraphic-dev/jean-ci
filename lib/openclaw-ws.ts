import {
  DEFAULT_SCOPES,
  OpenClawGatewayClient,
  OpenClawGatewayError,
  type DeviceIdentity,
  type DeviceStateStore,
  type StoredDeviceTokenStore,
  type SessionsDeleteResult,
  normalizeWebSocketUrl,
} from '@telegraphic-dev/openclaw-gateway-client';
import { getJsonState, setJsonState } from './db.ts';

const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_CHALLENGE_TIMEOUT_MS = 3_000;
const ROLE = 'operator';
const SCOPES = [...DEFAULT_SCOPES] as const;
const DEVICE_TOKEN_STORE_VERSION = 1;

const DEVICE_IDENTITY_STATE_KEY = 'identity';
const DEVICE_TOKEN_STORE_STATE_KEY = 'token-store';

export interface SessionDeleteResult extends SessionsDeleteResult {}

type GatewayRpcResult<T> =
  | { success: true; result: T }
  | { success: false; error: string; errorDetails?: Record<string, unknown> };

type LoggerFn = (message: string, details?: Record<string, unknown>) => void;

function logWs(message: string, details?: Record<string, unknown>) {
  if (details) {
    console.log(`[openclaw-ws] ${message}`, details);
  } else {
    console.log(`[openclaw-ws] ${message}`);
  }
}

function warnWs(message: string, details?: Record<string, unknown>) {
  if (details) {
    console.warn(`[openclaw-ws] ${message}`, details);
  } else {
    console.warn(`[openclaw-ws] ${message}`);
  }
}

function errorWs(message: string, details?: Record<string, unknown>) {
  if (details) {
    console.error(`[openclaw-ws] ${message}`, details);
  } else {
    console.error(`[openclaw-ws] ${message}`);
  }
}

export function isWebSocketEnabled(): boolean {
  return process.env.OPENCLAW_USE_WEBSOCKET === 'true';
}

export function getWebSocketUrl(): string | null {
  const url = process.env.OPENCLAW_GATEWAY_URL?.trim();
  if (!url) return null;
  return normalizeWebSocketUrl(url);
}

function buildStore(): DeviceStateStore {
  return {
    async loadIdentity(): Promise<DeviceIdentity | null> {
      const identity = await getJsonState<DeviceIdentity>(DEVICE_IDENTITY_STATE_KEY);
      if (!identity?.deviceId || !identity.publicKeyPem || !identity.privateKeyPem) {
        return null;
      }
      return identity;
    },
    async saveIdentity(identity: DeviceIdentity): Promise<void> {
      await setJsonState(DEVICE_IDENTITY_STATE_KEY, identity);
    },
    async loadTokenStore(deviceId: string): Promise<StoredDeviceTokenStore | null> {
      const store = await getJsonState<StoredDeviceTokenStore>(DEVICE_TOKEN_STORE_STATE_KEY);
      if (!store || store.version !== DEVICE_TOKEN_STORE_VERSION || store.deviceId !== deviceId || typeof store.tokens !== 'object' || store.tokens == null) {
        return null;
      }
      return store;
    },
    async saveTokenStore(store: StoredDeviceTokenStore): Promise<void> {
      await setJsonState(DEVICE_TOKEN_STORE_STATE_KEY, store);
    },
    async clearStoredDeviceToken(deviceId: string, role: string): Promise<void> {
      const store = await this.loadTokenStore(deviceId);
      if (!store?.tokens?.[role]) return;
      const next: StoredDeviceTokenStore = {
        ...store,
        tokens: { ...store.tokens },
      };
      delete next.tokens[role];
      await this.saveTokenStore(next);
    },
  };
}

function buildGatewayClient(authOverrides: { role?: string; scopes?: string[] } = {}) {
  const url = getWebSocketUrl();
  const token = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (!url || !token) {
    return null;
  }

  const role = authOverrides.role?.trim() || ROLE;
  const scopes = [...new Set((authOverrides.scopes || [...SCOPES]).map((scope) => scope.trim()).filter(Boolean))];

  return new OpenClawGatewayClient({
    url,
    token,
    role,
    scopes: scopes.length > 0 ? scopes : [...SCOPES],
    store: buildStore(),
    client: {
      id: 'gateway-client',
      version: '0.1.0',
      platform: 'node',
      mode: 'backend',
    },
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    challengeTimeoutMs: CONNECT_CHALLENGE_TIMEOUT_MS,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    logger: {
      debug: logWs as LoggerFn,
      info: logWs as LoggerFn,
      warn: warnWs as LoggerFn,
      error: errorWs as LoggerFn,
    },
  });
}

export async function callGatewayRpc<T>(
  method: string,
  params: Record<string, unknown> = {},
  authOverrides: { role?: string; scopes?: string[] } = {},
): Promise<GatewayRpcResult<T>> {
  const client = buildGatewayClient(authOverrides);
  if (!client) {
    return { success: false, error: 'WebSocket URL or token not configured' };
  }

  try {
    const result = await client.request<T>(method, params);
    return { success: true, result };
  } catch (error) {
    if (error instanceof OpenClawGatewayError) {
      return {
        success: false,
        error: error.message,
        errorDetails: error.details,
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function deleteSession(
  sessionKey: string,
  options: {
    deleteTranscript?: boolean;
    emitLifecycleHooks?: boolean;
  } = {},
): Promise<GatewayRpcResult<SessionDeleteResult>> {
  const { deleteTranscript = true, emitLifecycleHooks = false } = options;

  logWs(`Deleting session: ${sessionKey}`);

  const result = await callGatewayRpc<SessionDeleteResult>('sessions.delete', {
    key: sessionKey,
    deleteTranscript,
    emitLifecycleHooks,
  });

  if (result.success) {
    logWs(`Session deleted: ${sessionKey}, archived: ${result.result.archived?.length || 0} files`);
  } else {
    errorWs(`Failed to delete session ${sessionKey}: ${result.error}`);
  }

  return result;
}

export async function listSessions(options: {
  limit?: number;
  activeMinutes?: number;
} = {}): Promise<GatewayRpcResult<unknown[]>> {
  const result = await callGatewayRpc<{ sessions?: unknown[] } | unknown[]>('sessions.list', options);
  if (!result.success) {
    return result;
  }

  const payload = result.result;
  const sessions = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { sessions?: unknown[] })?.sessions)
      ? (payload as { sessions: unknown[] }).sessions
      : [];

  return { success: true, result: sessions };
}

export async function getOpenClawDeviceAuthDebugInfo() {
  const store = buildStore();
  const identity = await store.loadIdentity();
  const storedToken = identity ? (await store.loadTokenStore(identity.deviceId))?.tokens?.[ROLE] ?? null : null;

  return {
    websocketEnabled: isWebSocketEnabled(),
    gatewayUrl: process.env.OPENCLAW_GATEWAY_URL || null,
    identityPath: 'postgres:jean_ci_openclaw_device_state:identity',
    identityExists: !!identity,
    tokenStorePath: 'postgres:jean_ci_openclaw_device_state:token-store',
    tokenStoreExists: !!storedToken,
    deviceId: identity?.deviceId ?? null,
    role: ROLE,
    scopes: [...SCOPES],
    hasSharedToken: !!process.env.OPENCLAW_GATEWAY_TOKEN?.trim(),
    hasStoredDeviceToken: !!storedToken?.token,
    storedDeviceTokenUpdatedAtMs: storedToken?.updatedAtMs ?? null,
  };
}
