function normalizeGatewayPublicUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidate = /^[a-z]+:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    url.search = '';
    if (!url.pathname.endsWith('/')) {
      url.pathname = `${url.pathname}/`;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function getGatewayChatBaseUrl(): string | null {
  const raw = process.env.OPENCLAW_GATEWAY_PUBLIC_URL;
  if (!raw) return null;
  return normalizeGatewayPublicUrl(raw);
}

export function buildGatewayChatSessionUrl(sessionKey: string): string | null {
  const baseUrl = getGatewayChatBaseUrl();
  const trimmedSessionKey = sessionKey.trim();
  if (!baseUrl || !trimmedSessionKey) return null;

  const url = new URL('chat', baseUrl);
  url.searchParams.set('session', trimmedSessionKey);
  return url.toString();
}
