/**
 * ورکر ارکستراسیون تایلندگرد — اجرا روی گیت‌هاب اکشنز.
 * هر اجرا فقط «یک تیم» را اجرا می‌کند و خارج می‌شود.
 * کرون گیت‌هاب هر ۵ دقیقه آن را صدا می‌زند تا چرخه جلو برود.
 * با آرگومان start-cycle یک چرخه جدید می‌سازد.
 *
 * اجرا: npx tsx worker/cycle-worker.ts [start-cycle]
 * نیازمند: SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY در env
 */
import { getSupabase } from '../lib/api';
import { WAVES, type TeamName } from '../lib/types';
import { findActiveCycle, finishCycle, runSingleTeam, beginCycle } from '../lib/orchestrator';
import { claimTeam, startHeartbeat, type LockOwner } from '../lib/lock';

const STUCK_TIMEOUT_MS = 15 * 60 * 1000;

async function main(): Promise<void> {
  const sb = getSupabase();
  const action = process.argv[2];

  // ساخت چرخه جدید
  if (action === 'start-cycle') {
    const active = await findActiveCycle();
    if (active) {
      console.log(`active cycle exists: ${active.run_id}, skipping`);
      return;
    }
    const { cycleId, runId } = await beginCycle();
    console.log(`new cycle started: ${runId} (${cycleId})`);
    return;
  }

  const active = await findActiveCycle();
  if (!active) {
    console.log('no active cycle');
    return;
  }
  const cycleId = active.id as string;
  const runId = (active.run_id as string) ?? 'worker';

  // وضعیت تیم‌ها (مرتب‌سازی صعودی تا آخرین ردیف هر تیم، جدیدترین وضعیت باشد)
  const { data: runs } = await sb
    .from('team_runs')
    .select('team, status, started_at, updated_at, current_task')
    .eq('cycle_id', cycleId)
    .order('started_at', { ascending: true });
  const teamStatus: Record<string, string> = {};
  const teamHeartbeat: Record<string, number> = {};
  for (const r of (runs ?? []) as { team: string; status: string; started_at: string; updated_at?: string }[]) {
    teamStatus[r.team] = r.status;
    // ضربان: آخرین به‌روزرسانی پیشرفت؛ اگر نبود، زمان شروع
    teamHeartbeat[r.team] = new Date(r.updated_at ?? r.started_at).getTime();
  }

  // تایم‌اوت تیم‌های گیرکرده: فقط اگر بیش از ۱۵ دقیقه هیچ پیشرفتی
  // گزارش نکرده باشند (مبنای مرگ، ضربان است نه زمان شروع)
  const now = Date.now();
  for (const [team, status] of Object.entries(teamStatus)) {
    if (status === 'running' && now - (teamHeartbeat[team] ?? 0) > STUCK_TIMEOUT_MS) {
      console.log(`timing out stuck team (no heartbeat for 15m): ${team}`);
      await sb
        .from('team_runs')
        .update({ status: 'failed', error: 'تایم‌اوت ورکر: بیش از ۱۵ دقیقه بدون هیچ پیشرفتی', finished_at: new Date().toISOString() })
        .eq('cycle_id', cycleId)
        .eq('team', team);
      teamStatus[team] = 'failed';
    }
  }

  // تیم «ردشده توسط منتقد» موج را بلاک نمی‌کند؛ کارش را انجام داده و در چرخه بعد دوباره تلاش می‌کند
  const isDone = (s: string) => ['success', 'failed', 'stopped', 'rejected'].includes(s);

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

  // claim اتمیک تیم: اگر ورکر دیگری هم‌زمان همین تیم را برداشت، ما عقب می‌نشینیم
  const owner: LockOwner = {
    engine: 'github-actions',
    runId: process.env.GITHUB_RUN_ID ?? `worker-${Date.now()}`,
  };
  const teamRunId = await claimTeam(cycleId, nextTeam, currentWaveDef.wave, owner);
  if (!teamRunId) {
    console.log(`team ${nextTeam} already claimed by another worker; skipping`);
    return;
  }

  // heartbeat در حین اجرای تیم تا قفل stale نشود
  const stopHeartbeat = startHeartbeat(owner);

  try {
    // چک پیش‌دستانه: مدل تیم سالم است؟ اگر نه، قبل از شروع عوضش کن
    try {
      const { resolveTeamConfig } = await import('../lib/llm-endpoints');
      const { postChatCompletions } = await import('../lib/llm');
      const cfg = await resolveTeamConfig(nextTeam);
      if (cfg) {
        try {
          await postChatCompletions(cfg.baseUrl, cfg.apiKey, cfg.model, 'سلام', {
            maxTokens: 8,
            temperature: 0,
            timeoutMs: 15000,
          });
        } catch {
          console.log(`proactive: team ${nextTeam} model unhealthy, finding replacement`);
          // مدل خراب است؛ persistTeamModel در اولین فراخوانی موفق جایگزین می‌کند
        }
      }
    } catch { /* نادیده */ }
    await runSingleTeam(cycleId, nextTeam, currentWaveDef.wave, {
      runId,
      previousWavesOutput: {},
    }, teamRunId);
    console.log(`team ${nextTeam} done`);
  } catch (err) {
    console.error(`team ${nextTeam} crashed:`, err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    stopHeartbeat();
  }
}

main().catch((err) => {
  console.error('worker fatal:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
