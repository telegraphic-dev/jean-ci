import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { CallToolResult, ClientCapabilities, McpServer } from '@modelcontextprotocol/server';
import {
  createMcpTaskRecord,
  getMcpTaskRecord,
  updateMcpTaskRecord,
  type McpTaskDbRecord,
} from '../db.ts';

export const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';
export const DEFAULT_TASK_TTL_MS = 3_600_000; // 1 hour
export const DEFAULT_TASK_POLL_INTERVAL_MS = 2500;

export type McpTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

export interface McpTaskError {
  code: number;
  message: string;
  data?: unknown;
}

export interface McpTaskRecord {
  taskId: string;
  ownerSubject: string;
  toolName: string;
  status: McpTaskStatus;
  statusMessage?: string | null;
  inputRequests?: Record<string, unknown> | null;
  result?: unknown;
  error?: McpTaskError | null;
  metadata?: Record<string, unknown>;
  ttlMs: number | null;
  pollIntervalMs: number;
  createdAt: string;
  lastUpdatedAt: string;
  expiresAt?: number | null;
}

export interface McpTaskPatch {
  status?: McpTaskStatus;
  statusMessage?: string | null;
  inputRequests?: Record<string, unknown> | null;
  result?: unknown;
  error?: McpTaskError | null;
  metadata?: Record<string, unknown>;
}

export interface McpTaskStore {
  create(input: {
    taskId: string;
    ownerSubject: string;
    toolName: string;
    status?: McpTaskStatus;
    statusMessage?: string | null;
    metadata?: Record<string, unknown>;
    ttlMs?: number | null;
    pollIntervalMs?: number;
  }): Promise<McpTaskRecord>;
  get(taskId: string): Promise<McpTaskRecord | null>;
  update(taskId: string, patch: McpTaskPatch): Promise<McpTaskRecord | null>;
}

const TERMINAL_STATUSES = new Set<McpTaskStatus>(['completed', 'failed', 'cancelled']);

export function isTerminalTaskStatus(status: McpTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function fromDbRecord(row: McpTaskDbRecord): McpTaskRecord {
  return {
    taskId: row.task_id,
    ownerSubject: row.owner_subject,
    toolName: row.tool_name,
    status: row.status,
    statusMessage: row.status_message,
    inputRequests: row.input_requests,
    result: row.result,
    error: row.error,
    metadata: row.metadata ?? {},
    ttlMs: row.ttl_ms,
    pollIntervalMs: row.poll_interval_ms,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    lastUpdatedAt: row.last_updated_at instanceof Date ? row.last_updated_at.toISOString() : String(row.last_updated_at),
    expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null,
  };
}

export function createDbMcpTaskStore(): McpTaskStore {
  return {
    async create(input) {
      const row = await createMcpTaskRecord(input);
      return fromDbRecord(row);
    },
    async get(taskId) {
      const row = await getMcpTaskRecord(taskId);
      return row ? fromDbRecord(row) : null;
    },
    async update(taskId, patch) {
      const row = await updateMcpTaskRecord(taskId, patch);
      return row ? fromDbRecord(row) : null;
    },
  };
}

export class InMemoryMcpTaskStore implements McpTaskStore {
  private readonly records = new Map<string, McpTaskRecord>();

  async create(input: {
    taskId: string;
    ownerSubject: string;
    toolName: string;
    status?: McpTaskStatus;
    statusMessage?: string | null;
    metadata?: Record<string, unknown>;
    ttlMs?: number | null;
    pollIntervalMs?: number;
  }): Promise<McpTaskRecord> {
    const now = new Date().toISOString();
    const ttlMs = input.ttlMs === undefined ? DEFAULT_TASK_TTL_MS : input.ttlMs;
    const record: McpTaskRecord = {
      taskId: input.taskId,
      ownerSubject: input.ownerSubject,
      toolName: input.toolName,
      status: input.status ?? 'working',
      statusMessage: input.statusMessage ?? null,
      inputRequests: null,
      result: undefined,
      error: null,
      metadata: input.metadata ?? {},
      ttlMs,
      pollIntervalMs: input.pollIntervalMs ?? DEFAULT_TASK_POLL_INTERVAL_MS,
      createdAt: now,
      lastUpdatedAt: now,
      expiresAt: ttlMs === null ? null : Date.now() + ttlMs,
    };
    this.records.set(record.taskId, record);
    return { ...record };
  }

  async get(taskId: string): Promise<McpTaskRecord | null> {
    const record = this.records.get(taskId);
    if (!record) return null;
    if (record.expiresAt !== null && record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
      this.records.delete(taskId);
      return null;
    }
    return { ...record };
  }

  async update(taskId: string, patch: McpTaskPatch): Promise<McpTaskRecord | null> {
    const existing = await this.get(taskId);
    if (!existing || isTerminalTaskStatus(existing.status)) {
      return null;
    }
    const updated: McpTaskRecord = {
      ...existing,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.statusMessage !== undefined ? { statusMessage: patch.statusMessage } : {}),
      ...(patch.inputRequests !== undefined ? { inputRequests: patch.inputRequests } : {}),
      ...(patch.result !== undefined ? { result: patch.result } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      lastUpdatedAt: new Date().toISOString(),
    };
    this.records.set(taskId, updated);
    return { ...updated };
  }
}

export function clientSupportsTasks(capabilities?: ClientCapabilities | null): boolean {
  const extensions = capabilities?.extensions as Record<string, unknown> | undefined;
  return Boolean(extensions && Object.prototype.hasOwnProperty.call(extensions, TASKS_EXTENSION_ID));
}

export function toWireTask(task: McpTaskRecord): Record<string, unknown> {
  return {
    taskId: task.taskId,
    status: task.status,
    ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttlMs,
    pollIntervalMs: task.pollIntervalMs,
    ...(task.status === 'input_required' && task.inputRequests ? { inputRequests: task.inputRequests } : {}),
    ...(task.status === 'completed' && task.result !== undefined ? { result: task.result } : {}),
    ...(task.status === 'failed' && task.error ? { error: task.error } : {}),
  };
}

export function toCreateTaskToolResult(task: McpTaskRecord): CallToolResult {
  // Per SEP-2663 (io.modelcontextprotocol/tasks), returning resultType: "task"
  // signals a CreateTaskResult to tasks-capable clients.
  return {
    resultType: 'task',
    ...toWireTask(task),
  } as unknown as CallToolResult;
}

export async function createWorkingMcpTask(
  store: McpTaskStore,
  options: {
    ownerSubject: string;
    toolName: string;
    statusMessage: string;
    metadata?: Record<string, unknown>;
    ttlMs?: number | null;
    pollIntervalMs?: number;
  },
): Promise<McpTaskRecord> {
  return store.create({
    taskId: randomUUID(),
    ownerSubject: options.ownerSubject,
    toolName: options.toolName,
    status: 'working',
    statusMessage: options.statusMessage,
    metadata: options.metadata,
    ttlMs: options.ttlMs ?? DEFAULT_TASK_TTL_MS,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_TASK_POLL_INTERVAL_MS,
  });
}

export interface McpTasksExtensionOptions {
  taskStore: McpTaskStore;
  ownerSubject: string;
  onTaskUpdate?: (task: McpTaskRecord, inputResponses: Record<string, unknown>) => Promise<void>;
  onTaskCancel?: (task: McpTaskRecord) => Promise<void>;
}

const TaskIdParamsSchema = z.object({
  taskId: z.string().min(1),
});

const TaskUpdateParamsSchema = z.object({
  taskId: z.string().min(1),
  inputResponses: z.record(z.string(), z.unknown()).optional(),
});

export function registerMcpTasksExtension(server: McpServer, options: McpTasksExtensionOptions): void {
  const { taskStore, ownerSubject, onTaskUpdate, onTaskCancel } = options;

  server.server.registerCapabilities({
    extensions: {
      [TASKS_EXTENSION_ID]: {},
    },
  });

  async function requireOwnedTask(taskId: string): Promise<McpTaskRecord> {
    const task = await taskStore.get(taskId);
    // Return -32602 (InvalidParams) for both unknown and cross-owner task IDs
    // so callers cannot probe task existence across tokens.
    if (!task || task.ownerSubject !== ownerSubject) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown task: ${taskId}`);
    }
    return task;
  }

  server.server.setRequestHandler(
    'tasks/get',
    { params: TaskIdParamsSchema },
    async ({ taskId }) => {
      const task = await requireOwnedTask(taskId);
      return toWireTask(task);
    },
  );

  server.server.setRequestHandler(
    'tasks/update',
    { params: TaskUpdateParamsSchema },
    async (params, ctx) => {
      const task = await requireOwnedTask(params.taskId);
      const responses =
        params.inputResponses ??
        (ctx.mcpReq.inputResponses as Record<string, unknown> | undefined) ??
        {};
      if (task.status === 'input_required' && onTaskUpdate) {
        await onTaskUpdate(task, responses);
      }
      return {};
    },
  );

  server.server.setRequestHandler(
    'tasks/cancel',
    { params: TaskIdParamsSchema },
    async ({ taskId }) => {
      const task = await requireOwnedTask(taskId);
      if (!isTerminalTaskStatus(task.status)) {
        await taskStore.update(task.taskId, {
          status: 'cancelled',
          statusMessage: 'Cancelled by client request',
          inputRequests: null,
        });
        await onTaskCancel?.(task);
      }
      return {};
    },
  );
}
