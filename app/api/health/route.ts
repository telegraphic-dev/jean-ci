import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ 
    status: 'ok', 
    app: 'jean-ci', 
    version: '0.13.0' 
  });
}
