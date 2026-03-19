export type OpenClawGatewayErrorType = 'gateway' | 'unknown';

export interface OpenClawGatewayFailure {
  errorType: OpenClawGatewayErrorType;
  error: string;
  retryable: boolean;
}

export function getRetryDelayMs(attempt: number, retryBaseMs: number) {
  return retryBaseMs * 2 ** (attempt - 1);
}

export function classifyGatewayHttpFailure(status: number, body: string): OpenClawGatewayFailure {
  const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);
  const retryable = retryableStatuses.has(status);
  const errorType: OpenClawGatewayErrorType = retryable ? 'gateway' : 'unknown';
  const detail = body?.trim() ? body.trim() : `HTTP ${status}`;

  return {
    errorType,
    retryable,
    error: `Gateway request failed with status ${status}: ${detail}`,
  };
}

export function classifyGatewayException(error: unknown): OpenClawGatewayFailure {
  const message = error instanceof Error ? error.message : String(error);
  const gatewayLikePatterns = /(timeout|timed out|econnreset|enotfound|eai_again|fetch failed|network|socket)/i;
  const isGatewayIssue = gatewayLikePatterns.test(message);

  return {
    errorType: isGatewayIssue ? 'gateway' : 'unknown',
    retryable: isGatewayIssue,
    error: message,
  };
}

export async function runWithExponentialRetry<T>(
  operation: (attempt: number) => Promise<
    | { success: true; value: T }
    | { success: false; failure: OpenClawGatewayFailure }
  >,
  options: {
    maxAttempts: number;
    retryBaseMs: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<
  | { success: true; value: T; attempts: number }
  | { success: false; failure: OpenClawGatewayFailure; attempts: number }
> {
  const maxAttempts = Math.max(1, options.maxAttempts);
  const sleep = options.sleep || ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let latestFailure: OpenClawGatewayFailure = { errorType: 'gateway', error: 'Unknown gateway error', retryable: true };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await operation(attempt);
    if (result.success) {
      return { success: true, value: result.value, attempts: attempt };
    }

    latestFailure = result.failure;
    if (!result.failure.retryable || attempt >= maxAttempts) {
      return { success: false, failure: result.failure, attempts: attempt };
    }

    await sleep(getRetryDelayMs(attempt, options.retryBaseMs));
  }

  return { success: false, failure: latestFailure, attempts: maxAttempts };
}
