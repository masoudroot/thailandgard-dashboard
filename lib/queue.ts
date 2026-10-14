/**
 * Durable job queue backed by the `agent_state` key-value table.
 *
 * Every job lives at key `queue:job:<id>` with its JSONB `value` holding the
 * serialized job. No Redis needed:
 *
 * - Claiming is done with a conditional update on the stored status, so two
 *   workers racing on `dequeue()` cannot grab the same job.
 * - A job claimed by a worker carries a lease (`lockedAt` / `expiresAt`,
 *   derived from `timeoutMs`). If the worker dies without calling
 *   `complete()`/`fail()`, the lease expires and `dequeue()` reclaims the job.
 * - `fail()` retries automatically: the job goes back to `pending` until
 *   `attempts` reaches `maxAttempts`, then it becomes `failed`.
 */

import { randomUUID } from 'crypto';
import { getSupabase } from './api';
import type { JobStatus } from './types';

export interface Job {
  id: string;
  type: string;
  payload: any;
  attempts: number;
  maxAttempts: number;
  timeoutMs: number;
  status: JobStatus;
  createdAt: Date;
  error?: string;
}

/** Stored shape: dates are ISO strings inside `agent_state.value`. */
interface JobRow {
  id: string;
  type: string;
  payload: any;
  attempts: number;
  maxAttempts: number;
  timeoutMs: number;
  status: JobStatus;
  createdAt: string;
  error?: string;
  result?: any;
  lockedAt?: string;
  expiresAt?: string;
  finishedAt?: string;
}

export interface FailedJobSummary {
  id: string;
  type: string;
  error?: string;
  attempts: number;
  createdAt: string;
}

export interface QueueStats {
  counts: Record<JobStatus, number>;
  total: number;
  /** Age of the oldest waiting job in ms; null when nothing is pending. */
  oldestPendingAgeMs: number | null;
  /** Up to 10 most recent failures, newest first. */
  failed: FailedJobSummary[];
}

const KEY_PREFIX = 'queue:job:';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_FAILED_SHOWN = 10;
/** How many lost claim races we tolerate per dequeue() call. */
const CLAIM_RETRIES = 5;

function keyFor(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

function toRow(job: Job): JobRow {
  const { createdAt, ...rest } = job;
  return { ...rest, createdAt: createdAt.toISOString() };
}

/** Parses a stored row back into a Job; returns null for foreign/corrupt rows. */
function fromRow(key: string, value: any): Job | null {
  if (!key.startsWith(KEY_PREFIX)) return null;
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Partial<JobRow>;
  const { id, type, attempts, maxAttempts, timeoutMs, status } = row;
  if (typeof id !== 'string' || typeof type !== 'string') return null;
  if (typeof attempts !== 'number' || !Number.isInteger(attempts)) return null;
  if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts)) return null;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) return null;
  if (
    status !== 'pending' &&
    status !== 'running' &&
    status !== 'done' &&
    status !== 'failed'
  ) {
    return null;
  }
  const createdAt = typeof row.createdAt === 'string' ? new Date(row.createdAt) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime())) return null;

  const job: Job = {
    id,
    type,
    payload: row.payload ?? null,
    attempts,
    maxAttempts,
    timeoutMs,
    status,
    createdAt,
  };
  if (typeof row.error === 'string') job.error = row.error;
  return job;
}

interface StoredJob {
  key: string;
  row: JobRow;
}

async function listStored(): Promise<StoredJob[]> {
  const { data, error } = await getSupabase()
    .from('agent_state')
    .select('key, value')
    .like('key', `${KEY_PREFIX}%`)
    .order('key');
  if (error) throw new Error(`queue read failed: ${error.message}`);
  const out: StoredJob[] = [];
  for (const entry of data ?? []) {
    const key = (entry as { key: string }).key;
    const row = (entry as { value: unknown }).value as JobRow;
    if (typeof row === 'object' && row !== null && typeof row.id === 'string') {
      out.push({ key, row });
    }
  }
  return out;
}

async function readStored(id: string): Promise<StoredJob> {
  const { data, error } = await getSupabase()
    .from('agent_state')
    .select('key, value')
    .eq('key', keyFor(id))
    .maybeSingle();
  if (error) throw new Error(`queue read failed: ${error.message}`);
  if (!data) throw new Error(`job not found: ${id}`);
  const row = (data as { value: unknown }).value as JobRow;
  return { key: keyFor(id), row };
}

async function saveRow(row: JobRow): Promise<void> {
  const { error } = await getSupabase()
    .from('agent_state')
    .upsert({ key: keyFor(row.id), value: row }, { onConflict: 'key' });
  if (error) throw new Error(`queue write failed: ${error.message}`);
}

/**
 * Enqueues a new job and returns its id.
 * @throws when the type is empty or the retry/timeout options are invalid.
 */
export async function enqueue(
  type: string,
  payload: any,
  opts?: { maxAttempts?: number; timeoutMs?: number },
): Promise<string> {
  const cleanType = type.trim();
  if (!cleanType) throw new Error('job type is required');
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive number');
  }
  const id = randomUUID();
  const job: Job = {
    id,
    type: cleanType,
    payload: payload ?? null,
    attempts: 0,
    maxAttempts,
    timeoutMs,
    status: 'pending',
    createdAt: new Date(),
  };
  await saveRow(toRow(job));
  return id;
}

/** A row can be claimed when pending, or when a running lease has expired. */
function claimableAt(row: JobRow, now: number): boolean {
  if (row.status === 'pending') return true;
  if (row.status === 'running' && row.expiresAt) {
    const expires = Date.parse(row.expiresAt);
    return !Number.isNaN(expires) && expires <= now;
  }
  return false;
}

/**
 * Atomically marks a stored job as running. The update only applies when the
 * stored status (and lease, for reclaims) is exactly what we read, so a lost
 * race returns null instead of double-claiming.
 */
async function tryClaim(stored: StoredJob): Promise<Job | null> {
  const now = new Date();
  const next: JobRow = {
    ...stored.row,
    status: 'running',
    lockedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + stored.row.timeoutMs).toISOString(),
  };
  const base = getSupabase()
    .from('agent_state')
    .update({ value: next })
    .eq('key', stored.key)
    .eq('value->>status', stored.row.status);
  const query =
    stored.row.status === 'running' && stored.row.expiresAt
      ? base.eq('value->>expiresAt', stored.row.expiresAt)
      : base;
  const { data, error } = await query.select('key');
  if (error) throw new Error(`queue claim failed: ${error.message}`);
  if (!data || data.length === 0) return null; // another worker claimed it
  return fromRow(stored.key, next);
}

/**
 * Takes the oldest claimable job and marks it `running`.
 * Returns null when the queue has no pending (or reclaimable) jobs.
 */
export async function dequeue(): Promise<Job | null> {
  const now = Date.now();
  const candidates = (await listStored())
    .filter((stored) => claimableAt(stored.row, now))
    .sort((a, b) => Date.parse(a.row.createdAt) - Date.parse(b.row.createdAt));
  for (const candidate of candidates.slice(0, CLAIM_RETRIES)) {
    const claimed = await tryClaim(candidate);
    if (claimed) return claimed;
  }
  return null;
}

/** Reads a single job by id; null when it does not exist. */
export async function getJob(id: string): Promise<Job | null> {
  const { data, error } = await getSupabase()
    .from('agent_state')
    .select('key, value')
    .eq('key', keyFor(id))
    .maybeSingle();
  if (error) throw new Error(`queue read failed: ${error.message}`);
  if (!data) return null;
  return fromRow(keyFor(id), (data as { value: unknown }).value);
}

/** Lists every job, oldest first. */
export async function listJobs(): Promise<Job[]> {
  const jobs: Job[] = [];
  for (const stored of await listStored()) {
    const job = fromRow(stored.key, stored.row);
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/**
 * Marks a job as successfully finished and stores its result.
 * @throws when the job does not exist.
 */
export async function complete(id: string, result?: any): Promise<void> {
  const stored = await readStored(id);
  const next: JobRow = {
    ...stored.row,
    status: 'done',
    finishedAt: new Date().toISOString(),
    result: result ?? null,
  };
  delete next.lockedAt;
  delete next.expiresAt;
  await saveRow(next);
}

/**
 * Records a failed attempt. The job goes back to `pending` for another try
 * until `attempts` reaches `maxAttempts`, after which it becomes `failed`.
 * @throws when the job does not exist.
 */
export async function fail(id: string, error: string): Promise<void> {
  const stored = await readStored(id);
  const attempts = stored.row.attempts + 1;
  const exhausted = attempts >= stored.row.maxAttempts;
  const next: JobRow = {
    ...stored.row,
    attempts,
    error,
    status: exhausted ? 'failed' : 'pending',
  };
  delete next.lockedAt;
  delete next.expiresAt;
  if (exhausted) next.finishedAt = new Date().toISOString();
  await saveRow(next);
}

/** Queue health: counts per status, total, oldest pending age, recent failures. */
export async function getQueueStats(): Promise<QueueStats> {
  const jobs = await listJobs();
  const counts: Record<JobStatus, number> = {
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
  };
  const now = Date.now();
  let oldestPendingAgeMs: number | null = null;
  for (const job of jobs) {
    counts[job.status] += 1;
    if (job.status === 'pending') {
      const age = now - job.createdAt.getTime();
      if (oldestPendingAgeMs === null || age > oldestPendingAgeMs) {
        oldestPendingAgeMs = age;
      }
    }
  }
  const failed: FailedJobSummary[] = jobs
    .filter((job) => job.status === 'failed')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, MAX_FAILED_SHOWN)
    .map((job) => ({
      id: job.id,
      type: job.type,
      error: job.error,
      attempts: job.attempts,
      createdAt: job.createdAt.toISOString(),
    }));
  return { counts, total: jobs.length, oldestPendingAgeMs, failed };
}

/**
 * Races a promise against a timer. Rejects with an Error when `ms`
 * elapses first; the timer is always cleared afterwards.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error('timeout ms must be a positive number');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`operation timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
