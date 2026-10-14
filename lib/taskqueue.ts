import { getSupabase } from './api';
import type { QueuedTask } from './types';

/**
 * Task-queue service backed by the existing `build_queue` table.
 * Lifecycle: pending -> approved -> done | rejected
 */
export type TaskQueueStatus = 'pending' | 'approved' | 'rejected' | 'done';

export interface QueueRow {
  id: string;
  team: string;
  run_id: string | null;
  title: string;
  description: string;
  files_hint: string[];
  priority: QueuedTask['priority'];
  status: string;
  result: string | null;
  commit_sha: string | null;
  created_at: string;
  completed_at: string | null;
  phase: string | null;
  phase_order: number;
}

export interface QueuedTaskOutput extends Omit<QueuedTask, 'files_hint'> {
  id: string;
  team: string;
  run_id: string | null;
  files_hint: string;
  status: string;
  result: string | null;
  commit_sha: string | null;
  created_at: string;
  completed_at: string | null;
}

/** Normalize a DB row into the domain-friendly shape (files_hint array -> string). */
function toOutput(row: QueueRow): QueuedTaskOutput {
  return {
    id: row.id,
    team: row.team,
    run_id: row.run_id,
    title: row.title,
    description: row.description,
    files_hint: (row.files_hint ?? []).join('\n'),
    priority: row.priority,
    status: row.status,
    result: row.result,
    commit_sha: row.commit_sha,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

/** Registers a task in `build_queue` with status=pending. Returns the new row id. */
export async function enqueueTask(
  task: QueuedTask & { team: string; cycleId?: string },
): Promise<string> {
  const { data, error } = await getSupabase()
    .from('build_queue')
    .insert({
      team: task.team,
      run_id: task.cycleId ?? null,
      title: task.title,
      description: task.description,
      files_hint: task.files_hint ? [task.files_hint] : [],
      priority: task.priority ?? 'medium',
      status: 'pending',
    })
    .select('id')
    .single();

  if (error) throw new Error(`enqueueTask failed: ${error.message}`);
  return data.id as string;
}

/** Reads the queue, newest first. Optionally filtered by status. */
export async function listTasks(status?: string): Promise<QueuedTaskOutput[]> {
  let query = getSupabase()
    .from('build_queue')
    .select('*')
    .order('created_at', { ascending: false });

  if (status) {
    query = query.eq('status', status);
  }

  const { data, error } = await query;
  if (error) throw new Error(`listTasks failed: ${error.message}`);
  return (data as QueueRow[]).map(toOutput);
}

/** Marks a pending task as approved for execution. */
export async function approveTask(id: string): Promise<void> {
  const { error } = await getSupabase()
    .from('build_queue')
    .update({ status: 'approved' })
    .eq('id', id);

  if (error) throw new Error(`approveTask failed: ${error.message}`);
}

/** Marks a pending task as rejected with a reason (stored in `result`). */
export async function rejectTask(id: string, reason: string): Promise<void> {
  const { error } = await getSupabase()
    .from('build_queue')
    .update({ status: 'rejected', result: reason, completed_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw new Error(`rejectTask failed: ${error.message}`);
}

/** Marks an approved task as done with its execution result (and optional commit SHA). */
export async function completeTask(id: string, result: string, commitSha?: string): Promise<void> {
  const { error } = await getSupabase()
    .from('build_queue')
    .update({
      status: 'done',
      result,
      commit_sha: commitSha ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (error) throw new Error(`completeTask failed: ${error.message}`);
}
