/**
 * OpenClaw Gateway WebSocket Client
 * 
 * Feature-flagged WebSocket client for OpenClaw Gateway RPC.
 * Enable with OPENCLAW_USE_WEBSOCKET=true
 * 
 * Provides:
 * - Session deletion via sessions.delete RPC
 * - Full gateway RPC access (future expansion)
 */

import WebSocket from 'ws';
import { randomUUID } from 'crypto';

const PROTOCOL_VERSION = 3;
const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface OpenClawWsConfig {
  /** WebSocket URL (e.g., ws://127.0.0.1:18789 or wss://gateway.example.com) */
  url: string;
  /** Gateway auth token */
  token: string;
  /** Client identifier */
  clientId?: string;
  /** Client version */
  clientVersion?: string;
}

export interface SessionDeleteResult {
  ok: boolean;
  key: string;
  deleted: boolean;
  archived: string[];
}

type RpcRequest = {
  type: 'req';
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

type RpcResponse = {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code?: number; message?: string };
};

type GatewayMessage = RpcResponse | { type: 'event'; event: string; payload?: unknown };

/**
 * Check if WebSocket mode is enabled via environment variable
 */
export function isWebSocketEnabled(): boolean {
  return process.env.OPENCLAW_USE_WEBSOCKET === 'true';
}

/**
 * Get WebSocket URL from environment, converting HTTP URLs to WS
 */
export function getWebSocketUrl(): string | null {
  const url = process.env.OPENCLAW_GATEWAY_URL;
  if (!url) return null;
  
  // Convert http(s):// to ws(s)://
  if (url.startsWith('https://')) {
    return url.replace('https://', 'wss://');
  }
  if (url.startsWith('http://')) {
    return url.replace('http://', 'ws://');
  }
  // Already ws(s)://
  if (url.startsWith('ws://') || url.startsWith('wss://')) {
    return url;
  }
  // Assume ws:// for bare hosts
  return `ws://${url}`;
}

/**
 * One-shot WebSocket RPC call to the gateway
 * Opens connection, authenticates, makes request, closes connection
 */
export async function callGatewayRpc<T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ success: true; result: T } | { success: false; error: string }> {
  const wsUrl = getWebSocketUrl();
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;

  if (!wsUrl || !token) {
    return { success: false, error: 'WebSocket URL or token not configured' };
  }

  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    let settled = false;
    let connectTimer: NodeJS.Timeout | null = null;
    let requestTimer: NodeJS.Timeout | null = null;
    const requestId = randomUUID();

    const cleanup = () => {
      if (connectTimer) clearTimeout(connectTimer);
      if (requestTimer) clearTimeout(requestTimer);
      if (ws) {
        try {
          ws.close();
        } catch {
          // Ignore close errors
        }
      }
    };

    const settle = (result: { success: true; result: T } | { success: false; error: string }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    try {
      ws = new WebSocket(wsUrl);

      connectTimer = setTimeout(() => {
        settle({ success: false, error: `Connection timeout after ${CONNECT_TIMEOUT_MS}ms` });
      }, CONNECT_TIMEOUT_MS);

      ws.on('error', (err) => {
        settle({ success: false, error: `WebSocket error: ${err.message}` });
      });

      ws.on('close', (code, reason) => {
        settle({ success: false, error: `WebSocket closed: ${code} ${reason?.toString() || ''}` });
      });

      ws.on('open', () => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }

        // Send connect request
        const connectReq: RpcRequest = {
          type: 'req',
          id: 'connect-1',
          method: 'connect',
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: 'jean-ci',
              version: process.env.npm_package_version || '1.0.0',
              platform: 'node',
              mode: 'backend',
            },
            role: 'operator',
            scopes: ['operator.read', 'operator.write'],
            caps: [],
            commands: [],
            permissions: {},
            auth: { token },
            locale: 'en-US',
            userAgent: 'jean-ci/1.0.0',
          },
        };
        ws!.send(JSON.stringify(connectReq));
      });

      ws.on('message', (data) => {
        let msg: GatewayMessage;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }

        // Handle connect response
        if (msg.type === 'res' && (msg as RpcResponse).id === 'connect-1') {
          const res = msg as RpcResponse;
          if (!res.ok) {
            settle({ success: false, error: `Connect failed: ${res.error?.message || 'unknown'}` });
            return;
          }

          // Connected successfully, send the actual request
          requestTimer = setTimeout(() => {
            settle({ success: false, error: `Request timeout after ${REQUEST_TIMEOUT_MS}ms` });
          }, REQUEST_TIMEOUT_MS);

          const rpcReq: RpcRequest = {
            type: 'req',
            id: requestId,
            method,
            params,
          };
          ws!.send(JSON.stringify(rpcReq));
          return;
        }

        // Handle the actual request response
        if (msg.type === 'res' && (msg as RpcResponse).id === requestId) {
          const res = msg as RpcResponse;
          if (res.ok) {
            settle({ success: true, result: res.payload as T });
          } else {
            settle({ success: false, error: res.error?.message || 'RPC request failed' });
          }
          return;
        }

        // Ignore other messages (events, challenges, etc.)
      });
    } catch (err) {
      settle({ success: false, error: `Failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}

/**
 * Delete a session via WebSocket RPC
 * 
 * @param sessionKey - The session key to delete (e.g., "agent:main:discord:thread:123")
 * @param options - Optional deletion options
 * @returns Result of the deletion operation
 */
export async function deleteSession(
  sessionKey: string,
  options: {
    /** Archive the transcript file (default: true) */
    deleteTranscript?: boolean;
    /** Emit lifecycle hooks (default: false for cleanup) */
    emitLifecycleHooks?: boolean;
  } = {},
): Promise<{ success: true; result: SessionDeleteResult } | { success: false; error: string }> {
  const { deleteTranscript = true, emitLifecycleHooks = false } = options;

  console.log(`[openclaw-ws] Deleting session: ${sessionKey}`);

  const result = await callGatewayRpc<SessionDeleteResult>('sessions.delete', {
    key: sessionKey,
    deleteTranscript,
    emitLifecycleHooks,
  });

  if (result.success) {
    console.log(`[openclaw-ws] Session deleted: ${sessionKey}, archived: ${result.result.archived?.length || 0} files`);
  } else {
    console.error(`[openclaw-ws] Failed to delete session ${sessionKey}: ${result.error}`);
  }

  return result;
}

/**
 * List sessions via WebSocket RPC (for debugging/monitoring)
 */
export async function listSessions(options: {
  limit?: number;
  activeMinutes?: number;
} = {}): Promise<{ success: true; result: unknown[] } | { success: false; error: string }> {
  return callGatewayRpc<unknown[]>('sessions.list', options);
}
