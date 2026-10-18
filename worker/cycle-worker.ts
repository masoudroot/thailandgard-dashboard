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
import { MAX_SAME_CYCLE_FIX_ATTEMPTS, WAVES, type TeamName } from '../lib/types';
import { findActiveCycle, finishCycle, runSingleTeam, beginCycle } from '../lib/orchestrator';
import { claimTeam, readLock, touchLock, type LockOwner } from '../lib/lock';
import { getSetting } from '../lib/settings';
import { sweepHungTeams } from '../lib/team-health';
import { recoverDeadCycles, isAutoRestartableAfterKill } from '../lib/cycle-recovery';

/**
 * نگهبان مرگ خاموش (۲۵ مهر ۱۴۰۵): ریجکشن هندل‌نشده نباید پروسه را بی‌صدا بکشد.
 * قبلاً دو هنگ (content و branding) با قطع ضربان و بدون هیچ لاگی رخ داد؛
 * محتمل‌ترین علت کرش بر اثر unhandledRejection بود. حالا خطا لاگ می‌شود و
 * پروسه زنده می‌ماند تا نگهبان هنگ، تیم را تمیز ناموفق ثبت کند.
 */
process.on('unhandledRejection', (reason) => {
  console.error(
    '[cycle-worker] unhandledRejection (پروسه زنده ماند):',
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  );
});
process.on('uncaughtException', (err) => {
  console.error(
    '[cycle-worker] uncaughtException (پروسه زنده ماند):',
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
});

/** سقف پردازش پچ‌های یتیم در هر تیک، تا بودجه‌ی زمانی جاب خورده نشود. */
const ORPHAN_SWEEP_LIMIT = 3;
/** کلید تنظیمات شروع خودکار چرخه‌ی بعدی (مقادیر: true/false؛ پیش‌فرض روشن). */
const AUTO_START_SETTING_KEY = 'auto_start_next_cycle';
/**
 * سقف خرابی‌های پیاپی چرخه پیش از توقف شروع خودکار.
 * بعد از این تعداد چرخه‌ی پیاپیِ ناموفق، دیگر خودکار شروع نمی‌کنیم تا
 * علت سیستمی بررسی شود. با سیاست ارجاع بازبین گزارش (۳ ناموفقی پیاپی) هم‌خوان است.
 */
const MAX_CONSECUTIVE_CYCLE_FAILURES = 3;

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
 * اگر آخرین چرخه failed بود هم چرخه‌ی تازه می‌سازد — پارک نمی‌شود
 * (دستور مسعود، ۲۵ مهر ۱۴۰۵)؛ استثنا: اگر خرابی‌های پیاپی به سقف
 * MAX_CONSECUTIVE_CYCLE_FAILURES رسید، شروع خودکار متوقف می‌شود تا علت
 * سیستمی بررسی شود (جلوگیری از حلقه‌ی بی‌پایان چرخه‌های ناموفق).
 * چرخه‌ای که با kill مرده و بازیابی شده (KILLED) هم خودکار با چرخه‌ای
 * تمیز ادامه می‌یابد، چون kill رویداد زیرساختی است نه سیگنال کیفی.
 * وضعیت‌های stopped/paused/pausing (توقف دستی/کاربری) خودکار شروع نمی‌شوند.
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
    .select('id, status, error')
    .order('started_at', { ascending: false })
    .limit(MAX_CONSECUTIVE_CYCLE_FAILURES);
  if (error || !data || data.length === 0) {
    console.log('no previous cycle; waiting for manual start');
    return null;
  }
  const last = data[0] as { id: string; status: string; error?: string | null };

  // (۲۵ مهر ۱۴۰۵، دستور مسعود): چرخه‌ی ناموفق هم خودکار ادامه می‌یابد —
  // دیگر پارک نمی‌شود. فقط اگر خرابی‌های پیاپی به سقف رسید، متوقف می‌مانیم.
  if (last.status === 'failed') {
    let streak = 0;
    for (const c of data as Array<{ status: string }>) {
      if (c.status === 'failed') streak++;
      else break;
    }
    if (streak >= MAX_CONSECUTIVE_CYCLE_FAILURES) {
      console.log(
        `last ${streak} cycles failed consecutively; not auto-starting (needs attention)`,
      );
      return null;
    }
    console.log(
      `last cycle ${last.id} failed (streak ${streak}/${MAX_CONSECUTIVE_CYCLE_FAILURES}); auto-starting a new cycle`,
    );
  } else if (last.status !== 'success' && !isAutoRestartableAfterKill(last)) {
    console.log(`last cycle ${last.id} ended with '${last.status}'; not auto-starting (needs attention)`);
    return null;
  } else if (isAutoRestartableAfterKill(last)) {
    console.log(`last cycle ${last.id} was killed and recovered; auto-starting a clean cycle`);
  }
  const { cycleId, runId } = await beginCycle();
  console.log(`auto-started next cycle: ${runId} (${cycleId})`);
  return { cycleId, runId };
}

/**
 * ضربان قفل چرخه در هر تیک ورکر (قفل جدید lib/lock.ts با TTL ده‌دقیقه‌ای).
 *
 * چرا لازم است؟ beginCycle قفل را با owner می‌گیرد؛ اگر هیچ‌کس heartbeat
 * نزند، قفل پس از ۱۰ دقیقه stale می‌شود و beginCycle دیگری می‌تواند وسط
 * همین چرخه قفل را تصاحب کند. ورکر هر ۵ دقیقه تیک می‌زند، پس با این ضربان
 * قفلِ چرخه‌ی فعال همیشه تازه می‌ماند.
 *
 * engine-agnostic است: هویت دارنده را از خود ردیف قفل می‌خواند (چرخه ممکن
 * است از ورسل شروع شده باشد و ورکر گیت‌هاب آن را ادامه دهد). اگر قفل مال
 * چرخه‌ی دیگری باشد یا دیگر دست ما نباشد، چیزی نمی‌نویسد (fail-soft).
 */
async function heartbeatCycleLock(cycleId: string): Promise<void> {
  try {
    const lock = await readLock();
    const st = lock?.state;
    if (!st || st.status !== 'running' || !st.owner) return;
    if (st.cycleId && st.cycleId !== cycleId) return; // مال چرخه‌ی دیگری است
    await touchLock(st.owner);
  } catch (err) {
    // قفل را از دست داده‌ایم یا خطای دیتابیس؛ تیک ادامه می‌یابد
    console.error('[worker] cycle lock heartbeat failed:', err instanceof Error ? err.message : err);
  }
}

async function main(): Promise<void> {
  const sb = getSupabase();
  const action = process.argv[2];

  // رفع ریشه‌ای مشکل kill (مشکل ۶): در شروع هر تیک، اول بقایای چرخه مرده
  // (قفل stale، تسک‌های claimشده رها، وضعیت‌های ناتمام، پچ‌های gated یتیم)
  // بازیابی می‌شود؛ بعد تصمیم‌گیری عادی. fail-soft است.
  try {
    await recoverDeadCycles();
  } catch (err) {
    console.error('[worker] cycle recovery at tick start failed (continuing):', err instanceof Error ? err.message : err);
  }

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
      await heartbeatCycleLock(cycleId);
    } else {
      // چرخه‌ی متوقف‌شده هم قفلش را نگه می‌دارد تا چرخه‌ی دیگری وسط
      // توقف، قفل stale را تصاحب نکند؛ پس ضربان پیش از بررسی pause.
      await heartbeatCycleLock(active.id as string);
      if (active.status === 'pausing' || active.status === 'paused') {
        console.log(`cycle ${active.run_id} is ${active.status}; skipping team claim`);
        return;
      }
      cycleId = active.id as string;
      runId = (active.run_id as string) ?? 'worker';
    }
  }

  // وضعیت تیم‌ها (مرتب‌سازی صعودی تا آخرین ردیف هر تیم، جدیدترین وضعیت باشد).
  // حلقهٔ اصلاح درون‌چرخه‌ای (دستور مسعود، ۱۴۰۵/۰۷/۲۶): برای هر تیم هم
  // «آخرین وضعیت» و هم «تعداد تلاش‌ها در همین چرخه» را نگه می‌داریم؛ تیمِ
  // ردشده/ناموفق تا سقف MAX_SAME_CYCLE_FIX_ATTEMPTS دوباره اجرا می‌شود و
  // کارش به چرخهٔ بعد موکول نمی‌شود. review_rounds برای استخراج دستور
  // اصلاحِ رد قبلی خوانده می‌شود.
  const { data: runs } = await sb
    .from('team_runs')
    .select('team, status, started_at, updated_at, current_task, review_rounds, error')
    .eq('cycle_id', cycleId)
    .order('started_at', { ascending: true });
  const teamStatus: Record<string, string> = {};
  const teamAttempts: Record<string, number> = {};
  const teamLastRun: Record<string, { review_rounds: unknown; error: string | null }> = {};
  for (const r of (runs ?? []) as Array<{
    team: string;
    status: string;
    review_rounds?: unknown;
    error?: string | null;
  }>) {
    teamStatus[r.team] = r.status;
    teamAttempts[r.team] = (teamAttempts[r.team] ?? 0) + 1;
    teamLastRun[r.team] = { review_rounds: r.review_rounds ?? null, error: r.error ?? null };
  }

  // جاروی تیم‌های گیرکرده (دو سیگنال جدا: ضربان در برابر پیشرفت).
  //  - فرایندِ بی‌ضربانِ بیش از ۱۵ دقیقه → «مرده»، ناموفق ثبت می‌شود؛
  //  - ضربانِ زنده ولی بی‌پیشرفتِ بیش از ۱۵ دقیقه → «هنگ»، ناموفق ثبت می‌شود
  //    تا موج جلو برود (ری‌استارت چرخه). واچ‌داگ جداگانه هشدار می‌فرستد.
  // نکته‌ی ریشه‌ای: مبنای «پیشرفت» ستون updated_at است که پس از جداسازی،
  // ضربان دیگر آن را تازه نمی‌کند؛ پس تیمِ هنگِ ضربان‌زن دیگر «سالم» دیده نمی‌شود.
  const hung = await sweepHungTeams(sb, cycleId);
  for (const h of hung) {
    teamStatus[h.team] = 'failed';
    // جارو ردیف موجود را به‌روز می‌کند (ردیف تازه نمی‌سازد)؛ پس شمارش
    // تلاش‌ها همان می‌ماند و فقط وضعیت آخرین اجرا عوض می‌شود.
    teamLastRun[h.team] = { review_rounds: teamLastRun[h.team]?.review_rounds ?? null, error: null };
  }

  /**
   * حلقهٔ اصلاح درون‌چرخه‌ای (دستور مسعود، ۱۴۰۵/۰۷/۲۶):
   * - success/stopped/skipped → تمام‌شده.
   * - rejected/failed → فقط وقتی تمام‌شده که سقف تلاش اصلاح در همین چرخه
   *   خورده باشد؛ در غیر این صورت تیم در تیک‌های بعدیِ همین چرخه دوباره
   *   اجرا می‌شود (موج جلو نمی‌رود تا تیم یا موفق شود یا «مسدود» شود).
   * - pending/running → تمام‌نشده.
   */
  const isDone = (t: string): boolean => {
    const s = teamStatus[t] ?? 'pending';
    if (s === 'success' || s === 'stopped' || s === 'skipped') return true;
    if (s === 'rejected' || s === 'failed') {
      return (teamAttempts[t] ?? 0) >= MAX_SAME_CYCLE_FIX_ATTEMPTS;
    }
    return false;
  };

  /**
   * استخراج دستور اصلاح از آخرین اجرای ردشده/ناموفق تیم در همین چرخه:
   * از review_rounds آخرین directive ردشده، و برای خطا (failed) از پیام
   * خطا یک دستور ترمیمی سنتز می‌شود. خروجی در تلاش اصلاح بعدی به‌عنوان
   * «دستور رهبر» تزریق می‌شود تا تیم همان ایراد را بگیرد.
   */
  const extractPriorFixDirective = (team: string): { directive?: string; reason?: string } => {
    const last = teamLastRun[team];
    if (!last) return {};
    const rounds = last.review_rounds;
    if (Array.isArray(rounds)) {
      for (let i = rounds.length - 1; i >= 0; i--) {
        const rd = rounds[i] as { approved?: boolean; reason?: unknown; directive?: unknown } | null;
        if (rd && typeof rd === 'object' && rd.approved === false) {
          const directive = String(rd.directive ?? '').trim();
          const reason = String(rd.reason ?? '').trim();
          if (directive) {
            return { directive: directive.slice(0, 2000), reason: reason.slice(0, 500) || undefined };
          }
        }
      }
    }
    if (last.error) {
      const errText = String(last.error).trim().slice(0, 1000);
      if (errText) {
        return {
          reason: errText.slice(0, 500),
          directive:
            `اجرای قبلی‌ات در همین چرخه با خطا متوقف شد: ${errText}. ` +
            'علت را پیدا و برطرف کن و کارت را کامل انجام بده؛ خروجی ناقص یا نیمه‌کاره قابل قبول نیست.',
        };
      }
    }
    return {};
  };

  // اگر همه موج‌ها تمام شدند، چرخه را ببند
  const allDone = WAVES.every((w) => w.teams.every((t) => isDone(t)));
  if (allDone) {
    const failed = Object.values(teamStatus).filter((s) => ['failed', 'stopped'].includes(s)).length;
    await finishCycle(cycleId, failed > 0 ? 'failed' : 'success');
    console.log(`cycle finished: ${failed > 0 ? 'failed' : 'success'}`);
    return;
  }

  // موج جاری: اولین موج ناتمام
  const currentWaveDef = WAVES.find((w) => !w.teams.every((t) => isDone(t)));
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
  const nextTeam = currentWaveDef.teams.find((t) => !isDone(t)) as TeamName | undefined;
  if (!nextTeam) {
    console.log('no pending team in current wave');
    return;
  }

  // حلقهٔ اصلاح درون‌چرخه‌ای: شمارهٔ تلاش و دستور به‌جامانده از رد قبلی
  const fixAttempt = (teamAttempts[nextTeam] ?? 0) + 1;
  const prior = fixAttempt > 1 ? extractPriorFixDirective(nextTeam) : {};
  console.log(`running team ${nextTeam} (wave ${currentWaveDef.wave})`);
  if (fixAttempt > 1) {
    console.log(
      `[fix-loop] team ${nextTeam}: same-cycle fix attempt ${fixAttempt}/${MAX_SAME_CYCLE_FIX_ATTEMPTS}` +
        (prior.reason ? ` (prev: ${prior.reason.slice(0, 200)})` : ''),
    );
  }

  // claim اتمیک تیم: اگر ورکر دیگری هم‌زمان همین تیم را برداشت، ما عقب می‌نشینیم
  const owner: LockOwner = {
    engine: process.env.CYCLE_ENGINE ?? 'github-actions',
    runId: process.env.GITHUB_RUN_ID ?? `worker-${Date.now()}`,
  };
  const teamRunId = await claimTeam(cycleId, nextTeam, currentWaveDef.wave, owner);
  if (!teamRunId) {
    console.log(`team ${nextTeam} already claimed by another worker; skipping`);
    return;
  }

  // نکته: heartbeat سطح تیم داخل runSingleTeam انجام می‌شود (ردیف team_runs را
  // تازه نگه می‌دارد تا تایم‌اوت اشتباه نخورد). heartbeat قفل چرخه هم در ابتدای
  // همین تیک با heartbeatCycleLock زده شد (قفل جدید owner دارد و touchLock
  // با هویت دارنده‌ی خوانده‌شده از ردیف کار می‌کند).

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
      fixAttempt,
      priorFixDirective: prior.directive,
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
