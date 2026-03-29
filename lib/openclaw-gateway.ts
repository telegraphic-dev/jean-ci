export type OpenClawGatewayErrorType = 'gateway' | 'unknown';

export interface OpenClawGatewayFailure {
  errorType: OpenClawGatewayErrorType;
  error: string;
  retryable: boolean;
}

export interface GatewayAuthRecoveryHint {
  code?: string;
  canRetryWithDeviceToken?: boolean;
  recommendedNextStep?: string;
  deviceId?: string;
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
  const authLikePatterns = /(pairing required|auth_token_mismatch|auth_device_token_mismatch|token mismatch|device token mismatch)/i;
  const isGatewayIssue = gatewayLikePatterns.test(message) || authLikePatterns.test(message);
  const retryable = gatewayLikePatterns.test(message);

  return {
    errorType: isGatewayIssue ? 'gateway' : 'unknown',
    retryable,
    error: message,
  };
}

export function parseGatewayAuthRecoveryHint(body: string | null | undefined): GatewayAuthRecoveryHint | null {
  if (!body) return null;

  const normalized = body.trim();
  if (!normalized) return null;

  try {
    const parsed = JSON.parse(normalized);
    const details = parsed?.error?.details || parsed?.details || parsed?.errorDetails;
    if (!details || typeof details !== 'object') return null;

    const code = typeof details.code === 'string' ? details.code : undefined;
    const canRetryWithDeviceToken = typeof details.canRetryWithDeviceToken === 'boolean'
      ? details.canRetryWithDeviceToken
      : undefined;
    const recommendedNextStep = typeof details.recommendedNextStep === 'string'
      ? details.recommendedNextStep
      : undefined;
    const deviceId = typeof details.deviceId === 'string'
      ? details.deviceId
      : undefined;

    if (!code && canRetryWithDeviceToken === undefined && !recommendedNextStep && !deviceId) {
      return null;
    }

    return {
      ...(code ? { code } : {}),
      ...(canRetryWithDeviceToken !== undefined ? { canRetryWithDeviceToken } : {}),
      ...(recommendedNextStep ? { recommendedNextStep } : {}),
      ...(deviceId ? { deviceId } : {}),
    };
  } catch {
    return null;
  }
}

export function buildGatewayAuthGuidance(hint: GatewayAuthRecoveryHint | null): string | null {
  if (!hint) return null;

  const lines: string[] = [];

  if (hint.code === 'AUTH_TOKEN_MISMATCH' && hint.canRetryWithDeviceToken) {
    lines.push('Gateway reported AUTH_TOKEN_MISMATCH and recommends retrying once with the cached device token.');
  }

  if (hint.code === 'AUTH_DEVICE_TOKEN_MISMATCH') {
    lines.push('Gateway reported AUTH_DEVICE_TOKEN_MISMATCH. Re-approve or rotate the jean-ci device token, then retry.');
  }

  if (hint.code === 'PAIRING_REQUIRED') {
    const pairTarget = hint.deviceId
      ? `device \`${hint.deviceId}\``
      : 'pending jean-ci device request';
    lines.push(`Gateway reported PAIRING_REQUIRED. jean-ci must be paired before it can review PRs. Approve the ${pairTarget} and then retry.`);
    lines.push('How to pair it: 1) run `openclaw devices list` to find the pending request, 2) note the request id and device id, 3) approve it with `openclaw devices approve <requestId>`, 4) verify the device is approved with `openclaw devices list`, 5) re-run the failed jean-ci check.');
    lines.push('If approval fails or the device/token drifted, rotate the jean-ci device credential with `openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write`, update the stored credential if needed, and retry.');
  }

  if (hint.recommendedNextStep === 'retry_with_device_token') {
    lines.push('Recommended next step: retry once with the cached device token.');
  } else if (hint.recommendedNextStep === 'update_auth_configuration') {
    lines.push('Recommended next step: update jean-ci gateway auth configuration.');
  } else if (hint.recommendedNextStep === 'update_auth_credentials') {
    lines.push('Recommended next step: update/rotate jean-ci credentials.');
  } else if (hint.recommendedNextStep === 'review_auth_configuration') {
    lines.push('Recommended next step: review jean-ci gateway auth configuration.');
  }

  if (!lines.length) return null;
  return lines.join(' ');
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
