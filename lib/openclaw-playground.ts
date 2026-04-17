import { callGatewayRpc } from './openclaw-ws.ts';
import { buildAgentSessionKey, getOpenClawAgentId } from './openclaw-agent.ts';

export const GATEWAY_METHOD_SCOPE_GROUPS = {
  'operator.approvals': [
    'exec.approval.request',
    'exec.approval.waitDecision',
    'exec.approval.resolve',
    'plugin.approval.request',
    'plugin.approval.waitDecision',
    'plugin.approval.resolve',
  ],
  'operator.pairing': [
    'node.pair.request',
    'node.pair.list',
    'node.pair.reject',
    'node.pair.verify',
    'device.pair.list',
    'device.pair.approve',
    'device.pair.reject',
    'device.pair.remove',
    'device.token.rotate',
    'device.token.revoke',
    'node.rename',
  ],
  'operator.read': [
    'health',
    'doctor.memory.status',
    'logs.tail',
    'channels.status',
    'status',
    'usage.status',
    'usage.cost',
    'tts.status',
    'tts.providers',
    'models.list',
    'tools.catalog',
    'tools.effective',
    'agents.list',
    'agent.identity.get',
    'skills.status',
    'voicewake.get',
    'sessions.list',
    'sessions.get',
    'sessions.preview',
    'sessions.resolve',
    'sessions.subscribe',
    'sessions.unsubscribe',
    'sessions.messages.subscribe',
    'sessions.messages.unsubscribe',
    'sessions.usage',
    'sessions.usage.timeseries',
    'sessions.usage.logs',
    'cron.list',
    'cron.status',
    'cron.runs',
    'gateway.identity.get',
    'system-presence',
    'last-heartbeat',
    'node.list',
    'node.describe',
    'chat.history',
    'config.get',
    'config.schema.lookup',
    'talk.config',
    'agents.files.list',
    'agents.files.get',
  ],
  'operator.write': [
    'send',
    'poll',
    'agent',
    'agent.wait',
    'wake',
    'talk.mode',
    'talk.speak',
    'tts.enable',
    'tts.disable',
    'tts.convert',
    'tts.setProvider',
    'voicewake.set',
    'node.invoke',
    'node.pair.approve',
    'chat.send',
    'chat.abort',
    'sessions.create',
    'sessions.send',
    'sessions.steer',
    'sessions.abort',
    'push.test',
    'node.pending.enqueue',
  ],
  'operator.admin': [
    'channels.logout',
    'agents.create',
    'agents.update',
    'agents.delete',
    'skills.install',
    'skills.update',
    'secrets.reload',
    'secrets.resolve',
    'cron.add',
    'cron.update',
    'cron.remove',
    'cron.run',
    'sessions.patch',
    'sessions.reset',
    'sessions.delete',
    'sessions.compact',
    'connect',
    'chat.inject',
    'web.login.start',
    'web.login.wait',
    'set-heartbeats',
    'system-event',
    'agents.files.set',
  ],
} as const;

export const GATEWAY_ADMIN_METHOD_PREFIXES = [
  'exec.approvals.',
  'config.',
  'wizard.',
  'update.',
] as const;

const METHOD_SCOPE_BY_NAME = new Map<string, string>(
  Object.entries(GATEWAY_METHOD_SCOPE_GROUPS).flatMap(([scope, methods]) => methods.map((method) => [method, scope])),
);

export const GATEWAY_PLAYGROUND_OPERATIONS = {
  sessions_list: {
    label: 'sessions.list',
    method: 'sessions.list',
    notes: 'Read-only session listing probe.',
  },
  chat_send: {
    label: 'sessions.send',
    method: 'sessions.send',
    notes: 'Writable session probe using only session RPC methods.',
  },
} as const;

export type GatewayPlaygroundMode = keyof typeof GATEWAY_PLAYGROUND_OPERATIONS;

export type GatewayPlaygroundProbeRequest = {
  mode: GatewayPlaygroundMode;
  prompt?: string;
  role?: string;
  scopes?: string[];
  sessionKey?: string;
};

export type GatewayPlaygroundProbeResponse = {
  ok: boolean;
  mode: GatewayPlaygroundProbeRequest['mode'];
  latencyMs: number;
  result?: unknown;
  error?: string;
  errorDetails?: Record<string, unknown>;
  selectedRole: string;
  selectedScopes: string[];
  recommendedRole: string;
  recommendedScopes: string[];
  sessionKey?: string;
};

export type GatewayPlaygroundOperationDescriptor = {
  mode: GatewayPlaygroundMode;
  label: string;
  method: string;
  notes: string;
  sources: string[];
  defaultRole: string;
  defaultScopes: string[];
  requiredScopes: string[];
};

export type GatewayMethodPrivilegeDescriptor = {
  method: string;
  requiredScope: string;
  leastPrivilegeRole: 'operator';
  leastPrivilegeScopes: string[];
  source: 'openclaw-method-scopes' | 'openclaw-admin-prefix-fallback';
};

export function resolveRequiredOperatorScopeForMethod(method: string): {
  requiredScope: string;
  source: GatewayMethodPrivilegeDescriptor['source'];
} {
  const explicitScope = METHOD_SCOPE_BY_NAME.get(method);
  if (explicitScope) {
    return { requiredScope: explicitScope, source: 'openclaw-method-scopes' };
  }

  if (GATEWAY_ADMIN_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix))) {
    return { requiredScope: 'operator.admin', source: 'openclaw-admin-prefix-fallback' };
  }

  return { requiredScope: 'operator.admin', source: 'openclaw-admin-prefix-fallback' };
}

export function listGatewayMethodPrivileges(): GatewayMethodPrivilegeDescriptor[] {
  const direct = Array.from(METHOD_SCOPE_BY_NAME.entries())
    .map(([method, requiredScope]) => ({
      method,
      requiredScope,
      leastPrivilegeRole: 'operator' as const,
      leastPrivilegeScopes: [requiredScope],
      source: 'openclaw-method-scopes' as const,
    }));

  const prefixed = GATEWAY_ADMIN_METHOD_PREFIXES.map((prefix) => ({
    method: `${prefix}*`,
    requiredScope: 'operator.admin',
    leastPrivilegeRole: 'operator' as const,
    leastPrivilegeScopes: ['operator.admin'],
    source: 'openclaw-admin-prefix-fallback' as const,
  }));

  return [...direct, ...prefixed].sort((a, b) => a.method.localeCompare(b.method));
}

export function listGatewayPlaygroundOperations(): GatewayPlaygroundOperationDescriptor[] {
  return (Object.entries(GATEWAY_PLAYGROUND_OPERATIONS) as [GatewayPlaygroundMode, typeof GATEWAY_PLAYGROUND_OPERATIONS[GatewayPlaygroundMode]][])
    .map(([mode, operation]) => {
      const privilege = resolveRequiredOperatorScopeForMethod(operation.method);
      return {
        mode,
        label: operation.label,
        method: operation.method,
        notes: operation.notes,
        sources: privilege.source === 'openclaw-method-scopes'
          ? ['OpenClaw dist/method-scopes-DgElWZYI.js METHOD_SCOPE_GROUPS']
          : ['OpenClaw dist/method-scopes-DgElWZYI.js admin prefix fallback / default admin fallback'],
        defaultRole: 'operator',
        defaultScopes: [privilege.requiredScope],
        requiredScopes: [privilege.requiredScope],
      };
    });
}

export function resolveGatewayPlaygroundPrivileges(input: GatewayPlaygroundProbeRequest): {
  role: string;
  scopes: string[];
  recommendedRole: string;
  recommendedScopes: string[];
} {
  const operation = GATEWAY_PLAYGROUND_OPERATIONS[input.mode];
  const privilege = resolveRequiredOperatorScopeForMethod(operation.method);
  const selectedScopes = [...new Set((input.scopes || [privilege.requiredScope]).map((scope) => scope.trim()).filter(Boolean))];

  return {
    role: (input.role || 'operator').trim() || 'operator',
    scopes: selectedScopes.length > 0 ? selectedScopes : [privilege.requiredScope],
    recommendedRole: 'operator',
    recommendedScopes: [privilege.requiredScope],
  };
}

export async function runGatewayPlaygroundProbe(
  input: GatewayPlaygroundProbeRequest,
  deps: {
    callGatewayRpc?: typeof callGatewayRpc;
    now?: () => number;
    randomId?: () => string;
  } = {},
): Promise<GatewayPlaygroundProbeResponse> {
  const gatewayRpc = deps.callGatewayRpc || callGatewayRpc;
  const now = deps.now || Date.now;
  const randomId = deps.randomId || (() => `gateway-playground-${Math.random().toString(36).slice(2, 10)}`);
  const startedAt = now();
  const operation = GATEWAY_PLAYGROUND_OPERATIONS[input.mode];
  const privileges = resolveGatewayPlaygroundPrivileges(input);

  if (input.mode === 'sessions_list') {
    const result = await gatewayRpc(operation.method, { limit: 3 }, {
      role: privileges.role,
      scopes: privileges.scopes,
    });

    return {
      ok: result.success,
      mode: input.mode,
      latencyMs: Math.max(0, now() - startedAt),
      selectedRole: privileges.role,
      selectedScopes: privileges.scopes,
      recommendedRole: privileges.recommendedRole,
      recommendedScopes: privileges.recommendedScopes,
      ...(result.success
        ? { result: result.result }
        : { error: result.error, errorDetails: result.errorDetails }),
    };
  }

  const requestedSessionKey = (input.sessionKey || '').trim();
  const sessionKey = requestedSessionKey || buildAgentSessionKey('gateway-playground');

  const createResult = await gatewayRpc('sessions.create', {
    key: sessionKey,
    ...(requestedSessionKey ? {} : { agentId: getOpenClawAgentId() }),
    label: 'Gateway Playground',
  }, {
    role: privileges.role,
    scopes: privileges.scopes,
  });

  if (!createResult.success) {
    return {
      ok: false,
      mode: input.mode,
      latencyMs: Math.max(0, now() - startedAt),
      selectedRole: privileges.role,
      selectedScopes: privileges.scopes,
      recommendedRole: privileges.recommendedRole,
      recommendedScopes: privileges.recommendedScopes,
      sessionKey,
      error: createResult.error,
      errorDetails: createResult.errorDetails,
    };
  }

  const sendResult = await gatewayRpc('sessions.send', {
    key: sessionKey,
    message: ((input.prompt || 'Reply with exactly OK.').trim() || 'Reply with exactly OK.'),
    idempotencyKey: randomId(),
  }, {
    role: privileges.role,
    scopes: privileges.scopes,
  });

  if (!sendResult.success) {
    return {
      ok: false,
      mode: input.mode,
      latencyMs: Math.max(0, now() - startedAt),
      selectedRole: privileges.role,
      selectedScopes: privileges.scopes,
      recommendedRole: privileges.recommendedRole,
      recommendedScopes: privileges.recommendedScopes,
      sessionKey,
      error: sendResult.error,
      errorDetails: sendResult.errorDetails,
    };
  }

  const transcriptResult = await gatewayRpc('sessions.get', {
    key: sessionKey,
    limit: 10,
  }, {
    role: privileges.role,
    scopes: privileges.scopes,
  });

  return {
    ok: transcriptResult.success,
    mode: input.mode,
    latencyMs: Math.max(0, now() - startedAt),
    selectedRole: privileges.role,
    selectedScopes: privileges.scopes,
    recommendedRole: privileges.recommendedRole,
    recommendedScopes: privileges.recommendedScopes,
    sessionKey,
    ...(transcriptResult.success
      ? { result: transcriptResult.result }
      : { error: transcriptResult.error, errorDetails: transcriptResult.errorDetails }),
  };
}
