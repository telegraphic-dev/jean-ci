import { randomUUID } from 'crypto';
import { createLocalReviewRun, getLocalReviewRun, updateLocalReviewRun } from './db';
import { runLocalReview, type LocalReviewRequest, type LocalReviewResponse } from './local-review';

export type LocalReviewRunStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface LocalReviewRunStatusResponse {
  runId: string;
  repo: string;
  status: LocalReviewRunStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: LocalReviewResponse | null;
  error: string | null;
}

export async function enqueueLocalReviewRun(input: LocalReviewRequest): Promise<{ runId: string }> {
  const runId = `lrr_${randomUUID()}`;
  const repo = input.repo.trim();

  await createLocalReviewRun({
    runId,
    repo,
    headSha: input.headSha || null,
    ref: input.ref || null,
    requestPayload: input,
  });

  queueMicrotask(() => {
    void processLocalReviewRun(runId);
  });

  return { runId };
}

export async function processLocalReviewRun(runId: string): Promise<void> {
  const record = await getLocalReviewRun(runId);
  if (!record) return;
  if (record.status !== 'queued') return;

  await updateLocalReviewRun(runId, {
    status: 'running',
    startedAt: new Date(),
  });

  const requestPayload = record.request_payload as LocalReviewRequest;

  try {
    const result = await runLocalReview(requestPayload);
    await updateLocalReviewRun(runId, {
      status: 'completed',
      resultPayload: result,
      completedAt: new Date(),
    });
  } catch (error) {
    await updateLocalReviewRun(runId, {
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : 'Local review failed',
      completedAt: new Date(),
    });
  }
}

export async function getLocalReviewRunStatus(runId: string): Promise<LocalReviewRunStatusResponse | null> {
  const record = await getLocalReviewRun(runId);
  if (!record) return null;

  return {
    runId: record.run_id,
    repo: record.repo,
    status: record.status,
    createdAt: record.created_at.toISOString(),
    startedAt: record.started_at ? record.started_at.toISOString() : null,
    completedAt: record.completed_at ? record.completed_at.toISOString() : null,
    result: (record.result_payload as LocalReviewResponse | null) ?? null,
    error: record.error_message,
  };
}
