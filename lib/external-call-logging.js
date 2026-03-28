function safeUrl(input) {
  try {
    const parsed = new URL(input);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return input.split('?')[0] || input;
  }
}

function redactSecrets(value) {
  let output = value;
  output = output.replace(/bearer\s+[a-z0-9\-_=\.]+/ig, 'Bearer [REDACTED]');
  output = output.replace(/("?(?:token|apiKey|api_key|authorization|password)"?\s*[:=]\s*"?)[^",\s]+/ig, '$1[REDACTED]');
  output = output.replace(/\beyJ[a-zA-Z0-9_\-=]+\.[a-zA-Z0-9_\-=]+\.[a-zA-Z0-9_\-=]+\b/g, '[REDACTED_JWT]');
  return output;
}

function responseSnippet(value, maxLength = 400) {
  if (!value) return null;
  const normalized = redactSecrets(value.replace(/\s+/g, ' ').trim());
  if (!normalized) return null;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function normalizeError(error) {
  if (!error) return undefined;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
    };
  }

  return {
    message: typeof error === 'string' ? error : JSON.stringify(error),
  };
}

export function logExternalCallFailure(input) {
  const entry = {
    event: 'external_call_failed',
    service: input.service,
    operation: input.operation,
    phase: input.phase,
    method: input.method || 'GET',
    url: safeUrl(input.url),
    status: input.status,
    responseBodySnippet: responseSnippet(input.responseBody),
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    retryable: input.retryable,
    error: normalizeError(input.error),
  };

  console.error(`[ExternalCallFailure] ${JSON.stringify(entry)}`);
}

export async function readResponseBodySnippet(response) {
  try {
    return responseSnippet(await response.text());
  } catch {
    return null;
  }
}
