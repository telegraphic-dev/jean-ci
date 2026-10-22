/** Accept only literal app paths. Never decode/normalize attacker-controlled URLs. */
export function validateReturnTo(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512 || /[%\\\x00-\x20\x7f]/.test(value)) return null;
  if (/^\/checks\/[1-9]\d*$/.test(value)) return value;
  if (/^\/admin(?:\/[A-Za-z0-9_-]+)*$/.test(value)
    && !/^\/admin\/(?:auth|login|logout)(?:\/|$)/.test(value)) return value;
  return null;
}

export function githubSignInHref(destination: string): string {
  return `/api/auth/github?next=${encodeURIComponent(validateReturnTo(destination) || '/admin')}`;
}
