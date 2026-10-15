/**
 * ورکر ارکستراسیون تایلندگرد — اجرا روی گیت‌هاب اکشنز.
 * هر اجرا فقط «یک تیم» را اجرا می‌کند و خارج می‌شود.
 * کرون گیت‌هاب هر ۵ دقیقه آن را صدا می‌زند تا چرخه جلو برود.
 *
 * اجرا: npx tsx worker/cycle-worker.ts
 * نیازمند: SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY در env
 */
import { getSupabase } from '../lib/api';
import { WAVES, type TeamName } from '../lib/types';
import { findActiveCycle, finishCycle, runSingleTeam } from '../lib/orchestrator';

const STUCK_TIMEOUT_MS = 15 * 60 * 1000;

async function main(): Promise<void> {
  const sb = getSupabase();
  const active = await findActiveCycle();
  if (!active) {
    console.log('no active cycle');
    return;
  }
  const cycleId = active.id as string;
  const runId = (active.run_id as string) ?? 'worker';

  // وضعیت تیم‌ها
  const { data: runs } = await sb
    .from('team_runs')
    .select('team, status, started_at, current_task')
    .eq('cycle_id', cycleId);
  const teamStatus: Record<string, string> = {};
  const teamStarted: Record<string, number> = {};
  for (const r of (runs ?? []) as { team: string; status: string; started_at: string }[]) {
    teamStatus[r.team] = r.status;
    teamStarted[r.team] = new Date(r.started_at).getTime();
  }

  // تایم‌اوت تیم‌های گیرکرده (ضربان قدیمی)
  const now = Date.now();
  for (const [team, status] of Object.entries(teamStatus)) {
    if (status === 'running' && now - (teamStarted[team] ?? 0) > STUCK_TIMEOUT_MS) {
      console.log(`timing out stuck team: ${team}`);
      await sb
        .from('team_runs')
        .update({ status: 'failed', error: 'تایم‌اوت ورکر: بیش از ۱۵ دقیقه بدون پیشرفت', finished_at: new Date().toISOString() })
        .eq('cycle_id', cycleId)
        .eq('team', team);
      teamStatus[team] = 'failed';
    }
  }

  const isDone = (s: string) => ['success', 'failed', 'stopped'].includes(s);

  // اگر همه موج‌ها تمام شدند، چرخه را ببند
  const allDone = WAVES.every((w) => w.teams.every((t) => isDone(teamStatus[t] ?? 'pending')));
  if (allDone) {
    const failed = Object.values(teamStatus).filter((s) => ['failed', 'stopped'].includes(s)).length;
    await finishCycle(cycleId, failed > 0 ? 'failed' : 'success');
    console.log(`cycle finished: ${failed > 0 ? 'failed' : 'success'}`);
    return;
  }

  // موج جاری: اولین موج ناتمام
  const currentWaveDef = WAVES.find((w) => !w.teams.every((t) => isDone(teamStatus[t] ?? 'pending')));
  if (!currentWaveDef) {
    console.log('no pending wave');
    return;
  }

  // اگر تیمی در حال اجراست، صبر کن (تک‌تیمه جلو می‌رویم)
  const hasRunning = currentWaveDef.teams.some((t) => teamStatus[t] === 'running');
  if (hasRunning) {
    console.log(`wave ${currentWaveDef.wave} has a running team; waiting`);
    return;
  }

  // اولین تیم معلق موج جاری را اجرا کن
  const nextTeam = currentWaveDef.teams.find((t) => !isDone(teamStatus[t] ?? 'pending')) as TeamName | undefined;
  if (!nextTeam) {
    console.log('no pending team in current wave');
    return;
  }

  console.log(`running team ${nextTeam} (wave ${currentWaveDef.wave})`);
  try {
    await runSingleTeam(cycleId, nextTeam, currentWaveDef.wave, {
      runId,
      previousWavesOutput: {},
    });
    console.log(`team ${nextTeam} done`);
  } catch (err) {
    console.error(`team ${nextTeam} crashed:`, err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('worker fatal:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
