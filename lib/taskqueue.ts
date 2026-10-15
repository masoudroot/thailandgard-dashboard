import { getSupabase } from './api';
import type { QueuedTask } from './types';
import { TEAMS, type TeamName } from './types';
import { getEndpoint, resolveTeamConfig, InputError } from './llm-endpoints';

/**
 * Task-queue service backed by the existing `build_queue` table.
 * Lifecycle: pending -> approved -> done | rejected
 */
export type TaskQueueStatus =
  | 'pending'
  | 'approved'
  | 'in_progress'
  | 'rejected'
  | 'failed'
  | 'done';

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
  /** شناسه‌ی endpoint انتخاب‌شده برای این کار (settings.llm_endpoints)؛ خالی = پیش‌فرض تیم */
  llm_endpoint_id: string | null;
  /** نام مدل انتخاب‌شده برای این کار؛ خالی = پیش‌فرض تیم */
  llm_model: string | null;
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
  llmEndpointId: string | null;
  llmModel: string | null;
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
    llmEndpointId: row.llm_endpoint_id ?? null,
    llmModel: row.llm_model ?? null,
  };
}

/** ورودی انتخاب مدل برای یک کار. */
export interface TaskLLMSelection {
  endpointId: string;
  model: string;
}

/** اعتبارسنجی انتخاب مدل: endpoint باید وجود داشته باشد و مدل خالی نباشد. */
async function validateTaskLLM(llm: TaskLLMSelection): Promise<void> {
  if (!llm.model.trim()) throw new InputError('نام مدل برای کار خالی است.');
  const ep = await getEndpoint(llm.endpointId);
  if (!ep) throw new InputError('endpoint انتخاب‌شده برای کار وجود ندارد.');
  if (!ep.apiKey) throw new InputError('این endpoint کلید API ندارد.');
}

/** Registers a task in `build_queue` with status=pending. Returns the new row id. */
export async function enqueueTask(
  task: QueuedTask & { team: string; cycleId?: string; llm?: TaskLLMSelection },
): Promise<string> {
  if (task.llm) await validateTaskLLM(task.llm);
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
      llm_endpoint_id: task.llm?.endpointId ?? null,
      llm_model: task.llm?.model.trim() ?? null,
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

/** Reads one task row by id. */
export async function getTask(id: string): Promise<QueuedTaskOutput | null> {
  const { data, error } = await getSupabase()
    .from('build_queue')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getTask failed: ${error.message}`);
  return data ? toOutput(data as QueueRow) : null;
}

/**
 * تغییر مدل یک کار (انتخاب دستی از میان endpointهای تعریف‌شده).
 * با endpointId خالی، انتخاب کار پاک می‌شود و کار به «مدل پیش‌فرض تیم» برمی‌گردد.
 */
export async function setTaskLLM(
  id: string,
  selection: TaskLLMSelection | null,
): Promise<void> {
  if (selection) await validateTaskLLM(selection);
  const { error } = await getSupabase()
    .from('build_queue')
    .update({
      llm_endpoint_id: selection?.endpointId ?? null,
      llm_model: selection?.model.trim() ?? null,
    })
    .eq('id', id);

  if (error) throw new Error(`setTaskLLM failed: ${error.message}`);
}

export interface TaskLLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * پیکربندی واقعی LLM برای اجرای یک کار (سمت سرور؛ کلید کامل برمی‌گرداند).
 * اولویت: انتخاب خود کار > مدل تنظیم‌شده‌ی تیم > null (یعنی متغیرهای محیطی).
 * مجری کار باید نتیجه را به callLLM بدهد تا واقعاً با همین مدل اجرا شود.
 */
export async function resolveTaskLLM(task: {
  team: string;
  llmEndpointId?: string | null;
  llmModel?: string | null;
}): Promise<TaskLLMConfig | null> {
  if (task.llmEndpointId && task.llmModel) {
    try {
      const ep = await getEndpoint(task.llmEndpointId);
      if (ep?.apiKey) {
        return { baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: task.llmModel };
      }
      // endpoint حذف شده؛ به مدل تیم سقوط می‌کنیم
    } catch {
      // خطای DB؛ به مدل تیم سقوط می‌کنیم
    }
  }
  if ((TEAMS as string[]).includes(task.team)) {
    try {
      const cfg = await resolveTeamConfig(task.team as TeamName);
      if (cfg) return cfg;
    } catch {
      // خطای DB؛ null یعنی env
    }
  }
  return null;
}

/* ==========================================================================
 * تنظیمات اجرای کار (execution_mode / parallel)
 *
 * این ترجیح‌ها در جدول agent_state (کلید build_task:prefs:<id>) نگه داشته
 * می‌شوند؛ بدون نیاز به مایگریشن جدید و با همان سازوکار durable موجود.
 * مجری واقعی کار (lib/taskrunner.ts) همین‌ها را می‌خواند.
 * ========================================================================== */

const PREF_KEY_PREFIX = 'build_task:prefs:';

export type TaskExecutionMode = 'now' | 'cycle';

export interface TaskPrefs {
  /** 'now': همین الان اجرا شود؛ 'cycle': برود در چرخه و توسط تیم انجام شود. */
  execution_mode: TaskExecutionMode;
  /** آیا کار با ساب‌ایجنت‌های موازی اجرا شود؟ (به منطق اجرای واقعی وصل است) */
  parallel: boolean;
}

export const DEFAULT_TASK_PREFS: TaskPrefs = { execution_mode: 'cycle', parallel: true };

function prefKey(id: string): string {
  return `${PREF_KEY_PREFIX}${id}`;
}

function normalizePrefs(value: unknown): TaskPrefs {
  const v = (value ?? {}) as Partial<TaskPrefs>;
  return {
    execution_mode: v.execution_mode === 'now' ? 'now' : 'cycle',
    parallel: v.parallel !== false,
  };
}

/** ذخیرهٔ تنظیمات اجرای یک کار. */
export async function saveTaskPrefs(id: string, prefs: Partial<TaskPrefs>): Promise<void> {
  const current = await getTaskPrefs(id).catch(() => DEFAULT_TASK_PREFS);
  const next: TaskPrefs = {
    execution_mode: prefs.execution_mode ?? current.execution_mode,
    parallel: prefs.parallel ?? current.parallel,
  };
  const { error } = await getSupabase()
    .from('agent_state')
    .upsert({ key: prefKey(id), value: next }, { onConflict: 'key' });
  if (error) throw new Error(`saveTaskPrefs failed: ${error.message}`);
}

/** خواندن تنظیمات اجرای یک کار (پیش‌فرض‌ها اگر ثبت نشده باشد). */
export async function getTaskPrefs(id: string): Promise<TaskPrefs> {
  const { data, error } = await getSupabase()
    .from('agent_state')
    .select('value')
    .eq('key', prefKey(id))
    .maybeSingle();
  if (error) throw new Error(`getTaskPrefs failed: ${error.message}`);
  if (!data) return { ...DEFAULT_TASK_PREFS };
  return normalizePrefs((data as { value: unknown }).value);
}

/** خواندن یک‌جای تنظیمات چند کار (یک کوئری). */
export async function listTaskPrefs(ids: string[]): Promise<Record<string, TaskPrefs>> {
  const out: Record<string, TaskPrefs> = {};
  if (ids.length === 0) return out;
  const { data, error } = await getSupabase()
    .from('agent_state')
    .select('key, value')
    .in('key', ids.map(prefKey));
  if (error) throw new Error(`listTaskPrefs failed: ${error.message}`);
  for (const row of (data ?? []) as { key: string; value: unknown }[]) {
    const id = row.key.startsWith(PREF_KEY_PREFIX)
      ? row.key.slice(PREF_KEY_PREFIX.length)
      : row.key;
    out[id] = normalizePrefs(row.value);
  }
  return out;
}

/** کارهای تأییدشدهٔ یک تیم؛ ارکستراتور این‌ها را در چرخهٔ بعدی به زمینهٔ تیم تزریق می‌کند. */
export async function listApprovedTasksForTeam(team: string): Promise<QueuedTaskOutput[]> {
  const { data, error } = await getSupabase()
    .from('build_queue')
    .select('*')
    .eq('team', team)
    .eq('status', 'approved')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listApprovedTasksForTeam failed: ${error.message}`);
  return (data as QueueRow[]).map(toOutput);
}

/**
 * تلاش برای ثبت وضعیت «در حال انجام». اگر دیتابیس این وضعیت را نشناسد
 * (محدودیت قدیمی)، خطا را قورت می‌دهد تا اجرا متوقف نشود؛ وضعیت approved می‌ماند.
 */
export async function markTaskRunning(id: string): Promise<void> {
  const { error } = await getSupabase()
    .from('build_queue')
    .update({ status: 'in_progress' })
    .eq('id', id);
  if (error) console.error(`[taskqueue] markTaskRunning fell back to approved: ${error.message}`);
}

/**
 * ثبت شکست اجرای کار. اول status='failed' امتحان می‌شود؛ اگر دیتابیس قبول
 * نکرد، خطا در ستون result می‌ماند و وضعیت دست‌نخورده می‌ماند (صادقانه).
 */
export async function markTaskFailed(id: string, errorMessage: string): Promise<void> {
  const patch = {
    result: `اجرای کار ناموفق بود: ${errorMessage}`.slice(0, 4000),
    completed_at: new Date().toISOString(),
  };
  const { error } = await getSupabase()
    .from('build_queue')
    .update({ ...patch, status: 'failed' })
    .eq('id', id);
  if (error) {
    console.error(`[taskqueue] markTaskFailed status update failed: ${error.message}`);
    const { error: fallbackError } = await getSupabase()
      .from('build_queue')
      .update(patch)
      .eq('id', id);
    if (fallbackError) console.error(`[taskqueue] markTaskFailed fallback failed: ${fallbackError.message}`);
  }
}
