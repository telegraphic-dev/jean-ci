import { NextResponse } from 'next/server';
import { buildPublicOpenApiSpec } from '@/lib/public-openapi';

export async function GET() {
  return NextResponse.json(buildPublicOpenApiSpec());
}
