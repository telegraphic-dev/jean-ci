import { buildGatewayAuthGuidance, classifyGatewayException, type GatewayAuthRecoveryHint } from './openclaw-gateway.ts';
import { callGatewayRpc, getOpenClawDeviceAuthDebugInfo, isWebSocketEnabled } from './openclaw-ws.ts';

export type GatewayDashboardStatus = {
  status: 'connected' | 'pairing_required' | 'auth_error' | 'unreachable' | 'disabled';
  label: string;
  color: 'green' | 'yellow' | 'red' | 'gray';
  detail: string;
  guidance: string | null;
  usingWebSocket: boolean;
  deviceId: string | null;
  latencyMs: number | null;
  debug: {
    gatewayUrl: string | null;
    identityPath: string | null;
    identityExists: boolean;
    tokenStorePath: string | null;
    tokenStoreExists: boolean;
    hasSharedToken: boolean;
    hasStoredDeviceToken: boolean;
  };
};

export async function getGatewayDashboardStatus(deps: {
  isWebSocketEnabled?: () => boolean;
  callGatewayRpc?: typeof callGatewayRpc;
  getDebugInfo?: typeof getOpenClawDeviceAuthDebugInfo;
  now?: () => number;
} = {}): Promise<GatewayDashboardStatus> {
  const usingWebSocket = (deps.isWebSocketEnabled || isWebSocketEnabled)();
  const debugInfo = await (deps.getDebugInfo || getOpenClawDeviceAuthDebugInfo)();
  const debug = {
    gatewayUrl: debugInfo.gatewayUrl,
    identityPath: debugInfo.identityPath,
    identityExists: debugInfo.identityExists,
    tokenStorePath: debugInfo.tokenStorePath,
    tokenStoreExists: debugInfo.tokenStoreExists,
    hasSharedToken: debugInfo.hasSharedToken,
    hasStoredDeviceToken: debugInfo.hasStoredDeviceToken,
  };

  if (!usingWebSocket) {
    return {
      status: 'disabled',
      label: 'WebSocket disabled',
      color: 'gray',
      detail: 'OPENCLAW_USE_WEBSOCKET is not enabled.',
      guidance: 'Enable OPENCLAW_USE_WEBSOCKET=true to use device-auth websocket gateway status checks.',
      usingWebSocket,
      deviceId: debugInfo.deviceId ?? null,
      latencyMs: null,
      debug,
    };
  }

  const gatewayRpc = deps.callGatewayRpc || callGatewayRpc;
  const now = deps.now || Date.now;
  const startedAt = now();
  const result = await gatewayRpc<{ items?: unknown[] }>('sessions.list', { limit: 1 });
  const latencyMs = Math.max(0, now() - startedAt);
  if (result.success) {
    return {
      status: 'connected',
      label: 'Connected',
      color: 'green',
      detail: 'Gateway websocket/device auth is healthy.',
      guidance: null,
      usingWebSocket,
      deviceId: debugInfo.deviceId ?? null,
      latencyMs,
      debug,
    };
  }

  const hint = extractGatewayAuthHint(result.error, result.errorDetails);
  if (hint?.code === 'PAIRING_REQUIRED') {
    return {
      status: 'pairing_required',
      label: 'Pairing required',
      color: 'yellow',
      detail: 'jean-ci must be approved on the OpenClaw gateway before reviews can run.',
      guidance: buildGatewayAuthGuidance(hint),
      usingWebSocket,
      deviceId: hint.deviceId ?? debugInfo.deviceId ?? null,
      latencyMs,
      debug,
    };
  }

  if (hint?.code) {
    return {
      status: 'auth_error',
      label: hint.code,
      color: 'red',
      detail: 'Gateway rejected jean-ci authentication.',
      guidance: buildGatewayAuthGuidance(hint),
      usingWebSocket,
      deviceId: hint.deviceId ?? debugInfo.deviceId ?? null,
      latencyMs,
      debug,
    };
  }

  const failure = classifyGatewayException(new Error(result.error));
  return {
    status: 'unreachable',
    label: failure.errorType === 'gateway' ? 'Unreachable' : 'Error',
    color: 'red',
    detail: result.error,
    guidance: null,
    usingWebSocket,
    deviceId: debugInfo.deviceId ?? null,
    latencyMs,
    debug,
  };
}

function extractGatewayAuthHint(error: string, errorDetails?: Record<string, unknown>): GatewayAuthRecoveryHint | null {
  if (errorDetails && typeof errorDetails === 'object') {
    const code = typeof errorDetails.code === 'string' ? errorDetails.code : undefined;
    const canRetryWithDeviceToken = typeof errorDetails.canRetryWithDeviceToken === 'boolean'
      ? errorDetails.canRetryWithDeviceToken
      : undefined;
    const recommendedNextStep = typeof errorDetails.recommendedNextStep === 'string'
      ? errorDetails.recommendedNextStep
      : undefined;
    const deviceId = typeof errorDetails.deviceId === 'string'
      ? errorDetails.deviceId
      : undefined;

    if (code || canRetryWithDeviceToken !== undefined || recommendedNextStep || deviceId) {
      return {
        ...(code ? { code } : {}),
        ...(canRetryWithDeviceToken !== undefined ? { canRetryWithDeviceToken } : {}),
        ...(recommendedNextStep ? { recommendedNextStep } : {}),
        ...(deviceId ? { deviceId } : {}),
      };
    }
  }

  if (/pairing required/i.test(error)) {
    return { code: 'PAIRING_REQUIRED' };
  }
  if (/device token mismatch/i.test(error)) {
    return { code: 'AUTH_DEVICE_TOKEN_MISMATCH' };
  }
  if (/token mismatch/i.test(error)) {
    return { code: 'AUTH_TOKEN_MISMATCH' };
  }

  return null;
}
