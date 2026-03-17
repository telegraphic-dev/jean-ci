const DEFAULT_APP_BASE_URL = 'http://localhost:3000';

function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}

function normalizeOptionalUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    return trimTrailingSlash(new URL(value).toString());
  } catch {
    return null;
  }
}

function normalizeRequiredUrl(value: string | undefined, fallback: string): string {
  return normalizeOptionalUrl(value) || fallback;
}

export const APP_BASE_URL = normalizeRequiredUrl(
  process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL,
  DEFAULT_APP_BASE_URL,
);

const appBase = new URL(APP_BASE_URL);
export const APP_BASE_HOST = appBase.host;
export const APP_BASE_PROTOCOL = appBase.protocol.replace(':', '');

export const COOLIFY_URL = normalizeOptionalUrl(process.env.COOLIFY_URL);
export const COOLIFY_DASHBOARD_URL = normalizeOptionalUrl(
  process.env.COOLIFY_DASHBOARD_URL || process.env.COOLIFY_URL,
);

export const DEFAULT_DEPLOYMENT_DOMAIN = process.env.DEFAULT_DEPLOYMENT_DOMAIN?.trim() || null;
export const DEBUG_PIPELINE_REPO = process.env.DEBUG_PIPELINE_REPO?.trim() || null;

export function buildRepoAppUrl(repoName: string): string {
  if (DEFAULT_DEPLOYMENT_DOMAIN) {
    return `https://${repoName}.${DEFAULT_DEPLOYMENT_DOMAIN}`;
  }
  return APP_BASE_URL;
}

export function getConfigWarnings(): string[] {
  const warnings: string[] = [];

  if ((process.env.COOLIFY_TOKEN || process.env.COOLIFY_DASHBOARD_URL) && !COOLIFY_DASHBOARD_URL) {
    warnings.push('COOLIFY_DASHBOARD_URL is invalid; dashboard links may be missing.');
  }

  if (process.env.COOLIFY_TOKEN && !COOLIFY_URL) {
    warnings.push('COOLIFY_URL is not set or invalid; deployment API calls will fail until it is configured.');
  }

  if (process.env.DEBUG_PIPELINE_REPO && !DEBUG_PIPELINE_REPO?.includes('/')) {
    warnings.push('DEBUG_PIPELINE_REPO should use the format owner/repo.');
  }

  if (process.env.BASE_URL && !normalizeOptionalUrl(process.env.BASE_URL)) {
    warnings.push('BASE_URL is invalid; falling back to http://localhost:3000.');
  }

  if (process.env.NEXT_PUBLIC_BASE_URL && !normalizeOptionalUrl(process.env.NEXT_PUBLIC_BASE_URL)) {
    warnings.push('NEXT_PUBLIC_BASE_URL is invalid; falling back to BASE_URL/http://localhost:3000.');
  }

  return warnings;
}
