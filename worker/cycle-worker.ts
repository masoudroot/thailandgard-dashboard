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
import { claimTeam, type LockOwner } from '../lib/lock';
import { getSetting } from '../lib/settings';
import { sweepHungTeams } from '../lib/team-health';

/** سقف پردازش پچ‌های یتیم در هر تیک، تا بودجه‌ی زمانی جاب خورده نشود. */
const ORPHAN_SWEEP_LIMIT = 3;
/** کلید تنظیمات شروع خودکار چرخه‌ی بعدی (مقادیر: true/false؛ پیش‌فرض روشن). */
const AUTO_START_SETTING_KEY = 'auto_start_next_cycle';

/**
 * جاروی پچ‌های یتیم پل اجرا.
 * هر پچ با وضعیت proposed را از طریق جریان خودکار
 * (دروازه ← کامیت ← مرج به dev) پردازش می‌کند.
 * دستور مسعود: بدون تأیید دستی. کاملاً best-effort.
 * حداکثر ۳ پچ در هر تیک؛ فراخوانی‌اش در main بعد از تصمیم‌گیری تیم اصلی است، نه قبلش.
 */
async function sweepOrphanedBridgePatches(): Promise<void> {
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('bridge_patches')
      .select('id, team')
      .eq('status', 'proposed')
      .order('created_at', { ascending: true })
      .limit(ORPHAN_SWEEP_LIMIT);
    if (error || !data || data.length === 0) return;
    const { processProposedPatch } = await import('../lib/bridge/propose');
    for (const row of data as Array<{ id: string; team: string }>) {
      try {
        const res = await processProposedPatch(row.id);
        console.log(
          `[bridge-sweep] patch ${row.id} (team ${row.team}): ` +
            (res.merged ? `merged به dev` : res.gated ? `committed ولی مرج نشد` : `needs_review`),
        );
      } catch (err) {
        console.error(
          `[bridge-sweep] patch ${row.id} خطا داد:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } catch (err) {
    console.error('[bridge-sweep] خطای غیرمنتظره:', err instanceof Error ? err.message : err);
  }
}

/**
 * شروع خودکار چرخه‌ی بعدی، وقتی چرخه‌ی فعالی نیست.
 * اگر آخرین چرخه با success بسته شده و تنظیم auto_start_next_cycle مخالف
 * صریح (false) نیست، خودکار beginCycle می‌زند تا سیستم تا دخالت دستی نخوابد.
 * (دستور مسعود: سایت کاملاً خودکار باشد.)
 * اگر آخرین چرخه failed بود، چرخه‌ی تازه نمی‌سازد — نیاز به توجه دارد.
 * اگر اصلاً چرخه‌ای نبود هم هیچ‌چیز نمی‌سازد؛ شروع اول دستی است.
 */
async function autoStartNextCycleIfNeeded(): Promise<{ cycleId: string; runId: string } | null> {
  const autoStart = await getSetting<boolean>(AUTO_START_SETTING_KEY, true);
  if (autoStart === false) {
    console.log('auto-start disabled by setting auto_start_next_cycle=false');
    return null;
  }
  const sb = getSupabase();
  const { data, error } = await sb
    .from('cycles')
    .select('id, status')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) {
    console.log('no previous cycle; waiting for manual start');
    return null;
  }
  const last = data as { id: string; status: string };
  if (last.status !== 'success') {
    console.log(`last cycle ${last.id} ended with '${last.status}'; not auto-starting (needs attention)`);
    return null;
  }
  const { cycleId, runId } = await beginCycle();
  console.log(`auto-started next cycle: ${runId} (${cycleId})`);
  return { cycleId, runId };
}

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

  // ابتدای تیک: خواندن وضعیت چرخه‌ی فعال. اگر توقف خواسته شده بود
  // (pausing/paused)، هیچ تیمی claim نمی‌کنیم و بی‌صدا خارج می‌شویم —
  // ورکر هرگز نباید بعد از «توقف» کاربر، تیم بعدی را شروع کند.
  // اگر چرخه‌ی فعالی نیست، طبق قانون شروع خودکار، چرخه‌ی بعدی را می‌سازیم.
  let cycleId: string;
  let runId: string;
  {
    const active = await findActiveCycle();
    if (!active) {
      const auto = await autoStartNextCycleIfNeeded();
      if (!auto) {
        console.log('no active cycle');
        return;
      }
      cycleId = auto.cycleId;
      runId = auto.runId;
    } else {
      if (active.status === 'pausing' || active.status === 'paused') {
        console.log(`cycle ${active.run_id} is ${active.status}; skipping team claim`);
        return;
      }
      cycleId = active.id as string;
      runId = (active.run_id as string) ?? 'worker';
    }
  }

  // وضعیت تیم‌ها (مرتب‌سازی صعودی تا آخرین ردیف هر تیم، جدیدترین وضعیت باشد)
  const { data: runs } = await sb
    .from('team_runs')
    .select('team, status, started_at, updated_at, current_task')
    .eq('cycle_id', cycleId)
    .order('started_at', { ascending: true });
  const teamStatus: Record<string, string> = {};
  for (const r of (runs ?? []) as { team: string; status: string }[]) {
    teamStatus[r.team] = r.status;
  }

  // جاروی تیم‌های گیرکرده (دو سیگنال جدا: ضربان در برابر پیشرفت).
  //  - فرایندِ بی‌ضربانِ بیش از ۱۵ دقیقه → «مرده»، ناموفق ثبت می‌شود؛
  //  - ضربانِ زنده ولی بی‌پیشرفتِ بیش از ۱۰ دقیقه → «هنگ»، ناموفق ثبت می‌شود
  //    تا موج جلو برود (ری‌استارت چرخه). واچ‌داگ جداگانه هشدار می‌فرستد.
  // نکته‌ی ریشه‌ای: مبنای «پیشرفت» ستون updated_at است که پس از جداسازی،
  // ضربان دیگر آن را تازه نمی‌کند؛ پس تیمِ هنگِ ضربان‌زن دیگر «سالم» دیده نمی‌شود.
  const hung = await sweepHungTeams(sb, cycleId);
  for (const h of hung) {
    teamStatus[h.team] = 'failed';
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

  // نکته: heartbeat سطح تیم داخل runSingleTeam انجام می‌شود (ردیف team_runs را
  // تازه نگه می‌دارد تا تایم‌اوت اشتباه نخورد). heartbeat قفل چرخه در lib/lock
  // برای این ورکر کاربرد ندارد چون قفل چرخه را beginCycle (سبک قدیمی، بدون owner)
  // گرفته و touchLock مالکیت owner را می‌خواهد؛ صدا زدنش فقط لاگ خطا تولید می‌کرد.

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
          // مدل خراب است؛ فقط لاگ می‌زنیم. جایگزینی خودکار مدل در این ورکر
          // پیاده نشده؛ مدیر از پنل مدل سالم را جایگزین می‌کند.
          console.log(`proactive: team ${nextTeam} model unhealthy`);
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
  }

  // جاروی پچ‌های یتیم پل: پچ‌هایی که در proposed مانده‌اند
  // (مثلاً از پیش از قابلیت خودکار، یا کرش بین ثبت و پردازش)
  // را خودکار پردازش می‌کند. best-effort؛ هرگز چرخه را متوقف نمی‌کند.
  // عمداً بعد از تصمیم‌گیری و اجرای تیم اصلی می‌آید تا بودجه‌ی جاب را نخورد.
  await sweepOrphanedBridgePatches();
}

main().catch((err) => {
  console.error('worker fatal:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
