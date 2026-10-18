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
  | 'deferred'
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
  /** منشأ تسک: planner-weekly | critic | manual | leader */
  source: string | null;
  /** کلید هفتهٔ planner، مثل 2026-W42؛ تسک‌های غیرهفته‌ای نال می‌مانند */
  week_key: string | null;
  /** معیار قبولی تسک؛ متن آزاد */
  acceptance: string | null;
  /** برآورد تلاش: ۱=کم‌ریسک، ۲=متوسط، ۳=سنگین */
  estimate: number | null;
  /** وابستگی به تسک دیگر (build_queue.id)؛ نال یعنی بدون وابستگی */
  depends_on: string | null;
  /** کلید یکتاسازی؛ همراه week_key یکتا می‌شود */
  dedupe_key: string | null;
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
  /** معیار قبولی تسک (متن آزاد) */
  acceptance: string | null;
  /** برآورد تلاش: ۱=کم‌ریسک، ۲=متوسط، ۳=سنگین */
  estimate: number | null;
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
    acceptance: row.acceptance ?? null,
    estimate: row.estimate ?? null,
  };
}

/* ==========================================================================
 * گارد شناسهٔ تسک (رفع باگ ۱۴۰۵/۰۷/۲۵: claim ردیف null)
 *
 * ریشهٔ باگ: تابع دیتابیس claim_next_build_task وقتی صف تیم خالی است،
 * به‌جای null یک ردیفِ all-null برمی‌گرداند؛ در PL/pgSQL متغیر row-type
 * مقداردهی‌نشده با RETURN یک کامپوزیتِ همه‌فیلد-null تولید می‌کند (نه
 * SQL NULL). PostgREST آن را {"id": null, ...} سریالایز می‌کند،
 * maybeSingle() آن را ردیف واقعی می‌پندارد و ارکستراتور در پایان اجرا
 * completeTask را با id=null صدا می‌زند → خطای uuid.
 *
 * قرارداد دفاعی: هیچ شناسهٔ نامعتبر/nullی به توابع نوشتنی صف نمی‌رسد؛
 * claim بدون تسک معتبر یعنی «صف خالی» و با لاگ تمیز رد می‌شود.
 * ========================================================================== */

const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** شناسهٔ تسک فقط وقتی معتبر است که UUID واقعی باشد. */
export function isValidTaskId(id: unknown): id is string {
  return typeof id === 'string' && TASK_ID_RE.test(id);
}

/** گارد ورودی توابع صف: شناسهٔ نامعتبر هرگز به دیتابیس نمی‌رسد. */
function assertValidTaskId(id: unknown, caller: string): asserts id is string {
  if (!isValidTaskId(id)) {
    throw new InputError(`شناسهٔ تسک نامعتبر است (${caller}): ${String(id)}`);
  }
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

/** فیلدهای بک‌لاگ planner (مایگریشن 20261016133600)؛ همه اختیاری‌اند. */
export interface TaskBacklogFields {
  /** منشأ تسک: planner-weekly | critic | manual | leader | tour-manager */
  source?: 'planner-weekly' | 'critic' | 'manual' | 'leader' | 'tour-manager';
  /** کلید هفتهٔ planner، مثل 2026-W42 */
  week_key?: string;
  /** معیار قبولی تسک؛ متن آزاد */
  acceptance?: string;
  /** برآورد تلاش: ۱=کم‌ریسک، ۲=متوسط، ۳=سنگین */
  estimate?: 1 | 2 | 3;
  /** وابستگی به تسک دیگر (build_queue.id) */
  depends_on?: string;
  /** کلید یکتاسازی؛ همراه week_key یکتا می‌شود */
  dedupe_key?: string;
}

/**
 * خطاها را به متن خوانا تبدیل می‌کند. خطاهای supabase-js آبجکت ساده‌اند
 * (instanceof Error == false) و String(err) روی آن‌ها فقط «[object Object]»
 * می‌دهد؛ پس message/code/hint/details را جدا استخراج می‌کنیم.
 *
 * رفع باگ ۱۴۰۵/۰۷/۲۵: خطاهای بی‌پیام لبه (مثلاً آبجکت خالی {}) پیش‌تر به
 * «[object Object]» فروکاسته می‌شدند و علت واقعی گم می‌شد. حالا وضعیت HTTP
 * (که insertRow روی خطا می‌چسباند) استخراج می‌شود و در بدترین حالت هم یک
 * نشانگر خوانا برمی‌گردد، نه «[object Object]».
 */
export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err != null && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof o.message === 'string' && o.message) parts.push(o.message);
    if (typeof o.code === 'string' && o.code) parts.push(`(code: ${o.code})`);
    else if (typeof o.code === 'number') parts.push(`(code: ${o.code})`);
    if (typeof o.hint === 'string' && o.hint) parts.push(`hint: ${o.hint}`);
    if (typeof o.details === 'string' && o.details) parts.push(`details: ${o.details}`);
    // وضعیت HTTP که لایه‌ی دیتابیس روی خطاهای بی‌پیام می‌چسباند
    if (typeof o.status === 'number') {
      const st = typeof o.statusText === 'string' && o.statusText ? ` ${o.statusText}` : '';
      parts.push(`(http: ${o.status}${st})`);
    }
    if (parts.length > 0) return parts.join(' ');
    try {
      const json = JSON.stringify(o);
      if (json && json !== '{}') return json;
    } catch {
      /* ignore */
    }
    // آخرین راه: هرگز «[object Object]» برنگردان
    const ctor = (o as { constructor?: unknown }).constructor;
    const ctorName = typeof ctor === 'function' ? (ctor as { name?: string }).name : undefined;
    if (ctorName && ctorName !== 'Object') return `[خطای ${ctorName} بدون پیام]`;
    return '[خطای بدون پیام از لایه‌ی دیتابیس]';
  }
  return String(err);
}

/** Registers a task in `build_queue` with status=pending. Returns the new row id. */

/**
 * ستون‌های اختیاری build_queue که نبودشان در اسکیما مجاز به تنزل بی‌صداست
 * (fail-soft: ثبت با فیلدهای کمتر به‌جای شکست کامل).
 * درس ممیزی B2 (۱۴۰۵/۰۷/۲۶): تطبیق خام زیررشته‌ای روی پیام خطا («source»)
 * باعث شد «violates check constraint "build_queue_source_check"» هم تنزل
 * بخورد و هر ۳ تسک اول tour-manager بی‌صدا بدون acceptance/estimate ثبت
 * شوند. از این به بعد فقط خطای واقعی «ستون وجود ندارد» تنزل می‌خورد.
 */
const FALLBACK_COLUMNS = new Set([
  'llm_endpoint_id',
  'llm_model',
  'source',
  'week_key',
  'acceptance',
  'estimate',
  'depends_on',
  'dedupe_key',
]);

/**
 * آیا خطا واقعاً «ستون X در build_queue وجود ندارد» است؟
 * پوشش: پستگرس (column "x" of relation ... does not exist / کد 42703) و
 * PostgREST (Could not find the 'x' column ... in the schema cache).
 * نقض check-constraint (مثل build_queue_source_check) عمداً false است تا
 * بلند خطا بدهد، نه اینکه بی‌صدا فیلد بیندازد.
 */
function isMissingColumnError(err: unknown, msg: string): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === '42703') return true;
  const m =
    /(?:column\s+["']?([A-Za-z_][\w$]*)["']?\s+of relation|Could not find the\s+["']?([A-Za-z_][\w$]*)["']?\s+column)/i.exec(
      msg,
    );
  const col = m?.[1] ?? m?.[2] ?? null;
  return col !== null && FALLBACK_COLUMNS.has(col);
}

export async function enqueueTask(
  task: QueuedTask & {
    team: string;
    cycleId?: string;
    llm?: TaskLLMSelection;
  } & Partial<TaskBacklogFields>,
): Promise<string> {
  if (task.llm) await validateTaskLLM(task.llm);
  if (task.estimate != null && ![1, 2, 3].includes(task.estimate)) {
    throw new InputError('برآورد تلاش (estimate) باید ۱، ۲ یا ۳ باشد.');
  }
  if (task.source != null && !['planner-weekly', 'critic', 'manual', 'leader', 'tour-manager'].includes(task.source)) {
    throw new InputError('منشأ تسک (source) نامعتبر است.');
  }
  // B2 فیکس: تسک برای تیم‌های سازنده حتماً باید معیار پذیرش داشته باشد
  const BUILDER_TEAMS_Q = ['content', 'seo', 'design', 'dev'];
  if (BUILDER_TEAMS_Q.includes(task.team) && !String(task.acceptance ?? '').trim()) {
    throw new InputError(`تسک برای تیم ${task.team} باید معیار پذیرش (acceptance) داشته باشد.`);
  }
  const row: Record<string, unknown> = {
    team: task.team,
    run_id: task.cycleId ?? null,
    title: task.title,
    description: task.description,
    files_hint: task.files_hint ? [task.files_hint] : [],
    priority: task.priority ?? 'medium',
    status: 'pending',
    llm_endpoint_id: task.llm?.endpointId ?? null,
    llm_model: task.llm?.model.trim() ?? null,
    source: task.source ?? null,
    week_key: task.week_key ?? null,
    acceptance: task.acceptance ?? null,
    estimate: task.estimate ?? null,
    depends_on: task.depends_on ?? null,
    dedupe_key: task.dedupe_key ?? null,
  };
  const insertRow = async (omit: string[]): Promise<string> => {
    const payload = Object.fromEntries(
      Object.entries(row).filter(([k, v]) => !omit.includes(k) && v !== undefined),
    );
    const { data, error, status, statusText } = await getSupabase()
      .from('build_queue')
      .insert(payload)
      .select('id')
      .single();
    if (error) {
      // رفع باگ ۱۴۰۵/۰۷/۲۵: خطاهای لبه‌ی سوپابیس گاهی آبجکت خالیِ بی‌پیام‌اند ({})؛
      // وضعیت HTTP را به خود خطا می‌چسبانیم تا formatError چیزی برای گفتن داشته باشد
      // و دیگر «enqueueTask failed: [object Object]» دیده نشود.
      throw Object.assign(error, { status, statusText });
    }
    return data.id as string;
  };
  const attempts: string[][] = [
    [],
    ['llm_endpoint_id', 'llm_model'],
    ['llm_endpoint_id', 'llm_model', 'source', 'week_key', 'acceptance', 'estimate', 'depends_on', 'dedupe_key'],
  ];
  let attempt = 0;
  for (;;) {
    try {
      return await insertRow(attempts[attempt]);
    } catch (err) {
      // ستون‌های llm یا بک‌لاگ هنوز migrate نشده‌اند: بدون آن‌ها ثبت کن تا
      // جریان فعلی ثبت کار نشکند؛ فیلدهای حذف‌شده نادیده گرفته می‌شوند.
      // فقط خطای واقعی «ستون نیست» تنزل می‌خورد (isMissingColumnError)؛ بقیهٔ
      // خطاها بلند بالا می‌آیند تا بی‌صدا داده گم نشود (درس ممیزی B2).
      const msg = formatError(err);
      if (isMissingColumnError(err, msg) && attempt + 1 < attempts.length) {
        console.warn(
          `[taskqueue] build_queue misses a fallback column; enqueueing with fewer fields (attempt ${attempt + 2}). cause: ${msg}`,
        );
        attempt += 1;
        continue;
      }
      throw new Error(`enqueueTask failed: ${msg}`);
    }
  }
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
  assertValidTaskId(id, 'approveTask');
  const { error } = await getSupabase()
    .from('build_queue')
    .update({ status: 'approved' })
    .eq('id', id);

  if (error) throw new Error(`approveTask failed: ${error.message}`);
}

/** Marks a pending task as rejected with a reason (stored in `result`). */
export async function rejectTask(id: string, reason: string): Promise<void> {
  assertValidTaskId(id, 'rejectTask');
  const { error } = await getSupabase()
    .from('build_queue')
    .update({ status: 'rejected', result: reason, completed_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw new Error(`rejectTask failed: ${error.message}`);
}

/** Marks an approved task as done with its execution result (and optional commit SHA). */
export async function completeTask(id: string, result: string, commitSha?: string): Promise<void> {
  // گارد ریشه‌ای باگ ۱۴۰۵/۰۷/۲۵: id نامعتبر/null هرگز به کوئری نمی‌رسد.
  assertValidTaskId(id, 'completeTask');
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
  assertValidTaskId(id, 'getTask');
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
  assertValidTaskId(id, 'setTaskLLM');
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
    .upsert({ agent: prefKey(id), state: next }, { onConflict: 'agent' });
  if (error) throw new Error(`saveTaskPrefs failed: ${error.message}`);
}

/** خواندن تنظیمات اجرای یک کار (پیش‌فرض‌ها اگر ثبت نشده باشد). */
export async function getTaskPrefs(id: string): Promise<TaskPrefs> {
  const { data, error } = await getSupabase()
    .from('agent_state')
    .select('state')
    .eq('agent', prefKey(id))
    .maybeSingle();
  if (error) throw new Error(`getTaskPrefs failed: ${error.message}`);
  if (!data) return { ...DEFAULT_TASK_PREFS };
  return normalizePrefs((data as { state: unknown }).state);
}

/** خواندن یک‌جای تنظیمات چند کار (یک کوئری). */
export async function listTaskPrefs(ids: string[]): Promise<Record<string, TaskPrefs>> {
  const out: Record<string, TaskPrefs> = {};
  if (ids.length === 0) return out;
  const { data, error } = await getSupabase()
    .from('agent_state')
    .select('agent, state')
    .in('agent', ids.map(prefKey));
  if (error) throw new Error(`listTaskPrefs failed: ${error.message}`);
  for (const row of (data ?? []) as { agent: string; state: unknown }[]) {
    const id = row.agent.startsWith(PREF_KEY_PREFIX)
      ? row.agent.slice(PREF_KEY_PREFIX.length)
      : row.agent;
    out[id] = normalizePrefs(row.state);
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
  assertValidTaskId(id, 'markTaskRunning');
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
  assertValidTaskId(id, 'markTaskFailed');
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

/* ==========================================================================
 * تحویل اتمیک تسک به تیم (قدم ۳)
 *
 * claimNextTaskForTeam(team): قدیمی‌ترین تسک pending تیم را اتمیک به
 * in_progress می‌برد و برمی‌گرداند.
 *   - idempotent: اگر تیم همین حالا تسک in_progress داشته باشد، همان را
 *     برمی‌گرداند و تسک جدیدی نمی‌دهد.
 *   - ترتیب: priority بالا اول (critical < high < medium < low)، بعد قدیمی‌ترین.
 *   - اتمیک‌بودن با تابع دیتابیس claim_next_build_task تضمین می‌شود
 *     (قفل مشورتی روی نام تیم + FOR UPDATE SKIP LOCKED؛ مایگریشن
 *     20261016134000_build_queue_claim_and_approved.sql).
 * ========================================================================== */

/** رتبه‌بندی اولویت برای مسیر best-effort (وقتی تابع دیتابیس هنوز اعمال نشده). */
const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * مسیر پشتیبان وقتی تابع claim_next_build_task روی دیتابیس نیست (مایگریشن
 * فقط فایل است و هنوز اجرا نشده). غیراتمیک است ولی همان قراردادها را دارد:
 * in_progress فعلی تیم اول، بعد قدیمی‌ترین pending با بالاترین اولویت.
 * فقط وقتی صدا زده می‌شود که خطا «تابع وجود ندارد» باشد؛ بقیه‌ی خطاها throw می‌شوند.
 */
async function claimNextTaskBestEffort(team: string): Promise<QueuedTaskOutput | null> {
  const sb = getSupabase();
  const { data: running, error: runningErr } = await sb
    .from('build_queue')
    .select('*')
    .eq('team', team)
    .eq('status', 'in_progress')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (runningErr) throw new Error(`claimNextTaskBestEffort failed: ${runningErr.message}`);
  if (running) return toOutput(running as QueueRow);

  const { data: candidates, error: candErr } = await sb
    .from('build_queue')
    .select('*')
    .eq('team', team)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(100);
  if (candErr) throw new Error(`claimNextTaskBestEffort failed: ${candErr.message}`);
  const rows = ((candidates ?? []) as QueueRow[]).sort((a, b) => {
    const rank = (p: string) => PRIORITY_RANK[p] ?? 4;
    const d = rank(a.priority) - rank(b.priority);
    return d !== 0 ? d : a.created_at.localeCompare(b.created_at);
  });
  const first = rows[0];
  if (!first) return null;

  // گارد روی status=pending تا مسابقه‌ی دو ورکر فقط به یکی تسک بدهد؛
  // اگر ردیفی به‌روز نشد یعنی ورکر دیگری زودتر claim کرده → null.
  const { data: claimed, error: claimErr } = await sb
    .from('build_queue')
    .update({ status: 'in_progress' })
    .eq('id', first.id)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  if (claimErr) throw new Error(`claimNextTaskBestEffort failed: ${claimErr.message}`);
  const claimedRow = claimed as QueueRow | null;
  // گارد دفاعی: ردیف بدون شناسهٔ معتبر هرگز «تسک» محسوب نمی‌شود.
  if (!claimedRow || !isValidTaskId(claimedRow.id)) return null;
  return toOutput(claimedRow);
}

/**
 * تحویل اتمیک تسک به تیم. null یعنی صف این تیم تسک آماده ندارد.
 * خطای واقعی دیتابیس throw می‌شود؛ نبودن تسک خطا نیست.
 */
export async function claimNextTaskForTeam(team: string): Promise<QueuedTaskOutput | null> {
  const sb = getSupabase();
  try {
    const { data, error } = await sb
      .rpc('claim_next_build_task', { p_team: team })
      .maybeSingle();
    if (error) throw error;
    const row = data as QueueRow | null;
    // گارد ریشه‌ای باگ ۱۴۰۵/۰۷/۲۵: وقتی صف خالی است، تابع دیتابیس یک ردیفِ
    // all-null برمی‌گرداند (id=null)؛ این «تسک» نیست، «صف خالی» است و دور
    // با لاگ تمیز رد می‌شود، نه با claim جعلی و خطای بعدی در completeTask.
    if (!row || !isValidTaskId(row.id)) {
      console.log(`[taskqueue] تیم ${team}: تسک آماده‌ای در صف نیست (claim برگشتی معتبر نداد)؛ رد شد.`);
      return null;
    }
    return toOutput(row);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string })?.code;
    if (code === 'PGRST202' || code === '42883' || /claim_next_build_task/i.test(msg)) {
      console.warn(
        '[taskqueue] claim_next_build_task is not applied on the DB yet; using best-effort claim. Apply migration 20261016134000_build_queue_claim_and_approved.sql.',
      );
      return claimNextTaskBestEffort(team);
    }
    throw new Error(`claimNextTaskForTeam failed: ${msg}`);
  }
}

/* ==========================================================================
 * تأیید خودکار کم‌ریسک (قدم ۳)
 *
 * applyTaskCriticVerdict(id, verdict): حکم منتقد را روی یک کار pending اعمال می‌کند.
 *   - رد => rejected با دلیل (منتظر کسی نمی‌ماند).
 *   - تأیید + estimate=1 (کم‌ریسک) => خودکار approved، بدون انتظار تأیید دستی.
 *   - تأیید + estimate=۲/۳/نال => pending می‌ماند (تأیید دستی لازم است).
 *   - اگر کار دیگر pending نباشد، بی‌اثر است (idempotent).
 * ========================================================================== */

export interface TaskCriticVerdict {
  approved: boolean;
  reason?: string;
}

export async function applyTaskCriticVerdict(
  id: string,
  verdict: TaskCriticVerdict,
): Promise<TaskQueueStatus> {
  const task = await getTask(id);
  if (!task) throw new Error(`کار پیدا نشد: ${id}`);
  const status = task.status as TaskQueueStatus;
  if (status !== 'pending') return status;

  if (!verdict.approved) {
    await rejectTask(id, verdict.reason?.trim() || 'رد شده توسط منتقد');
    return 'rejected';
  }
  if (task.estimate === 1) {
    await approveTask(id);
    console.log(`[taskqueue] task ${id} auto-approved (estimate=1, critic-verified).`);
    return 'approved';
  }
  return 'pending';
}

/* ==========================================================================
 * بستن قطعی تسک تحویل‌شده (رفع ریشه‌ای زامبی‌شدن صف | مشکل ۲)
 *
 * باگ: ارکستراتور تسک را claim می‌کرد (in_progress) ولی شناسه‌اش را فقط برای
 * تزریق متن نگه می‌داشت؛ هیچ مسیری (موفق/ردشده/ناموفق/خطا) آن را به وضعیت
 * نهایی نمی‌رساند و تسک برای همیشه in_progress می‌ماند. چون claimNextTaskForTeam
 * idempotent است، همان تسک زامبی در چرخه‌های بعد دوباره تحویل داده می‌شد و
 * صف عملاً مسموم می‌ماند.
 *
 * قرارداد جدید: هر جا تسکی claim شد، فراخواننده موظف است در پایان اجرا
 * (در finally یا هوک ارکستراتور) settleClaimedTask را صدا بزند. این تابع
 * تسک را با completeTask به done می‌برد و سرنوشت واقعی اجرا را صادقانه در
 * ستون result ثبت می‌کند. دوباره‌فراخوانی برای همان id در یک فرایند بی‌اثر
 * است (گارد once)، پس فراخوانی هم‌زمان از مسیر صریح و finally امن است.
 * ========================================================================== */

/** سرنوشت‌های ممکن یک تسک claimشده در پایان اجرای تیم. */
export type ClaimedTaskOutcome = 'success' | 'rejected' | 'failed' | 'stopped' | 'interrupted';

/**
 * متن فارسی صادقانهٔ نتیجه، بر اساس سرنوشت اجرای تیم.
 * تابع خالص است (بدون IO) تا مستقیم قابل‌تست باشد.
 */
export function buildClaimedTaskResult(
  outcome: ClaimedTaskOutcome,
  detail: { team: string; title: string; summary: string },
): string {
  const head = `تسک «${detail.title}» توسط تیم ${detail.team}`;
  const body = detail.summary.trim() || 'جزئیاتی ثبت نشد.';
  switch (outcome) {
    case 'success':
      return `${head} انجام و تحویل شد.\n${body}`;
    case 'rejected':
      return `${head} اجرا شد ولی منتقد خروجی را نپذیرفت (پس از دورهای بازبینی).\nدلیل: ${body}`;
    case 'failed':
      return `${head} با خطا تمام شد و خروجی نداشت.\nخطا: ${body}`;
    case 'stopped':
      return `${head} توسط کاربر متوقف شد.\n${body}`;
    case 'interrupted':
      return `${head} بدون رسیدن به نقطهٔ پایانی شناخته‌شده تمام شد.\n${body}`;
  }
}

/**
 * گارد once در سطح فرایند: یک id فقط یک‌بار settle می‌شود. شناسه فقط پس از
 * موفقیت واقعی completeTask ثبت می‌شود؛ اگر نوشتن دیتابیس خطا داد، گارد ست
 * نمی‌شود تا تلاش مجدد (مثلاً در finally ارکستراتور) ممکن بماند.
 */
const settledClaimIds = new Set<string>();

/**
 * بستن قطعی تسک claimشده: همیشه completeTask (done)، با ثبت صادقانهٔ
 * سرنوشت در result. خطای دیتابیس throw می‌شود تا فراخواننده ببیند و لاگ کند؛
 * خود تابع هرگز بی‌صدا رد نمی‌شود.
 */
export async function settleClaimedTask(
  id: string,
  outcome: ClaimedTaskOutcome,
  detail: { team: string; title: string; summary: string },
): Promise<void> {
  if (settledClaimIds.has(id)) return;
  await completeTask(id, buildClaimedTaskResult(outcome, detail));
  settledClaimIds.add(id);
}

/**
 * بستن تسک‌های یتیمِ تیمِ ازکارافتاده (مکمل جاروی سلامت).
 *
 * ریشه‌ی باگ (۱۴۰۵/۰۷/۲۵): وقتی فرایند تیم بدون settle می‌میرد (SIGKILL،
 * ری‌بوت ماشین، SIGTERM از timeout)، تسک claimشده برای همیشه in_progress
 * می‌ماند. چون claimNextTaskForTeam اول تسک in_progress تیم را برمی‌گرداند،
 * همان تسک کهنه در چرخه‌ی بعدی دوباره تحویل داده می‌شود و صف عملاً مسموم
 * می‌ماند (مشاهده‌شده در چرخه‌ی run-20261017044522-rq2ho6 پس از ری‌بوت:
 * تسک از چرخه‌ی روز قبل claim شده بود و run_id همان چرخه‌ی قدیمی را داشت).
 *
 * دامنه: تسک‌های in_progress همین تیم که یا به همین چرخه وصل‌اند یا به
 * چرخه‌ای تمام‌شده (یا هیچ چرخه‌ای). تسکِ چرخه‌ی فعالِ دیگر دست‌نخورده
 * می‌ماند تا با فرایند زنده‌ای تداخل نکنیم.
 *
 * بستن با شرط status='in_progress' انجام می‌شود (compare-and-set) تا اگر
 * فرایند زنده‌ای دیرهنگام خودش settle کرد، نتیجه‌ی واقعی‌اش بازنویسی نشود.
 *
 * @returns تعداد تسک‌های بسته‌شده
 */
export async function settleOrphanedClaimedTasks(
  team: string,
  cycleId: string,
  reason: string,
): Promise<number> {
  const sb = getSupabase();
  // چرخه‌های فعال: تسکِ آن‌ها یتیم نیست
  const { data: activeCycles } = await sb
    .from('cycles')
    .select('id')
    .in('status', ['running', 'pausing', 'paused']);
  const activeIds = new Set((activeCycles ?? []).map((c) => (c as { id: string }).id));
  const { data, error } = await sb
    .from('build_queue')
    .select('id, title, run_id')
    .eq('team', team)
    .eq('status', 'in_progress');
  if (error) {
    console.error(`[taskqueue] خواندن تسک‌های یتیم تیم ${team} خطا داد:`, formatError(error));
    return 0;
  }
  let settled = 0;
  for (const row of (data ?? []) as { id: string; title: string; run_id: string | null }[]) {
    if (!isValidTaskId(row.id)) continue;
    const runId = row.run_id ?? null;
    // فقط یتیم‌های واقعی: همین چرخه، بدون چرخه، یا چرخه‌ی تمام‌شده
    if (runId && runId !== cycleId && activeIds.has(runId)) continue;
    try {
      const { data: updated, error: updErr } = await sb
        .from('build_queue')
        .update({
          status: 'done',
          result: buildClaimedTaskResult('interrupted', {
            team,
            title: row.title ?? '',
            summary: reason,
          }),
          completed_at: new Date().toISOString(),
        })
        .eq('id', row.id)
        .eq('status', 'in_progress')
        .select('id');
      if (updErr) {
        console.error(`[taskqueue] بستن تسک یتیم ${row.id} خطا داد:`, formatError(updErr));
        continue;
      }
      if (updated && (updated as unknown[]).length > 0) {
        settled += 1;
        console.log(`[taskqueue] تسک یتیم تیم ${team} با سرنوشت «interrupted» بسته شد (id=${row.id}).`);
      }
    } catch (err) {
      console.error(`[taskqueue] بستن تسک یتیم ${row.id} خطا داد:`, formatError(err));
    }
  }
  return settled;
}
