export function getOpenClawAgentId(): string {
  const configuredAgentId = process.env.OPENCLAW_AGENT_ID?.trim();
  return configuredAgentId || 'main';
}

export function resolveOpenClawModel(configuredModel: string | undefined, agentId = getOpenClawAgentId()): string {
  const trimmedModel = configuredModel?.trim();
  if (trimmedModel) return trimmedModel;
  return agentId === 'main' ? 'openclaw' : `openclaw/${agentId}`;
}

export function buildAgentSessionKey(keySuffix: string, agentId = getOpenClawAgentId()): string {
  return `${agentId}:${keySuffix.replace(/^:+/, '')}`;
}
