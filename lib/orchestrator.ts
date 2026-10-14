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
import {
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
  value: { status?: string; run_id?: string; cycle_id?: string; started_at?: string } | null;
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
    const result = await runTeam(input);
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
export async function runWave(cycleId: string, wave: number, ctx?: WaveCtx): Promise<void> {
  const def = WAVES.find((w) => w.wave === wave);
  if (!def) throw new Error(`unknown wave ${wave}; valid waves: ${WAVES.map((w) => w.wave).join(', ')}`);
  const context: WaveCtx = ctx ?? { runId: 'unknown', previousWavesOutput: {} };
  const results = await mapWithConcurrency(def.teams, WAVE_CONCURRENCY, (team) =>
    runSingleTeam(cycleId, team, wave, context),
  );
  def.teams.forEach((team, i) => {
    context.previousWavesOutput[team] = results[i];
  });
}

/** اجرای همه‌ی موج‌ها پشت سر هم + بستن چرخه. */
export async function runAllWaves(cycleId: string, runId: string): Promise<void> {
  const ctx: WaveCtx = { runId, previousWavesOutput: {} };
  let fatal: unknown = null;
  try {
    for (const def of WAVES) {
      await runWave(cycleId, def.wave, ctx);
    }
  } catch (err) {
    fatal = err;
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
