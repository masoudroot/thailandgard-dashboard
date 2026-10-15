/**
 * ارکستراتور چرخه: اجرای ۱۵ تیم در ۶ موج پشت سر هم.
 *
 * جریان یک چرخه:
 *   1. beginCycle: ساخت run_id یکتا + گرفتن قفل سراسری (agent_state)
 *      + ساخت ردیف cycles
 *   2. runAllWaves: اجرای موج‌به‌موج (داخل هر موج، تیم‌ها موازی با سقف ۳ هم‌زمان)
 *   3. finishCycle: آزاد کردن قفل + ثبت وضعیت نهایی cycles
 *
 * هر تیم با تابع runTeam از ماژول lib/teams/<team>.ts (ایمپورت داینامیک)
 * اجرا می‌شود. اگر ماژول تیم هنوز ساخته نشده باشد، اجرای آن تیم با
 * خطای واضح fail می‌شود ولی بقیه‌ی تیم‌ها ادامه می‌دهند.
 */
import { getSupabase } from './api';
import { runWithTeamContext } from './llm';
import {
  ACTIVE_CYCLE_STATUSES,
  normalizeCycleStatus,
  WAVES,
  type CycleStatus,
  type MemoryEntry,
  type TeamName,
  type TeamResult,
} from './types';

const LOCK_KEY = 'orchestrator:lock';
/** A lock counts as "someone else is running" only while running and younger than this. */
const LOCK_TTL_MINUTES = 150;
/** Max teams running concurrently inside one wave. */
const WAVE_CONCURRENCY = 3;
/** How often a paused cycle re-reads its status while waiting for resume/cancel. */
const PAUSE_POLL_MS = 5000;
/**
 * A lock younger than this while a cycle is paused means the in-process
 * pause-wait loop is still alive (it touches the lock on every poll).
 * Older than this => the server process died; resume must take over.
 */
const PAUSE_LOOP_ALIVE_MS = 10 * 60 * 1000;

export class CycleLockedError extends Error {}

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
  value:
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
    .select('value, updated_at')
    .eq('key', LOCK_KEY)
    .maybeSingle();
  if (error) throw new Error(`failed to read orchestrator lock: ${error.message}`);
  return data as LockRow | null;
}

async function writeLock(value: Record<string, unknown>): Promise<void> {
  const { error } = await getSupabase()
    .from('agent_state')
    .upsert(
      { key: LOCK_KEY, value, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  if (error) throw new Error(`failed to write orchestrator lock: ${error.message}`);
}

async function acquireLock(runId: string): Promise<void> {
  const existing = await readLock();
  if (existing?.value?.status === 'running') {
    const ref =
      existing.updated_at || existing.value.started_at || new Date(0).toISOString();
    const ageMin = (Date.now() - new Date(ref).getTime()) / 60000;
    if (ageMin < LOCK_TTL_MINUTES) {
      throw new CycleLockedError(
        `another cycle is already running (run_id=${existing.value.run_id ?? 'unknown'}, age=${Math.round(
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

  // آیا حلقه‌ی درون‌حافظه‌ای هنوز زنده و در انتظار است؟
  const lock = await readLock();
  const lockAgeMs = lock
    ? Date.now() - new Date(lock.updated_at).getTime()
    : Number.POSITIVE_INFINITY;
  const loopAlive =
    lock?.value?.status === 'running' &&
    lock.value.cycle_id === cycleId &&
    lockAgeMs < PAUSE_LOOP_ALIVE_MS;

  if (!loopAlive) {
    // سرور ری‌استارت شده یا حلقه مرده است: موج‌های باقی‌مانده را در پس‌زمینه ادامه می‌دهیم.
    void resumeRemainingWaves(cycleId).catch((err) => {
      console.error(`[orchestrator] background resume of cycle ${cycleId} crashed:`, err);
    });
  }
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

/** اجرای یک تیم و ثبت نتیجه در team_runs. خطا => team_run=failed، ولی موج ادامه می‌یابد. */
async function runSingleTeam(
  cycleId: string,
  team: TeamName,
  wave: number,
  ctx: WaveCtx,
): Promise<TeamResult | null> {
  const sb = getSupabase();
  const { data: runRow, error: insertErr } = await sb
    .from('team_runs')
    .insert({ cycle_id: cycleId, team, wave, status: 'running' })
    .select('id')
    .single();
  if (insertErr || !runRow) {
    throw new Error(`failed to create team_runs row for ${team}: ${insertErr?.message}`);
  }
  const runRowId = runRow.id as string;

  const finish = async (patch: Record<string, unknown>) => {
    const { error } = await sb
      .from('team_runs')
      .update({ ...patch, finished_at: new Date().toISOString() })
      .eq('id', runRowId);
    if (error) console.error(`[orchestrator] failed to update team_run ${runRowId}:`, error.message);
  };

  try {
    const runTeam = await loadRunTeam(team);
    const memory = await loadTeamMemory(team);
    const input: TeamInput = {
      cycleId,
      runId: ctx.runId,
      ragContext: buildRagContext(ctx.previousWavesOutput),
      memory,
      previousWavesOutput: { ...ctx.previousWavesOutput },
    };
    // Ambient team context: every callLLM inside runTeam automatically uses
    // this team's configured endpoint + model (settings: llm_endpoints/team_models).
    const result = await runWithTeamContext(team, () => runTeam(input));
    await finish({
      status: 'success',
      output_summary: result.summary?.slice(0, 4000) ?? null,
      llm_calls: 0,
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[orchestrator] team "${team}" failed:`, message);
    await finish({ status: 'failed', error: message.slice(0, 4000) });
    return null;
  }
}

/** اجرای موازی با سقف هم‌زمانی. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** اجرای یک موج: تیم‌های موج موازی (سقف ۳ هم‌زمان)، ثبت در team_runs. */
export async function runWave(
  cycleId: string,
  wave: number,
  ctx?: WaveCtx,
  skip?: Set<string>,
): Promise<void> {
  const def = WAVES.find((w) => w.wave === wave);
  if (!def) throw new Error(`unknown wave ${wave}; valid waves: ${WAVES.map((w) => w.wave).join(', ')}`);
  const context: WaveCtx = ctx ?? { runId: 'unknown', previousWavesOutput: {} };
  const teams = skip ? def.teams.filter((t) => !skip.has(`${wave}:${t}`)) : def.teams;
  if (teams.length === 0) return;
  const results = await mapWithConcurrency(teams, WAVE_CONCURRENCY, (team) =>
    runSingleTeam(cycleId, team, wave, context),
  );
  teams.forEach((team, i) => {
    context.previousWavesOutput[team] = results[i];
  });
}

/** اجرای همه‌ی موج‌ها پشت سر هم + بستن چرخه. */
export async function runAllWaves(
  cycleId: string,
  runId: string,
  opts?: RunWavesOptions,
): Promise<void> {
  const ctx: WaveCtx = { runId, previousWavesOutput: {} };
  let fatal: unknown = null;
  let canceledByUser = false;
  try {
    for (const def of WAVES) {
      // زمینه‌ی موج‌های از قبل تمام‌شده (در ادامهٔ چرخه) فقط تا قبل از موج جاری.
      if (opts?.prefill) {
        opts.prefill.forEach((p, team) => {
          if (p.wave < def.wave && !(team in ctx.previousWavesOutput)) {
            ctx.previousWavesOutput[team] = p.result;
          }
        });
      }
      // ایست‌بازرسی توقف/لغو: تیم‌های موج جاری تمام می‌شوند، موج بعدی شروع نمی‌شود.
      const decision = await checkpointBeforeWave(cycleId, runId);
      if (decision === 'canceled') {
        canceledByUser = true;
        break;
      }
      await runWave(cycleId, def.wave, ctx, opts?.skip);
    }
  } catch (err) {
    fatal = err;
  }
  if (canceledByUser) {
    await finishCycle(cycleId, 'canceled', 'لغو شده توسط کاربر');
    return;
  }
  const { data: runs } = await getSupabase()
    .from('team_runs')
    .select('status')
    .eq('cycle_id', cycleId);
  const failed = (runs ?? []).filter((r) => (r as { status: string }).status === 'failed').length;
  const status: CycleStatus = fatal || failed > 0 ? 'failed' : 'success';
  const errorMsg =
    failed > 0
      ? `${failed} team run(s) failed${fatal ? `; fatal: ${String(fatal)}` : ''}`
      : fatal
        ? String(fatal)
        : undefined;
  await finishCycle(cycleId, status, errorMsg);
  if (fatal) throw fatal;
}

/**
 * ادامهٔ موج‌های باقی‌ماندهٔ یک چرخهٔ متوقف‌شده (وقتی حلقه‌ی درون‌حافظه‌ای
 * زنده نیست، مثلاً بعد از ری‌استارت سرور). موج‌هایی که همه‌ی تیم‌هایشان
 * success/failed شده‌اند رد می‌شوند؛ بقیه از همان نقطه اجرا می‌شوند.
 */
export async function resumeRemainingWaves(cycleId: string): Promise<void> {
  const sb = getSupabase();
  const { data: cycle, error: cycleErr } = await sb
    .from('cycles')
    .select('run_id, status')
    .eq('id', cycleId)
    .maybeSingle();
  if (cycleErr || !cycle) throw new Error('چرخه پیدا نشد.');
  const row = cycle as { run_id: string; status: string };
  if (normalizeCycleStatus(row.status) !== 'running') {
    throw new Error('چرخه برای ادامه در وضعیت مناسبی نیست.');
  }

  const { data: runs } = await sb
    .from('team_runs')
    .select('team, wave, status, output_summary')
    .eq('cycle_id', cycleId);
  const skip = new Set<string>();
  const prefill = new Map<string, { wave: number; result: TeamResult | null }>();
  for (const r of (runs ?? []) as {
    team: string;
    wave: number;
    status: string;
    output_summary: string | null;
  }[]) {
    if (r.status === 'success' || r.status === 'failed') {
      skip.add(`${r.wave}:${r.team}`);
      prefill.set(r.team, {
        wave: r.wave,
        result: r.output_summary
          ? {
              team: r.team as TeamName,
              summary: r.output_summary,
              blockers: [],
              tasks: [],
              approved: r.status === 'success',
            }
          : null,
      });
    }
  }

  // تصاحب قفل: حلقه‌ی قبلی مرده است، پس قفل را تازه می‌کنیم.
  await writeLock({
    status: 'running',
    run_id: row.run_id,
    cycle_id: cycleId,
    resumed_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
  });
  await runAllWaves(cycleId, row.run_id, { skip, prefill });
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

/**
 * شروع یک چرخه‌ی کامل: run_id یکتا + قفل + ردیف cycles + اجرای موج‌به‌موج تیم‌ها.
 * در پایان run_id را برمی‌گرداند. اگر قفل running و تازه باشد، CycleLockedError می‌دهد.
 */
export async function startCycle(): Promise<string> {
  const { cycleId, runId } = await beginCycle();
  await runAllWaves(cycleId, runId);
  return runId;
}
