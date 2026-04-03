import { getJsonState, setJsonState } from './db.ts';
import { getOpenClawDeviceAuthDebugInfo } from './openclaw-ws.ts';

const DEVICE_TOKEN_STORE_STATE_KEY = 'token-store';
const DEFAULT_OPERATOR_ROLE = 'operator';
const DEFAULT_OPERATOR_SCOPES = ['operator.read', 'operator.write', 'operator.admin'] as const;

export type StoredDeviceTokenRecord = {
  token: string;
  role: string;
  scopes: string[];
  updatedAtMs: number;
};

export type StoredDeviceTokenStore = {
  version: number;
  deviceId: string;
  tokens: Record<string, StoredDeviceTokenRecord>;
};

export type GatewayTokenAdminState = {
  deviceId: string | null;
  requestedRole: string;
  requestedScopes: string[];
  storedRole: string | null;
  storedScopes: string[];
  hasStoredToken: boolean;
  storedTokenUpdatedAtMs: number | null;
  tokenStoreExists: boolean;
};

export async function getGatewayTokenAdminState(deps: {
  getDebugInfo?: typeof getOpenClawDeviceAuthDebugInfo;
  readStore?: (deviceId: string) => Promise<StoredDeviceTokenStore | null>;
  writeStore?: (store: StoredDeviceTokenStore) => Promise<void>;
} = {}): Promise<GatewayTokenAdminState> {
  const debug = await (deps.getDebugInfo || getOpenClawDeviceAuthDebugInfo)();
  const store = debug.deviceId ? await (deps.readStore || readDeviceTokenStore)(debug.deviceId) : null;
  const record = store?.tokens?.[DEFAULT_OPERATOR_ROLE] ?? null;

  return {
    deviceId: debug.deviceId ?? null,
    requestedRole: DEFAULT_OPERATOR_ROLE,
    requestedScopes: [...DEFAULT_OPERATOR_SCOPES],
    storedRole: record?.role ?? null,
    storedScopes: [...(record?.scopes ?? [])],
    hasStoredToken: !!record?.token,
    storedTokenUpdatedAtMs: record?.updatedAtMs ?? null,
    tokenStoreExists: debug.tokenStoreExists,
  };
}

export async function revokeStoredGatewayToken(deps: {
  getDebugInfo?: typeof getOpenClawDeviceAuthDebugInfo;
  readStore?: (deviceId: string) => Promise<StoredDeviceTokenStore | null>;
  writeStore?: (store: StoredDeviceTokenStore) => Promise<void>;
} = {}): Promise<GatewayTokenAdminState> {
  const state = await getGatewayTokenAdminState(deps);
  if (!state.deviceId) {
    return state;
  }

  const reader = deps.readStore || readDeviceTokenStore;
  const writer = deps.writeStore || writeDeviceTokenStoreState;
  const store = await reader(state.deviceId);
  if (store?.tokens?.[DEFAULT_OPERATOR_ROLE]) {
    const next: StoredDeviceTokenStore = {
      ...store,
      tokens: { ...store.tokens },
    };
    delete next.tokens[DEFAULT_OPERATOR_ROLE];
    await writer(next);
  }

  return getGatewayTokenAdminState(deps);
}

async function readDeviceTokenStore(deviceId: string): Promise<StoredDeviceTokenStore | null> {
  const raw = await getJsonState<StoredDeviceTokenStore>(DEVICE_TOKEN_STORE_STATE_KEY);
  if (!raw || raw.version !== 1 || raw.deviceId !== deviceId || typeof raw.tokens !== 'object' || raw.tokens == null) {
    return null;
  }
  return raw;
}

async function writeDeviceTokenStoreState(store: StoredDeviceTokenStore): Promise<void> {
  await setJsonState(DEVICE_TOKEN_STORE_STATE_KEY, store);
}
