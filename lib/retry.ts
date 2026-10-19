/**
 * lib/retry.ts: تلاش مجدد واقعی روی رانِ ناموفق یک تیم.
 *
 * عمداً مستقل از lib/orchestrator.ts نوشته شده تا با کار هم‌زمان تیم‌های
 * دیگر روی ارکستر تداخل نکند. قرارداد اجرا دقیقاً همان runSingleTeam است:
 *   - ردیف قدیمی با status=failed به‌عنوان تاریخچه دست‌نخورده می‌ماند؛
 *   - ردیف تازه‌ای با status=running و retry_of به ردیف قدیمی ساخته می‌شود؛
 *   - ماژول تیم واقعاً دوباره اجرا می‌شود (نه فقط تغییر لیبل)؛
 *   - در پایان، ردیف تازه success/failed می‌شود و پیام خطا (در صورت شکست)
 *     در همان ردیف ثبت می‌شود.
 */
import { getSupabase } from './api';
import type { MemoryEntry, TeamName, TeamResult } from './types';

export interface RetryInput {
  cycleId: string;
  runId: string;
  ragContext: string;
  memory: MemoryEntry[];
  previousWavesOutput: Record<string, TeamResult | null>;
  reportProgress?: (task: string, progress: number) => void | Promise<void>;
}

type RunTeamFn = (input: RetryInput) => Promise<TeamResult>;

/** ایمپورت داینامیک ماژول تیم؛ اگر ماژول نیست، خطای واضح می‌دهد. */
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
      `cannot run team "${team}": failed to load lib/teams/${team}.ts (${reason})`,
    );
  }
}

/** حافظه‌ی تیم از جدول team_memory (آخرین ورودی هر kind). */
async function loadTeamMemory(team: TeamName): Promise<MemoryEntry[]> {
  try {
    const { data, error } = await getSupabase()
      .from('team_memory')
      .select('team, key, value, updated_at')
      .eq('team', team)
      .order('updated_at', { ascending: false })
      .limit(30);
    if (error || !data) return [];
    const seen = new Set<string>();
    const out: MemoryEntry[] = [];
    for (const row of data as { team: string; key: string; value: unknown }[]) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      out.push({
        team: row.team as TeamName,
        key: row.key,
        value: typeof row.value === 'string' ? row.value : JSON.stringify(row.value),
      });
    }
    return out;
  } catch {
    return [];
  }
}

interface FailedRow {
  id: string;
  cycle_id: string;
  team: TeamName;
  wave: number;
  status: string;
}

/**
 * تلاش مجدد روی یک ران ناموفق. فقط ران‌های failed پذیرفته می‌شوند.
 * اجرا در پس‌زمینه انجام می‌شود؛ newRunId بلافاصله برمی‌گردد تا API
 * بتواند 202 بدهد و صفحه وضعیت را با polling دنبال کند.
 */
export async function retryFailedTeamRun(
  runId: string,
): Promise<{ newRunId: string; team: TeamName; cycleId: string }> {
  const sb = getSupabase();

  const { data: row, error: rowErr } = await sb
    .from('team_runs')
    .select('id, cycle_id, team, wave, status')
    .eq('id', runId)
    .single();
  if (rowErr || !row) throw new Error(`team run not found: ${runId}`);
  const failed = row as FailedRow;
  if (failed.status !== 'failed') {
    throw new Error(`only failed runs can be retried (run ${runId} is "${failed.status}")`);
  }

  const { data: cycle } = await sb
    .from('cycles')
    .select('run_id')
    .eq('id', failed.cycle_id)
    .maybeSingle();
  const runIdLabel = (cycle as { run_id?: string } | null)?.run_id ?? 'retry';

  // بازسازی زمینه‌ی موج‌های قبلی همان چرخه از روی خلاصه‌های ثبت‌شده
  const { data: earlier } = await sb
    .from('team_runs')
    .select('team, wave, status, output_summary')
    .eq('cycle_id', failed.cycle_id)
    .lt('wave', failed.wave)
    .order('started_at', { ascending: false });
  const previousWavesOutput: Record<string, TeamResult | null> = {};
  for (const r of (earlier ?? []) as {
    team: string;
    status: string;
    output_summary: string | null;
  }[]) {
    if (previousWavesOutput[r.team] !== undefined) continue;
    previousWavesOutput[r.team] =
      r.status === 'success'
        ? {
            team: r.team as TeamName,
            summary: r.output_summary ?? '',
            blockers: [],
            tasks: [],
            approved: false,
          }
        : null;
  }
  const ragContext = Object.entries(previousWavesOutput)
    .filter(([, v]) => v?.summary)
    .map(([team, v]) => `- ${team}: ${v!.summary}`)
    .join('\n');

  const memory = await loadTeamMemory(failed.team);

  const { data: newRow, error: insertErr } = await sb
    .from('team_runs')
    .insert({
      cycle_id: failed.cycle_id,
      team: failed.team,
      wave: failed.wave,
      status: 'running',
      retry_of: failed.id,
    })
    .select('id')
    .single();
  if (insertErr || !newRow) {
    throw new Error(`failed to create retry row for ${failed.team}: ${insertErr?.message}`);
  }
  const newRunId = newRow.id as string;

  // اجرای واقعی در پس‌زمینه؛ نتیجه (موفقیت یا خطا) در همان ردیف تازه ثبت می‌شود.
  void (async () => {
    try {
      const runTeam = await loadRunTeam(failed.team);
      const result = await runTeam({
        cycleId: failed.cycle_id,
        runId: runIdLabel,
        ragContext,
        memory,
        previousWavesOutput,
      });
      const { error: upErr } = await sb
        .from('team_runs')
        .update({
          status: 'success',
          output_summary: result.summary?.slice(0, 4000) ?? null,
          finished_at: new Date().toISOString(),
        })
        .eq('id', newRunId);
      if (upErr) console.error(`[retry] failed to mark success for ${newRunId}:`, upErr.message);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[retry] team "${failed.team}" failed again:`, message);
      const { error: upErr } = await sb
        .from('team_runs')
        .update({
          status: 'failed',
          error: message.slice(0, 4000),
          finished_at: new Date().toISOString(),
        })
        .eq('id', newRunId);
      if (upErr) console.error(`[retry] failed to record error for ${newRunId}:`, upErr.message);
    }
  })();

  return { newRunId, team: failed.team, cycleId: failed.cycle_id };
}
