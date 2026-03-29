import { callGatewayRpc } from './openclaw-ws.ts';

export type GatewayPlaygroundProbeRequest = {
  mode: 'sessions_list' | 'responses_create';
  prompt?: string;
};

export type GatewayPlaygroundProbeResponse = {
  ok: boolean;
  mode: GatewayPlaygroundProbeRequest['mode'];
  latencyMs: number;
  result?: unknown;
  error?: string;
  errorDetails?: Record<string, unknown>;
};

export async function runGatewayPlaygroundProbe(
  input: GatewayPlaygroundProbeRequest,
  deps: {
    callGatewayRpc?: typeof callGatewayRpc;
    now?: () => number;
  } = {},
): Promise<GatewayPlaygroundProbeResponse> {
  const gatewayRpc = deps.callGatewayRpc || callGatewayRpc;
  const now = deps.now || Date.now;
  const startedAt = now();

  if (input.mode === 'sessions_list') {
    const result = await gatewayRpc('sessions.list', { limit: 3 });
    return {
      ok: result.success,
      mode: input.mode,
      latencyMs: Math.max(0, now() - startedAt),
      ...(result.success
        ? { result: result.result }
        : { error: result.error, errorDetails: result.errorDetails }),
    };
  }

  const prompt = (input.prompt || 'Reply with exactly OK.').trim() || 'Reply with exactly OK.';
  const result = await gatewayRpc('responses.create', {
    model: process.env.OPENCLAW_RESPONSES_MODEL || 'openclaw',
    input: [
      {
        type: 'message',
        role: 'user',
        content: prompt,
      },
    ],
  });

  return {
    ok: result.success,
    mode: input.mode,
    latencyMs: Math.max(0, now() - startedAt),
    ...(result.success
      ? { result: result.result }
      : { error: result.error, errorDetails: result.errorDetails }),
  };
}
