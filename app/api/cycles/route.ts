import { fail, getSupabase, ok } from '../../../lib/api';
import { WAVES } from '../../../lib/types';
import {
  beginCycle,
  CycleLockedError,
  findActiveCycle,
} from '../../../lib/orchestrator';

/** GET /api/cycles: فهرست چرخه‌ها (جدیدترین اول) با خلاصه غنی‌شده برای داشبورد. */
export async function GET(): Promise<Response> {
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('cycles')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(50);
    if (error) return fail(`failed to list cycles: ${error.message}`);
    const enriched = await Promise.all((data ?? []).map(enrichCycle));
    return ok(enriched);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * POST /api/cycles: شروع چرخه‌ی جدید.
 * اگر چرخهٔ فعالی (در حال اجرا، در آستانهٔ توقف، یا متوقف‌شده) هست، 409 برمی‌گردد؛
 * اول باید همان چرخه لغو شود یا ادامه یابد. قفل ارکستراتور هم همین را تضمین می‌کند.
 * قفل و ردیف cycles هم‌زمان ساخته می‌شود و run_id برمی‌گردد (202)؛
 * اجرای تیم‌ها با ورکر گیت‌هاب اکشنز انجام می‌شود؛ ورسل فقط رکورد را می‌سازد.
 */
export async function POST(): Promise<Response> {
  try {
    const active = await findActiveCycle();
    if (active) {
      return fail(
        `چرخهٔ فعالی در حال اجراست (وضعیت: ${active.status})؛ اول آن را لغو کنید یا ادامه دهید.`,
        409,
      );
    }
    const { cycleId, runId } = await beginCycle();
    // اجرا با ورکر گیت‌هاب اکشنز است؛ ورسل فقط رکورد را می‌سازد.
    return ok({ run_id: runId, cycle_id: cycleId }, 202);
  } catch (err) {
    if (err instanceof CycleLockedError) return fail(err.message, 409);
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** غنی‌سازی یک چرخه خام با موج‌ها، پیشرفت و تیم فعال برای داشبورد. */
async function enrichCycle(cycle: Record<string, unknown>) {
  const sb = getSupabase();
  const cycleId = String(cycle.id ?? '');
  let teamStatus: Record<string, string> = {};
  try {
    const { data } = await sb
      .from('team_runs')
      .select('team, status')
      .eq('cycle_id', cycleId);
    for (const r of (data ?? []) as { team: string; status: string }[]) {
      teamStatus[r.team] = r.status;
    }
  } catch {
    /* نادیده */
  }
  const waves = WAVES.map((w) => ({
    wave: w.wave,
    teams: w.teams.map((t) => ({ team: t, status: teamStatus[t] ?? 'pending' })),
  }));
  // موج جاری: اولین موجی که تیم ناتمام دارد
  let currentWave = 1;
  for (const w of waves) {
    const done = w.teams.every((t) => ['success', 'failed', 'stopped'].includes(t.status));
    if (!done) {
      currentWave = w.wave;
      break;
    }
    currentWave = w.wave + 1;
  }
  if (currentWave > WAVES.length) currentWave = WAVES.length;
  const allTeams = waves.flatMap((w) => w.teams);
  const doneCount = allTeams.filter((t) => ['success', 'failed', 'stopped'].includes(t.status)).length;
  const progress = allTeams.length > 0 ? Math.round((doneCount / allTeams.length) * 100) : 0;
  const activeTeam = allTeams.find((t) => t.status === 'running')?.team ?? '';
  // شناسه خوانا: «۲۳ مهر · ۱۵:۵۷» از started_at
  let displayLabel = String(cycle.id ?? '').slice(0, 8);
  try {
    const d = new Date(String(cycle.started_at ?? ''));
    if (!Number.isNaN(d.getTime())) {
      const datePart = d.toLocaleDateString('fa-IR', { day: 'numeric', month: 'long', timeZone: 'Asia/Tehran' });
      const timePart = d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' });
      displayLabel = `${datePart} · ${timePart}`;
    }
  } catch {
    /* نادیده */
  }
  return { ...cycle, waves, currentWave, progress, activeTeam, displayLabel };
}
