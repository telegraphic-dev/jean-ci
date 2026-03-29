import { buildGatewayAuthGuidance, classifyGatewayException, type GatewayAuthRecoveryHint } from './openclaw-gateway.ts';
import { callGatewayRpc, isWebSocketEnabled } from './openclaw-ws.ts';

export type GatewayDashboardStatus = {
  status: 'connected' | 'pairing_required' | 'auth_error' | 'unreachable' | 'disabled';
  label: string;
  color: 'green' | 'yellow' | 'red' | 'gray';
  detail: string;
  guidance: string | null;
  usingWebSocket: boolean;
  deviceId: string | null;
};

export async function getGatewayDashboardStatus(deps: {
  isWebSocketEnabled?: () => boolean;
  callGatewayRpc?: typeof callGatewayRpc;
} = {}): Promise<GatewayDashboardStatus> {
  const usingWebSocket = (deps.isWebSocketEnabled || isWebSocketEnabled)();

  if (!usingWebSocket) {
    return {
      status: 'disabled',
      label: 'WebSocket disabled',
      color: 'gray',
      detail: 'OPENCLAW_USE_WEBSOCKET is not enabled.',
      guidance: 'Enable OPENCLAW_USE_WEBSOCKET=true to use device-auth websocket gateway status checks.',
      usingWebSocket,
      deviceId: null,
    };
  }

  const gatewayRpc = deps.callGatewayRpc || callGatewayRpc;
  const result = await gatewayRpc<{ items?: unknown[] }>('sessions.list', { limit: 1 });
  if (result.success) {
    return {
      status: 'connected',
      label: 'Connected',
      color: 'green',
      detail: 'Gateway websocket/device auth is healthy.',
      guidance: null,
      usingWebSocket,
      deviceId: null,
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
      deviceId: hint.deviceId ?? null,
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
      deviceId: hint.deviceId ?? null,
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
    deviceId: null,
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
