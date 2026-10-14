import type { NextRequest } from 'next/server';
import { fail, ok } from '../../../lib/api';
import { enqueue, getQueueStats } from '../../../lib/queue';

export const dynamic = 'force-dynamic';

/** GET /api/queue — queue health: counts per status, total, oldest pending age, recent failures. */
export async function GET(): Promise<Response> {
  try {
    const stats = await getQueueStats();
    return ok(stats);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'failed to read queue stats');
  }
}

interface EnqueueBody {
  type?: unknown;
  payload?: unknown;
  maxAttempts?: unknown;
  timeoutMs?: unknown;
}

/**
 * POST /api/queue — manually enqueue a job (for testing / ops).
 * Body: { type: string, payload?: any, maxAttempts?: number, timeoutMs?: number }
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: EnqueueBody;
  try {
    body = (await request.json()) as EnqueueBody;
  } catch {
    return fail('invalid JSON body', 400);
  }

  const { type, payload, maxAttempts, timeoutMs } = body ?? {};

  if (typeof type !== 'string' || type.trim() === '') {
    return fail('field "type" is required', 400);
  }
  if (
    maxAttempts !== undefined &&
    (!Number.isInteger(maxAttempts) || (maxAttempts as number) < 1)
  ) {
    return fail('maxAttempts must be a positive integer', 400);
  }
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
  ) {
    return fail('timeoutMs must be a positive number', 400);
  }

  try {
    const jobId = await enqueue(type.trim(), payload ?? null, {
      ...(maxAttempts !== undefined ? { maxAttempts: maxAttempts as number } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs: timeoutMs as number } : {}),
    });
    return ok({ jobId }, 201);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'failed to enqueue job');
  }
}
