/**
 * ارکستراتور چرخه: مدیریت چرخه‌های ۱۵ تیم در ۶ موج.
 *
 * معماری: ورسل فقط داشبورد و API مدیریتی است. اجرای تیم‌ها با
 * ورکر گیت‌هاب اکشنز (worker/cycle-worker.ts) انجام می‌شود که در هر
 * اجرا فقط یک تیم را اجرا می‌کند (runSingleTeam).
 *
 * جریان یک چرخه:
 *   1. beginCycle: ساخت run_id یکتا + گرفتن قفل سراسری (agent_state)
 *      + ساخت ردیف cycles
 *   2. ورکر گیت‌هاب: اجرای تک‌تک تیم‌ها (runSingleTeam)
 *   3. finishCycle: آزاد کردن قفل + ثبت وضعیت نهایی cycles
 *
 * هر تیم با تابع runTeam از ماژول lib/teams/<team>.ts (ایمپورت داینامیک)
 * اجرا می‌شود. اگر ماژول تیم هنوز ساخته نشده باشد، اجرای آن تیم با
 * خطای واضح fail می‌شود ولی بقیه‌ی تیم‌ها ادامه می‌دهند.
 */
import { getSupabase } from './api';
import { runKnowledgeSubagent } from './knowledge-subagent';
import { runWithTeamContext } from './llm';
import { notifyTeamReport } from './notify';
import { listApprovedTasksForTeam } from './taskqueue';
import {
  ACTIVE_CYCLE_STATUSES,
  normalizeCycleStatus,
  WAVES,
  type CycleStatus,
  type MemoryEntry,
  type PatchFile,
  type ProgressReporter,
  type SubagentControl,
  type TeamName,
  type TeamResult,
  type TeamRunStatus,
} from './types';

const LOCK_KEY = 'orchestrator:lock';
/** A lock counts as "someone else is running" only while running and younger than this. */
const LOCK_TTL_MINUTES = 150;
/** How often a paused cycle re-reads its status while waiting for resume/cancel. */
const PAUSE_POLL_MS = 5000;

export class CycleLockedError extends Error {}

/** وقتی کاربر ساب‌ایجنت را متوقف می‌کند، در مرز مرحله‌ی بعدی پرتاب می‌شود. */
export class SubagentStoppedError extends Error {
  constructor(public readonly stage: string) {
    super(`subagent stopped by user at stage: ${stage}`);
  }
}

/** برچسب‌هایی که مرحله‌ی واقعی نیستند و ساب‌ایجنت جدا نمی‌خواهند. */
const PSEUDO_TASKS = new Set(['شروع اجرا', 'پایان کار', 'خطا در اجرا']);
/** هر چند وقت یک‌بار ردیف team_runsِ تیمِ در حال اجرا لمس می‌شود (میلی‌ثانیه). */
const HEARTBEAT_MS = 60_000;
/** گزارش‌های پیشرفت تکراری/خیلی نزدیک به هم ادغام می‌شوند. */
const PROGRESS_MIN_INTERVAL_MS = 2000;
/** فاصله‌ی نظرسنجی سیگنال کنترلی وقتی ساب‌ایجنت متوقف‌شده (pause) است. */
const CONTROL_POLL_MS = 5000;
/** سقف انتظار برای ادامه‌یافتن (resume) یک ساب‌ایجنت متوقف‌شده: ۳۰ دقیقه. */
const PAUSE_TIMEOUT_MS = 30 * 60_000;

/** ورودی استاندارد هر تیم. */
export interface TeamInput {
  cycleId: string;
  runId: string;
  /** زمینه‌ی متنی از خروجی موج‌های قبلی همین چرخه. */
  ragContext: string;
  /** حافظه‌ی ذخیره‌شده‌ی تیم از چرخه‌های قبلی (جدول team_memory). */
  memory: MemoryEntry[];
  /** خروجی کامل موج‌های قبلی: team -> TeamResult (یا null برای تیم‌های fail/skipped). */
  previousWavesOutput: Record<string, TeamResult | null>;
  /**
   * گزارش زنده‌ی پیشرفت به ارکستر: تیم در مرز مرحله‌هایش صدا می‌زند و
   * ارکستر آن را در team_runs (progress/current_task) می‌نویسد و ساب‌ایجنت‌ها
   * را مدیریت می‌کند.
   */
  reportProgress: ProgressReporter;
}

type RunTeamFn = (input: TeamInput) => Promise<TeamResult>;

/** ساخت run_id یکتا: run-YYYYMMDDHHMMSS-xxxxxx */
function makeRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(
    d.getUTCHours(),
  )}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 8);
  return `run-${stamp}-${rand}`;
}

interface LockRow {
  state:
    | {
        status?: string;
        run_id?: string;
        cycle_id?: string;
        started_at?: string;
        paused?: boolean;
      }
    | null;
  updated_at: string;
}

async function readLock(): Promise<LockRow | null> {
  const { data, error } = await getSupabase()
    .from('agent_state')
    .select('state, updated_at')
    .eq('agent', LOCK_KEY)
    .maybeSingle();
  if (error) throw new Error(`failed to read orchestrator lock: ${error.message}`);
  return data as LockRow | null;
}

async function writeLock(state: Record<string, unknown>): Promise<void> {
  const { error } = await getSupabase()
    .from('agent_state')
    .upsert(
      { agent: LOCK_KEY, state, updated_at: new Date().toISOString() },
      { onConflict: 'agent' },
    );
  if (error) throw new Error(`failed to write orchestrator lock: ${error.message}`);
}

async function acquireLock(runId: string): Promise<void> {
  const existing = await readLock();
  if (existing?.state?.status === 'running') {
    const ref =
      existing.updated_at || existing.state.started_at || new Date(0).toISOString();
    const ageMin = (Date.now() - new Date(ref).getTime()) / 60000;
    if (ageMin < LOCK_TTL_MINUTES) {
      throw new CycleLockedError(
        `another cycle is already running (run_id=${existing.state.run_id ?? 'unknown'}, age=${Math.round(
          ageMin,
        )}m); wait for it to finish or for the ${LOCK_TTL_MINUTES}-minute stale-lock window to pass`,
      );
    }
  }
  await writeLock({
    status: 'running',
    run_id: runId,
    started_at: new Date().toISOString(),
  });
}

/** فقط قفل گرفتن + ساخت ردیف cycles (بدون اجرای موج‌ها). */
export async function beginCycle(): Promise<{ cycleId: string; runId: string }> {
  const runId = makeRunId();
  await acquireLock(runId);
  const sb = getSupabase();
  const { data, error } = await sb
    .from('cycles')
    .insert({ run_id: runId, status: 'running' })
    .select('id')
    .single();
  if (error) {
    await writeLock({ status: 'idle', run_id: runId, released_at: new Date().toISOString() });
    throw new Error(`failed to create cycle row: ${error.message}`);
  }
  const cycleId = data.id as string;
  await writeLock({
    status: 'running',
    run_id: runId,
    cycle_id: cycleId,
    started_at: new Date().toISOString(),
  });
  return { cycleId, runId };
}

/* ==========================================================================
 * کنترل چرخه: توقف نرم (graceful)، ادامه از همان نقطه، لغو.
 *
 * منطق اجرا (نه فقط لیبل UI) به وضعیت دیتابیس گوش می‌دهد:
 *  - requestPause: running -> pausing. حلقه‌ی اجرا بین موج‌ها این را می‌بیند،
 *    تیم‌های موج جاری را تا انتها می‌دوند (graceful)، بعد وضعیت را paused
 *    می‌کند و بدون شروع موج بعدی منتظر می‌ماند.
 *  - resumeCycle: paused -> running. اگر حلقه‌ی درون‌حافظه‌ای زنده باشد همان
 *    حلقه از همان موج ادامه می‌دهد؛ اگر سرور ری‌استارت شده بود، موج‌های
 *    باقی‌مانده در پس‌زمینه از همان نقطه از سر گرفته می‌شوند.
 *  - cancelCycle: فعال -> canceled و آزاد شدن قفل. حلقه‌ی اجرا در اولین
 *    ایست‌بازرسی، چرخه را با وضعیت canceled می‌بندد.
 * ========================================================================== */

/** خواندن وضعیت فعلی چرخه از دیتابیس (نرمال‌شده). */
async function readCycleStatus(cycleId: string): Promise<CycleStatus | null> {
  const { data, error } = await getSupabase()
    .from('cycles')
    .select('status')
    .eq('id', cycleId)
    .maybeSingle();
  if (error || !data) return null;
  return normalizeCycleStatus((data as { status: string }).status);
}

async function setCycleStatus(cycleId: string, status: CycleStatus): Promise<void> {
  const { error } = await getSupabase().from('cycles').update({ status }).eq('id', cycleId);
  if (error) throw new Error(`failed to set cycle status: ${error.message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function touchPausedLock(cycleId: string, runId: string | null): Promise<void> {
  await writeLock({
    status: 'running',
    paused: true,
    run_id: runId,
    cycle_id: cycleId,
    paused_at: new Date().toISOString(),
  });
}

/**
 * ایست‌بازرسی قبل از هر موج. اگر توقف خواسته شده بود، graceful صبر می‌کند
 * تا ادامه یا لغو برسد. خروجی 'canceled' یعنی چرخه باید بسته شود.
 */
async function checkpointBeforeWave(
  cycleId: string,
  runId: string,
): Promise<'continue' | 'canceled'> {
  let status = await readCycleStatus(cycleId);
  if (status === 'canceled') return 'canceled';
  if (status === 'pausing') {
    await setCycleStatus(cycleId, 'paused');
    status = 'paused';
  }
  if (status === 'paused') {
    // تیم‌های موج جاری تمام شده‌اند؛ موج بعدی شروع نمی‌شود تا ادامه یا لغو برسد.
    for (;;) {
      await touchPausedLock(cycleId, runId);
      await sleep(PAUSE_POLL_MS);
      const s = await readCycleStatus(cycleId);
      if (s === 'canceled') return 'canceled';
      if (s === 'running') return 'continue';
      // در غیر این صورت (paused/pausing) همچنان منتظر می‌مانیم.
    }
  }
  return 'continue';
}

/** درخواست توقف نرم: فقط از وضعیت running به pausing می‌رود. */
export async function requestPause(cycleId: string): Promise<void> {
  const status = await readCycleStatus(cycleId);
  if (status === null) throw new Error('چرخه پیدا نشد.');
  if (status === 'paused' || status === 'pausing') return; // از قبل متوقف است
  if (status !== 'running') {
    throw new Error(`فقط چرخهٔ در حال اجرا را می‌توان متوقف کرد (وضعیت فعلی: ${status}).`);
  }
  await setCycleStatus(cycleId, 'pausing');
}

/** ادامهٔ چرخهٔ متوقف‌شده از همان نقطه. */
export async function resumeCycle(cycleId: string): Promise<void> {
  const sb = getSupabase();
  const { data: cycle, error } = await sb
    .from('cycles')
    .select('run_id, status')
    .eq('id', cycleId)
    .maybeSingle();
  if (error || !cycle) throw new Error('چرخه پیدا نشد.');
  const row = cycle as { run_id: string; status: string };
  const status = normalizeCycleStatus(row.status);
  if (status === 'running') return; // از قبل در حال اجراست
  if (status !== 'paused' && status !== 'pausing') {
    throw new Error(`فقط چرخهٔ متوقف‌شده را می‌توان ادامه داد (وضعیت فعلی: ${status}).`);
  }
  await setCycleStatus(cycleId, 'running');

  // قفل را تازه می‌کنیم تا ورکر گیت‌هاب اکشنز در تیک بعدی چرخه را ادامه دهد.
  // اجرا روی ورسل انجام نمی‌شود؛ ورسل فقط داشبورد و API مدیریتی است.
  await writeLock({
    status: 'running',
    run_id: row.run_id,
    cycle_id: cycleId,
    resumed_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
  });
}

/** لغو چرخهٔ فعال: وضعیت canceled + آزاد شدن قفل. حلقه‌ی اجرا در اولین ایست‌بازرسی می‌ایستد. */
export async function cancelCycle(cycleId: string): Promise<void> {
  const status = await readCycleStatus(cycleId);
  if (status === null) throw new Error('چرخه پیدا نشد.');
  if (status === 'canceled') return;
  if (!ACTIVE_CYCLE_STATUSES.includes(status)) {
    throw new Error(`این چرخه دیگر فعال نیست (وضعیت فعلی: ${status}).`);
  }
  const sb = getSupabase();
  const { error } = await sb
    .from('cycles')
    .update({
      status: 'canceled',
      finished_at: new Date().toISOString(),
      error: 'لغو شده توسط کاربر',
    })
    .eq('id', cycleId);
  if (error) throw new Error(`failed to cancel cycle: ${error.message}`);
  await writeLock({
    status: 'canceled',
    cycle_id: cycleId,
    finished_at: new Date().toISOString(),
  });
}

/** آیا چرخهٔ فعالی (running/pausing/paused) در دیتابیس هست؟ */
export async function findActiveCycle(): Promise<{
  id: string;
  run_id: string;
  status: CycleStatus;
} | null> {
  const { data, error } = await getSupabase()
    .from('cycles')
    .select('id, run_id, status')
    .in('status', ACTIVE_CYCLE_STATUSES)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { id: string; run_id: string; status: string };
  return { id: row.id, run_id: row.run_id, status: normalizeCycleStatus(row.status) };
}

/** ایمپورت داینامیک ماژول تیم؛ اگر ماژول نیست، خطای واضح می‌دهد (بلاک نمی‌شود). */
async function loadRunTeam(team: TeamName): Promise<RunTeamFn> {
  try {
    const mod = (await import(`./teams/${team}`)) as { runTeam?: unknown };
    if (typeof mod.runTeam !== 'function') {
      throw new Error(`does not export an async runTeam(input) function`);
    }
    return mod.runTeam as RunTeamFn;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `cannot run team "${team}": failed to load lib/teams/${team}.ts (${reason}). ` +
        `Make sure lib/teams/${team}.ts exists and exports async runTeam(input).`,
    );
  }
}

/** حافظه‌ی تیم از جدول team_memory (آخرین ورودی‌های هر kind). */
async function loadTeamMemory(team: TeamName): Promise<MemoryEntry[]> {
  try {
    const { data, error } = await getSupabase()
      .from('team_memory')
      .select('team, kind, content')
      .eq('team', team)
      .order('created_at', { ascending: false })
      .limit(30);
    if (error || !data) return [];
    const seen = new Set<string>();
    const out: MemoryEntry[] = [];
    for (const row of data as { team: string; kind: string; content: string }[]) {
      if (seen.has(row.kind)) continue;
      seen.add(row.kind);
      out.push({ team: row.team as TeamName, key: row.kind, value: row.content });
    }
    return out;
  } catch {
    return [];
  }
}

/** زمینه‌ی متنی از خلاصه‌ی خروجی موج‌های قبلی. */
function buildRagContext(previousWavesOutput: Record<string, TeamResult | null>): string {
  const lines: string[] = [];
  for (const [team, result] of Object.entries(previousWavesOutput)) {
    if (result?.summary) lines.push(`- ${team}: ${result.summary}`);
  }
  return lines.join('\n');
}

interface WaveCtx {
  runId: string;
  previousWavesOutput: Record<string, TeamResult | null>;
}

export interface RunWavesOptions {
  /** تیم‌هایی که رد می‌شوند؛ کلید به شکل `${wave}:${team}` (برای ادامه از همان نقطه). */
  skip?: Set<string>;
  /**
   * خروجی تیم‌های از قبل تمام‌شده در ادامهٔ چرخه؛ فقط برای موج‌های قبل‌تر
   * از موج جاری به زمینه اضافه می‌شود.
   */
  prefill?: Map<string, { wave: number; result: TeamResult | null }>;
}

/**
 * ثبت پچ پیشنهادی تیم در جدول bridge_patches با وضعیت proposed.
 * طرح جدول (ساختهٔ مهندس دیتابیس، supabase/migrations/20261015200000_bridge_patches.sql):
 * یک ردیف برای هر تیم در هر چرخه؛ files آرایهٔ JSON از {path, content} است.
 * اگر جدول هنوز اعمال نشده (خطای 42P01)، فقط در لاگ ثبت می‌شود؛
 * این قدم هرگز نتیجهٔ تیم را خراب نمی‌کند.
 * برمی‌گرداند: شناسهٔ ردیف پچ، یا null اگر ثبتی انجام نشد.
 */
async function registerProposedPatches(
  sb: ReturnType<typeof getSupabase>,
  opts: {
    team: TeamName;
    cycleId: string;
    runId: string;
    summary: string;
    patches: PatchFile[] | undefined;
  },
): Promise<string | null> {
  const files = (opts.patches ?? [])
    .filter(
      (p) =>
        p &&
        typeof p.path === 'string' &&
        p.path.trim().length > 0 &&
        typeof p.content === 'string',
    )
    .map((p) => ({
      path: p.path.trim().replace(/^\/+/, ''),
      content: p.content,
    }));
  if (files.length === 0) return null;
  const { data, error } = await sb
    .from('bridge_patches')
    .insert({
      team: opts.team,
      cycle_id: opts.cycleId,
      summary: opts.summary.slice(0, 2000),
      files,
      status: 'proposed',
    })
    .select('id')
    .single();
  if (error) {
    // 23505 = پچ این تیم در این چرخه از قبل ثبت شده (تلاش مجدد ورکر)؛
    // به‌جای خطا، شناسهٔ ردیف موجود را برمی‌گردانیم تا پچ تکراری ساخته نشود.
    if (error.code === '23505') {
      const { data: existing } = await sb
        .from('bridge_patches')
        .select('id')
        .eq('team', opts.team)
        .eq('cycle_id', opts.cycleId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      const existingId = (existing as { id?: string } | null)?.id ?? null;
      console.log(
        `[orchestrator] پچ تیم ${opts.team} در چرخه ${opts.runId} از قبل ثبت شده بود (id=${existingId})؛ ثبت تکراری رد شد.`,
      );
      return existingId;
    }
    if (error.code === '42P01') {
      console.error(
        `[orchestrator][DB-ENGINEER] جدول bridge_patches هنوز اعمال نشده؛ ` +
          `${files.length} فایل پیشنهادی تیم ${opts.team} در چرخه ${opts.runId} ثبت نشد. ` +
          `مهندس دیتابیس: مایگریشن supabase/migrations/20261015200000_bridge_patches.sql را اعمال کن.`,
      );
    } else {
      console.error(
        `[orchestrator] ثبت bridge_patches برای تیم ${opts.team} خطا داد:`,
        error.message,
      );
    }
    return null;
  }
  const patchId = (data as { id?: string } | null)?.id ?? null;
  console.log(
    `[orchestrator] پچ پیشنهادی تیم ${opts.team} (${files.length} فایل) در bridge_patches با وضعیت proposed ثبت شد (id=${patchId}).`,
  );
  return patchId;
}

/**
 * پردازش خودکار پچ پل: دروازه کیفیت ← کامیت ← مرج خودکار به dev.
 * دستور مسعود: بدون تأیید دستی. کاملاً best-effort؛ هرگز نتیجهٔ تیم را خراب نمی‌کند.
 */
async function autoProcessBridgePatch(patchId: string, team: TeamName): Promise<void> {
  try {
    const { processProposedPatch } = await import('./bridge/propose');
    const res = await processProposedPatch(patchId);
    if (!res.gated) {
      console.log(
        `[orchestrator] پچ ${patchId} تیم ${team} در دروازه رد شد (needs_review)؛ چرخه ادامه می‌یابد.`,
      );
      return;
    }
    if (res.merged) {
      console.log(
        `[orchestrator] پچ ${patchId} تیم ${team} خودکار به dev مرج شد (merge_sha=${res.mergeSha ?? 'already'}).`,
      );
    } else {
      console.log(
        `[orchestrator] پچ ${patchId} تیم ${team} کامیت شد ولی مرج خودکار ناموفق بود: ${res.mergeError ?? 'نامشخص'}.`,
      );
    }
  } catch (err) {
    console.error(
      `[orchestrator] پردازش خودکار پچ ${patchId} تیم ${team} خطا داد:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** اجرای یک تیم و ثبت نتیجه در team_runs. خطا => team_run=failed، ولی موج ادامه می‌یابد. */
export async function runSingleTeam(
  cycleId: string,
  team: TeamName,
  wave: number,
  ctx: WaveCtx,
  teamRunId?: string,
): Promise<TeamResult | null> {
  const sb = getSupabase();
  let runRowId: string;
  if (teamRunId) {
    // ردیف از قبل با claimTeam اتمیک ساخته شده؛ فقط استفاده کن
    runRowId = teamRunId;
  } else {
    const { data: runRow, error: insertErr } = await sb
      .from('team_runs')
      .insert({ cycle_id: cycleId, team, wave, status: 'running' })
      .select('id')
      .single();
    if (insertErr || !runRow) {
      throw new Error(`failed to create team_runs row for ${team}: ${insertErr?.message}`);
    }
    runRowId = runRow.id as string;
  }

  const finish = async (patch: Record<string, unknown>) => {
    const { error } = await sb
      .from('team_runs')
      .update({ ...patch, finished_at: new Date().toISOString() })
      .eq('id', runRowId);
    if (error) console.error(`[orchestrator] failed to update team_run ${runRowId}:`, error.message);
  };

  /** بستن همه‌ی ساب‌ایجنت‌های باز این اجرا با وضعیت نهایی. */
  const closeSubagents = async (status: 'success' | 'failed' | 'stopped') => {
    const { error } = await sb
      .from('subagents')
      .update({ status, finished_at: new Date().toISOString() })
      .eq('team_run_id', runRowId)
      .in('status', ['pending', 'running', 'paused']);
    if (error) console.error(`[orchestrator] failed to close subagents of ${runRowId}:`, error.message);
  };

  /** خواندن سیگنال کنترلی یک ساب‌ایجنت (run/pause/stop). */
  const readControl = async (subagentId: string): Promise<SubagentControl> => {
    const { data } = await sb.from('subagents').select('control').eq('id', subagentId).maybeSingle();
    const control = (data as { control?: string } | null)?.control;
    return control === 'pause' || control === 'stop' ? control : 'run';
  };

  /**
   * اعمال کنترل کاربر در مرز مرحله: اگر ساب‌ایجنت متوقف (pause) شده،
   * تا ادامه‌یافتن (resume) صبر می‌کند؛ اگر stop شده، SubagentStoppedError می‌دهد.
   * کنترل روی مرحله‌ای که هم‌اکنون در حال اجراست اثر نمی‌گذارد؛ از مرحله‌ی
   * بعدی اعمال می‌شود (محدودیت صادقانه‌ی معماری مرحله‌ای).
   */
  const enforceControl = async (subagentId: string, label: string): Promise<void> => {
    const deadline = Date.now() + PAUSE_TIMEOUT_MS;
    for (;;) {
      const control = await readControl(subagentId);
      if (control === 'run') {
        await sb.from('subagents').update({ status: 'running' }).eq('id', subagentId);
        return;
      }
      if (control === 'stop') {
        await sb
          .from('subagents')
          .update({ status: 'stopped', finished_at: new Date().toISOString() })
          .eq('id', subagentId);
        throw new SubagentStoppedError(label);
      }
      // pause: وضعیت را «متوقف‌شده» نشان بده و منتظر بمان
      await sb.from('subagents').update({ status: 'paused' }).eq('id', subagentId);
      if (Date.now() > deadline) {
        throw new SubagentStoppedError(`${label} (پایان مهلت انتظار برای ادامه)`);
      }
      await new Promise((resolve) => setTimeout(resolve, CONTROL_POLL_MS));
    }
  };

  // گزارش زنده‌ی پیشرفت: تیم در مرز مرحله‌هایش صدا می‌زند. اینجا:
  //  ۱. team_runs به‌روز می‌شود (progress/current_task)؛
  //  ۲. ساب‌ایجنت مرحله در جدول subagents ساخته/به‌روز می‌شود؛
  //  ۳. سیگنال کنترلی کاربر (توقف/ادامه/توقف کامل) اعمال می‌شود.
  // تریگر دیتابیس updated_at را هم تازه می‌کند.
  let lastPct = -1;
  let lastTask = '';
  let lastWriteAt = 0;
  const reportProgress: ProgressReporter = async (task, progress) => {
    const pct = Math.max(0, Math.min(100, Math.round(progress)));
    const now = Date.now();
    if (pct === lastPct && task === lastTask) return;
    if (pct < 100 && now - lastWriteAt < PROGRESS_MIN_INTERVAL_MS && pct <= lastPct) return;
    lastPct = pct;
    lastTask = task;
    lastWriteAt = now;
    const { error } = await sb
      .from('team_runs')
      .update({ progress: pct, current_task: task.slice(0, 500) })
      .eq('id', runRowId);
    if (error) console.error(`[orchestrator] failed to report progress for ${team}:`, error.message);

    if (PSEUDO_TASKS.has(task)) return;
    // ساب‌ایجنت این مرحله: بساز یا بیاور، بعد کنترل کاربر را اعمال کن.
    const { data: existing } = await sb
      .from('subagents')
      .select('id')
      .eq('team_run_id', runRowId)
      .eq('label', task)
      .maybeSingle();
    let subagentId = (existing as { id?: string } | null)?.id;
    if (!subagentId) {
      const { data: created, error: createErr } = await sb
        .from('subagents')
        .insert({
          team_run_id: runRowId,
          team,
          label: task,
          status: 'running',
          current_task: task.slice(0, 500),
          progress: pct,
        })
        .select('id')
        .single();
      if (createErr || !created) {
        console.error(`[orchestrator] failed to create subagent row:`, createErr?.message);
        return;
      }
      subagentId = created.id as string;
    }
    await enforceControl(subagentId, task);
    // مرحله‌ی قبلی تمام شد؛ بقیه‌ی «در حال اجرا»ها موفق ثبت می‌شوند.
    const { error: closeErr } = await sb
      .from('subagents')
      .update({ status: 'success', finished_at: new Date().toISOString() })
      .eq('team_run_id', runRowId)
      .eq('status', 'running')
      .neq('id', subagentId);
    if (closeErr) console.error('[orchestrator] failed to close previous subagents:', closeErr.message);
    await sb
      .from('subagents')
      .update({ current_task: task.slice(0, 500), progress: pct })
      .eq('id', subagentId);
  };

  // ضربان: اگر تیم مدتی مرحله‌ای گزارش نکرد، ردیف لمس می‌شود تا معلوم باشد
  // فرایند هنوز زنده است (updated_at تازه می‌ماند).
  const heartbeat = setInterval(() => {
    void sb
      .from('team_runs')
      .update({ current_task: lastTask || 'در حال اجرا', progress: Math.max(0, lastPct) })
      .eq('id', runRowId)
      .then(({ error }) => {
        if (error) console.error(`[orchestrator] heartbeat failed for ${team}:`, error.message);
      });
  }, HEARTBEAT_MS);
  if (typeof heartbeat === 'object' && 'unref' in heartbeat) {
    (heartbeat as unknown as { unref(): void }).unref();
  }

  try {
    await reportProgress('شروع اجرا', 5);
    // ساب‌ایجنت دانش: گردآوری نکته‌های تازه از منابع معتبر، قبل از سرپرست.
    // fail-soft: هر خطایی نادیده گرفته می‌شود و تیم با دانش قبلی جلو می‌رود.
    let knowledgeSnippet = '';
    try {
      await reportProgress('دانش: گردآوری', 8);
      const knowledgeResult = await runKnowledgeSubagent(
        team,
        ctx.runId,
        buildRagContext(ctx.previousWavesOutput),
        reportProgress,
      );
      if (knowledgeResult.contextSnippet) {
        knowledgeSnippet = `\n\nیافته‌های تازهٔ دانش این چرخه:\n${knowledgeResult.contextSnippet}`;
      }
      if (knowledgeResult.summary) {
        console.log(`[orchestrator] ساب‌ایجنت دانش تیم ${team}: ${knowledgeResult.summary}`);
      }
    } catch (err) {
      console.error(
        `[orchestrator] ساب‌ایجنت دانش تیم ${team} خطا داد (نادیده گرفته شد):`,
        err instanceof Error ? err.message : err,
      );
    }
    const { resetLLMStats, getLLMStats } = await import('./llm');
    resetLLMStats();
    const runTeam = await loadRunTeam(team);
    const memory = await loadTeamMemory(team);
    // کارهای تأییدشدهٔ این تیم («برود در چرخه») در اولویت زمینهٔ اجرا قرار می‌گیرند.
    let approvedContext = '';
    try {
      const approved = await listApprovedTasksForTeam(team);
      if (approved.length > 0) {
        const lines = approved.map(
          (t) => `- ${t.title}: ${(t.description ?? '').slice(0, 300)}`,
        );
        approvedContext = `\n\nکارهای تأییدشدهٔ در انتظار این تیم (در اولویت انجام):\n${lines.join('\n')}`;
      }
    } catch (err) {
      console.error(`[orchestrator] failed to load approved tasks for ${team}:`, err instanceof Error ? err.message : err);
    }
    const input: TeamInput = {
      cycleId,
      runId: ctx.runId,
      ragContext: buildRagContext(ctx.previousWavesOutput) + approvedContext + knowledgeSnippet,
      memory,
      previousWavesOutput: { ...ctx.previousWavesOutput },
      reportProgress,
    };
    // Ambient team context: every callLLM inside runTeam automatically uses
    // this team's configured endpoint + model (settings: llm_endpoints/team_models).
    const result = await runWithTeamContext(team, () => runTeam(input));
    const llmCalls = getLLMStats().total;
    // تفکیک «رد منتقد» از «خطای سیستمی» (دستور مسعود):
    // - approved=false یعنی تیم بدون خطای سیستمی اجرایش را تمام کرد ولی منتقد خروجی را رد کرد → 'rejected'
    // - 'failed' فقط برای خطای واقعی (exception، تایم‌اوت، خطای LLM) در بلوک catch پایین می‌ماند
    const teamStatus: TeamRunStatus = result.approved === false ? 'rejected' : 'success';
    // ساب‌ایجنت‌ها کارشان را تمام کرده‌اند؛ رد منتقد خطای آن‌ها نیست
    await closeSubagents('success');
    // تیم ۹: ردیابی استفاده از دانش — کدام چانک‌ها تزریق شدند و آیا مفید بودند؟
    try {
      const { getLastRetrievedChunkIds, recordKnowledgeUsage } = await import('./rag');
      const usedChunkIds = getLastRetrievedChunkIds(team);
      if (usedChunkIds.length > 0) {
        await recordKnowledgeUsage(usedChunkIds, runRowId, teamStatus === 'success');
      }
    } catch {
      // best-effort: خطای ردیابی دانش نباید نتیجه تیم را خراب کند
    }
    await finish({
      status: teamStatus,
      progress: 100,
      current_task:
        teamStatus === 'rejected'
          ? `رد شد توسط منتقد (بعد از ${roundLog.length} دور بازبینی)`
          : roundLog.length > 1
            ? `پایان کار (تأیید در دور ${roundLog.length})`
            : 'پایان کار',
      output_summary: result.summary?.slice(0, 4000) ?? null,
      error: teamStatus === 'rejected' ? (result.summary?.slice(0, 4000) ?? null) : null,
      llm_calls: llmCalls,
      // لاگ همهٔ دورهای حلقهٔ بازبینی (دستور مسعود): دور، تأیید/رد، دلیل، دستور
      review_rounds: roundLog,
    });
    // دروازه ثبت پچ (دستور مسعود): فقط پچ تیم موفقِ تأییدشده وارد پل می‌شود.
    // تیم ردشده (approved=false → rejected) یا ناموفق (failed) اصلاً در bridge_patches ثبت نمی‌شود.
    if (teamStatus !== 'success') {
      console.log(
        `[orchestrator] پچ تیم ${team} ثبت نشد چون منتقد رد کرد (وضعیت: ${teamStatus}).`,
      );
    } else {
      // پچ پیشنهادی تیم → جدول bridge_patches (وضعیت proposed)؛
      // بعد خودکار: دروازه کیفیت ← کامیت ← مرج به dev (بدون تأیید دستی، دستور مسعود).
      // best-effort: هرگز نتیجهٔ تیم را خراب نمی‌کند.
      try {
        // تیم‌ها دو فیلد جدا دارند (patch در dev، patches در content/design/seo)؛ هر دو را می‌گیریم
        const seen = new Set<string>();
        const mergedPatches: PatchFile[] = [];
        for (const p of [...(result.patch ?? []), ...(result.patches ?? [])]) {
          const key = (p?.path ?? '').trim().toLowerCase();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          mergedPatches.push(p);
        }
        const patchId = await registerProposedPatches(sb, {
          team,
          cycleId,
          runId: ctx.runId,
          summary: result.summary ?? '',
          patches: mergedPatches,
        });
        if (patchId) {
          await autoProcessBridgePatch(patchId, team);
        }
      } catch (err) {
        console.error(
          `[orchestrator] خطای غیرمنتظره در پل خودکار تیم ${team}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    // گزارش دوگانه: ثبت در پنل + ارسال به تلگرام (best-effort، مسدودکننده نیست).
    await notifyTeamReport({
      team,
      message: `گزارش تیم در چرخه ${ctx.runId}\n\n${result.summary ?? '(خلاصه‌ای ثبت نشد)'}`,
      cycleId,
    });
    return result;
  } catch (err) {
    if (err instanceof SubagentStoppedError) {
      await closeSubagents('stopped');
      await finish({ status: 'stopped', current_task: 'متوقف شد توسط کاربر' });
      await notifyTeamReport({
        team,
        message: `تیم در چرخه ${ctx.runId} توسط کاربر متوقف شد (مرحله: ${err.stage}).`,
        cycleId,
      });
      return null;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[orchestrator] team "${team}" failed:`, message);
    await closeSubagents('failed');
    await finish({ status: 'failed', current_task: 'خطا در اجرا', error: message.slice(0, 4000) });
    await notifyTeamReport({
      team,
      message: `تیم در چرخه ${ctx.runId} ناموفق بود:\n\n${message.slice(0, 1500)}`,
      cycleId,
    });
    return null;
  } finally {
    clearInterval(heartbeat);
  }
}





/** بستن چرخه: ثبت وضعیت نهایی + آمار + آزاد کردن قفل. */
export async function finishCycle(
  cycleId: string,
  status: CycleStatus,
  errorMessage?: string,
): Promise<void> {
  const sb = getSupabase();
  try {
    const { data: cycle } = await sb
      .from('cycles')
      .select('run_id, started_at')
      .eq('id', cycleId)
      .maybeSingle();
    const { data: runs } = await sb
      .from('team_runs')
      .select('status, llm_calls')
      .eq('cycle_id', cycleId);
    const rows = (runs ?? []) as { status: string; llm_calls: number }[];
    const stats: Record<string, number | string | boolean> = {
      total_teams: rows.length,
      success: rows.filter((r) => r.status === 'success').length,
      failed: rows.filter((r) => r.status === 'failed').length,
      rejected: rows.filter((r) => r.status === 'rejected').length,
      llm_calls: rows.reduce((sum, r) => sum + (r.llm_calls ?? 0), 0),
    };
    if (cycle) {
      stats.duration_minutes = Math.round(
        (Date.now() - new Date((cycle as { started_at: string }).started_at).getTime()) / 60000,
      );
    }
    const { error } = await sb
      .from('cycles')
      .update({
        status,
        finished_at: new Date().toISOString(),
        stats,
        ...(errorMessage ? { error: errorMessage.slice(0, 4000) } : {}),
      })
      .eq('id', cycleId);
    if (error) console.error('[orchestrator] failed to update cycles row:', error.message);
    // آزاد کردن قفل: وضعیت دیگر running نیست، ولی ردیف برای حسابرسی می‌ماند.
    await writeLock({
      status,
      run_id: (cycle as { run_id?: string } | null)?.run_id ?? null,
      cycle_id: cycleId,
      finished_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[orchestrator] finishCycle failed:', err instanceof Error ? err.message : err);
    try {
      await writeLock({ status, cycle_id: cycleId, finished_at: new Date().toISOString() });
    } catch {
      /* best effort */
    }
  }
}

