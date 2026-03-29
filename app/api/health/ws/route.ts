import { NextResponse } from 'next/server';
import WebSocket, { WebSocketServer } from 'ws';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function verifyMaskedClientSend(): Promise<{ ok: boolean; received: string | null; error: string | null }> {
  const port = 45000 + Math.floor(Math.random() * 1000);
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });

  try {
    const result = await new Promise<{ ok: boolean; received: string | null; error: string | null }>((resolve) => {
      let settled = false;

      const finish = (value: { ok: boolean; received: string | null; error: string | null }) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const timeout = setTimeout(() => {
        finish({ ok: false, received: null, error: 'timeout waiting for websocket roundtrip' });
      }, 3000);

      wss.once('connection', (socket) => {
        socket.once('message', (data) => {
          clearTimeout(timeout);
          finish({ ok: true, received: data.toString(), error: null });
          socket.close();
        });
      });

      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      client.once('open', () => {
        try {
          client.send('mask-check');
        } catch (error) {
          clearTimeout(timeout);
          finish({ ok: false, received: null, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
        }
      });
      client.once('error', (error) => {
        clearTimeout(timeout);
        finish({ ok: false, received: null, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
      });
    });

    return result;
  } finally {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}

export async function GET() {
  const wsAny = WebSocket as any;
  const roundtrip = await verifyMaskedClientSend();

  return NextResponse.json({
    ok: roundtrip.ok,
    wsVersion: wsAny?.VERSION ?? null,
    env: {
      WS_NO_BUFFER_UTIL: process.env.WS_NO_BUFFER_UTIL ?? null,
      WS_NO_UTF_8_VALIDATE: process.env.WS_NO_UTF_8_VALIDATE ?? null,
      NODE_ENV: process.env.NODE_ENV ?? null,
    },
    roundtrip,
  });
}
