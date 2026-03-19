import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getActiveApiTokenByHash, touchApiTokenLastUsed } from './db';

const DEFAULT_PAGE = 1;

export function parsePaginationParams(
  req: NextRequest,
  options: { defaultLimit: number; maxLimit: number }
): { page: number; limit: number; offset: number } {
  const url = new URL(req.url);
  const pageRaw = Number.parseInt(url.searchParams.get('page') || '', 10);
  const limitRaw = Number.parseInt(url.searchParams.get('limit') || '', 10);

  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : DEFAULT_PAGE;
  const requestedLimit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : options.defaultLimit;
  const limit = Math.min(requestedLimit, options.maxLimit);
  const offset = (page - 1) * limit;

  return { page, limit, offset };
}

function parseBearerToken(req: NextRequest): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;

  const [scheme, token] = header.split(' ');
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;

  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function safeTokenEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function getEnvTokens(): string[] {
  const combined = [process.env.PUBLIC_API_TOKEN, process.env.PUBLIC_API_TOKENS]
    .filter(Boolean)
    .join(',');

  return combined
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function isValidEnvToken(token: string): boolean {
  const envTokens = getEnvTokens();
  return envTokens.some((candidate) => safeTokenEqual(candidate, token));
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateApiToken(): string {
  return `jci_${randomBytes(24).toString('hex')}`;
}

export function getApiTokenPrefix(token: string): string {
  return `${token.slice(0, 10)}...`;
}

export function unauthorizedPublicApiResponse(message = 'Unauthorized') {
  return NextResponse.json(
    {
      error: message,
      docs: '/api/public/openapi.json',
    },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Bearer realm="jean-ci-public-api"',
      },
    }
  );
}

export async function requirePublicApiToken(req: NextRequest): Promise<
  | { authorized: true; source: 'env' | 'db'; tokenId: number | null }
  | { authorized: false; response: NextResponse }
> {
  const token = parseBearerToken(req);
  if (!token) {
    return { authorized: false, response: unauthorizedPublicApiResponse('Missing Bearer token') };
  }

  if (isValidEnvToken(token)) {
    return { authorized: true, source: 'env', tokenId: null };
  }

  const tokenHash = hashApiToken(token);
  const tokenRecord = await getActiveApiTokenByHash(tokenHash);
  if (!tokenRecord) {
    return { authorized: false, response: unauthorizedPublicApiResponse('Invalid API token') };
  }

  await touchApiTokenLastUsed(tokenRecord.id);
  return { authorized: true, source: 'db', tokenId: tokenRecord.id };
}

export const PUBLIC_API_VERSION = 'v1';
export const PUBLIC_API_INFO = {
  title: 'Jean CI Public API',
  version: '1.0.0',
  description: 'Read-only access to Jean CI data without direct database access.',
};
