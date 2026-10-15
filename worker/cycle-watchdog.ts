/**
 * نگهبان چرخه‌ی تایلندگرد: هشدار خودکار برای چرخه‌ی گیرکرده.
 *
 * هر ۱۰ دقیقه اجرا می‌شود (ورک‌فلو cycle-watchdog.yml):
 *  ۱. چرخه‌های فعال (running/pausing/paused) را پیدا می‌کند؛
 *  ۲. اگر بیش از ۱۵ دقیقه هیچ تیمی پیشرفتی نکرده باشد (نه اتمام، نه به‌روزرسانی)،
 *     هشدار به تلگرام مدیر می‌فرستد؛
 *  ۳. برای جلوگیری از اسپم، برای هر چرخه حداکثر هر ۶۰ دقیقه یک هشدار می‌فرستد.
 *
 * قانون سفت: این اسکریپت فقط هشدار می‌دهد و هرگز چرخه، قفل یا تیمی را
 * دست‌کاری نمی‌کند (نه به‌روزرسانی وضعیت، نه آزادسازی قفل، نه شروع/توقف).
 * هیچ‌وقت throw نمی‌کند تا ورک‌فلو سبز بماند.
 *
 * اجرا: npx tsx worker/cycle-watchdog.ts
 * نیازمند: SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY در env
 */
import { getSupabase } from '../lib/api';
import { ACTIVE_CYCLE_STATUSES, type TeamRun } from '../lib/types';
import { notifyTeamReport } from '../lib/notify';
import { faNum } from '../lib/format';

/** آستانه‌ی توقف: بیش از این دقیقه بدون پیشرفت یعنی چرخه گیر کرده است. */
const STALL_THRESHOLD_MINUTES = 15;
/** پنجره‌ی عدم تکرار هشدار برای یک چرخه (دقیقه). */
const ALERT_COOLDOWN_MINUTES = 60;
/** برچسب تیم در اعلان‌ها (فارسی، برای فیلتر در داشبورد). */
const WATCHDOG_LABEL = 'نگهبان چرخه';
/** برچسب هشدار بیلد شکسته‌ی سایت. */
const BUILD_WATCH_LABEL = 'نگهبان بیلد سایت';
/** ریپوی سایت تایلندگرد. */
const SITE_REPO = 'masoudroot/thailandgard';
/** ورک‌فلوی دیپلوی سایت. */
const SITE_DEPLOY_WORKFLOW = 'prisma-deploy.yml';
/** شاخه‌ی dev سایت که پل خودکار روی آن مرج می‌کند. */
const SITE_DEV_BRANCH = 'dev';

interface StallInfo {
  cycleId: string;
  runId: string;
  startedAt: string;
  lastTeam: string | null;
  lastTeamStatus: string | null;
  lastProgressAt: string;
  stallMinutes: number;
}

/** مدت توقف را به فارسی روان برمی‌گرداند: «۴۵ دقیقه» یا «۲ ساعت و ۱۰ دقیقه». */
function faDuration(totalMinutes: number): string {
  const m = Math.floor(totalMinutes);
  if (m < 60) return `${faNum(m)} دقیقه`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (rest === 0) return `${faNum(h)} ساعت`;
  return `${faNum(h)} ساعت و ${faNum(rest)} دقیقه`;
}

/** آخرین پیشرفت یک چرخه: تازه‌ترین updated_at یا finished_at در team_runs. */
function lastProgressOf(runs: TeamRun[], cycleStartedAt: string): { at: string; team: string | null; status: string | null } {
  let best: { at: string; team: string | null; status: string | null } = {
    at: cycleStartedAt,
    team: null,
    status: null,
  };
  for (const r of runs) {
    const candidates: Array<{ at: string | null | undefined; team: string; status: string }> = [
      { at: r.finished_at, team: r.team, status: r.status },
      { at: r.updated_at, team: r.team, status: r.status },
      { at: r.started_at, team: r.team, status: r.status },
    ];
    for (const c of candidates) {
      if (c.at && c.at > best.at) {
        best = { at: c.at, team: c.team, status: c.status };
      }
    }
  }
  return best;
}

/** آیا در ۶۰ دقیقه‌ی گذشته برای این چرخه هشداری فرستاده شده؟ (ضد اسپم) */
async function recentlyAlerted(cycleId: string): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - ALERT_COOLDOWN_MINUTES * 60 * 1000).toISOString();
    const { data, error } = await getSupabase()
      .from('notifications')
      .select('id')
      .eq('cycle_id', cycleId)
      .eq('team', WATCHDOG_LABEL)
      .gte('sent_at', cutoff)
      .limit(1);
    if (error) {
      console.error('[cycle-watchdog] بررسی هشدار قبلی ناموفق بود:', error.message);
      return false;
    }
    return (data?.length ?? 0) > 0;
  } catch (err) {
    console.error('[cycle-watchdog] خطا در بررسی هشدار قبلی:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** ساخت متن فارسی هشدار. */
function buildAlertMessage(info: StallInfo): string {
  const lines = [
    'هشدار: چرخه گیر کرده است',
    '',
    `شناسه چرخه: ${info.runId}`,
    `مدت توقف: ${faDuration(info.stallMinutes)}`,
  ];
  if (info.lastTeam) {
    const statusFa =
      info.lastTeamStatus === 'success' ? 'موفق'
      : info.lastTeamStatus === 'failed' ? 'خطای سیستمی'
      : info.lastTeamStatus === 'rejected' ? 'رد شده توسط منتقد'
      : info.lastTeamStatus;
    lines.push(`آخرین فعالیت: تیم ${info.lastTeam} (${statusFa})`);
  } else {
    lines.push('آخرین فعالیت: هیچ تیمی هنوز اجرا نشده است');
  }
  lines.push('', 'این پیام فقط هشدار است؛ چرخه به‌صورت خودکار دست‌کاری نشد.');
  return lines.join('\n');
}

async function checkOneCycle(cycle: { id: string; run_id: string; started_at: string }): Promise<void> {
  const sb = getSupabase();
  const { data: runs, error } = await sb
    .from('team_runs')
    .select('id, team, status, started_at, finished_at, updated_at')
    .eq('cycle_id', cycle.id);
  if (error) {
    console.error(`[cycle-watchdog] خواندن team_runs برای چرخه ${cycle.run_id} ناموفق بود:`, error.message);
    return;
  }
  const teamRuns = (runs ?? []) as TeamRun[];
  const last = lastProgressOf(teamRuns, cycle.started_at);
  const stallMinutes = (Date.now() - new Date(last.at).getTime()) / 60000;

  if (stallMinutes <= STALL_THRESHOLD_MINUTES) {
    console.log(`[cycle-watchdog] چرخه ${cycle.run_id} سالم است؛ آخرین پیشرفت ${Math.floor(stallMinutes)} دقیقه پیش.`);
    return;
  }

  if (await recentlyAlerted(cycle.id)) {
    console.log(`[cycle-watchdog] چرخه ${cycle.run_id} گیر کرده ولی هشدار تازه فرستاده شده؛ رد شد.`);
    return;
  }

  const info: StallInfo = {
    cycleId: cycle.id,
    runId: cycle.run_id,
    startedAt: cycle.started_at,
    lastTeam: last.team,
    lastTeamStatus: last.status,
    lastProgressAt: last.at,
    stallMinutes,
  };
  const message = buildAlertMessage(info);
  const { panelId, telegramMessageId } = await notifyTeamReport({
    team: WATCHDOG_LABEL,
    message,
    cycleId: cycle.id,
  });
  console.log(
    `[cycle-watchdog] هشدار توقف برای چرخه ${cycle.run_id} فرستاده شد ` +
      `(توقف ${faDuration(stallMinutes)}، پنل: ${panelId ?? 'ناموفق'}، تلگرام: ${telegramMessageId ?? 'ناموفق'}).`,
  );
}

async function main(): Promise<void> {
  try {
    const sb = getSupabase();
    const { data: cycles, error } = await sb
      .from('cycles')
      .select('id, run_id, started_at')
      .in('status', ACTIVE_CYCLE_STATUSES)
      .order('started_at', { ascending: false });
    if (error) {
      console.error('[cycle-watchdog] خواندن چرخه‌های فعال ناموفق بود:', error.message);
      return;
    }
    if (!cycles || cycles.length === 0) {
      console.log('[cycle-watchdog] چرخه‌ی فعالی نیست؛ کاری انجام نشد.');
    } else {
      console.log(`[cycle-watchdog] ${faNum(cycles.length)} چرخه‌ی فعال بررسی می‌شود.`);
      for (const cycle of cycles) {
        try {
          await checkOneCycle(cycle as { id: string; run_id: string; started_at: string });
        } catch (err) {
          console.error(`[cycle-watchdog] خطا در بررسی چرخه:`, err instanceof Error ? err.message : err);
        }
      }
    }
    // بررسی بیلد dev سایت (پل خودکار روی آن مرج می‌کند)
    try {
      await checkSiteDevBuild();
    } catch (err) {
      console.error('[cycle-watchdog] خطا در بررسی بیلد سایت:', err instanceof Error ? err.message : err);
    }
  } catch (err) {
    console.error('[cycle-watchdog] خطای کلی:', err instanceof Error ? err.message : err);
  }
}

/**
 * بررسی آخرین بیلد شاخه‌ی dev ریپوی سایت.
 * اگر آخرین اجرای تکمیل‌شده‌ی prisma-deploy روی dev ناموفق باشد، هشدار می‌فرستد.
 * فقط هشدار؛ هیچ دست‌کاری در ریپو یا پچ انجام نمی‌شود.
 */
async function checkSiteDevBuild(): Promise<void> {
  let token: string | null = null;
  try {
    const { getGithubConfig } = await import('../lib/github');
    const cfg = await getGithubConfig();
    token = cfg.token;
  } catch {
    // بدون توکن، بررسی بیلد ممکن نیست
  }
  if (!token) {
    console.log('[cycle-watchdog] توکن گیت‌هاب در دسترس نیست؛ بررسی بیلد سایت رد شد.');
    return;
  }
  const api = `https://api.github.com/repos/${SITE_REPO}/actions/workflows/${SITE_DEPLOY_WORKFLOW}/runs?branch=${SITE_DEV_BRANCH}&per_page=5`;
  let runs: Array<{ id: number; conclusion: string | null; status: string; head_sha: string; html_url: string }> = [];
  try {
    const res = await fetch(api, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.error(`[cycle-watchdog] خواندن وضعیت بیلد سایت ناموفق بود (وضعیت ${res.status}).`);
      return;
    }
    const body = (await res.json()) as { workflow_runs?: typeof runs };
    runs = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
  } catch (err) {
    console.error('[cycle-watchdog] خطا در فراخوانی API بیلد سایت:', err instanceof Error ? err.message : err);
    return;
  }
  // آخرین اجرای تکمیل‌شده
  const done = runs.find((r) => r.status === 'completed');
  if (!done) {
    console.log('[cycle-watchdog] اجرای تکمیل‌شده‌ای برای بیلد dev سایت پیدا نشد.');
    return;
  }
  if (done.conclusion === 'success') {
    console.log(`[cycle-watchdog] بیلد dev سایت سالم است (اجرای ${done.id}).`);
    return;
  }
  // ناموفق: آیا قبلاً برای همین اجرا هشدار داده‌ایم؟
  const dedupKey = `build-${done.id}`;
  try {
    const cutoff = new Date(Date.now() - ALERT_COOLDOWN_MINUTES * 60 * 1000).toISOString();
    const { data, error } = await getSupabase()
      .from('notifications')
      .select('id')
      .eq('team', BUILD_WATCH_LABEL)
      .ilike('message', `%${dedupKey}%`)
      .gte('sent_at', cutoff)
      .limit(1);
    if (!error && (data?.length ?? 0) > 0) {
      console.log(`[cycle-watchdog] بیلد شکسته‌ی dev (اجرای ${done.id}) قبلاً هشدار داده شده؛ رد شد.`);
      return;
    }
  } catch {
    // ادامه می‌دهیم؛ بدترین حالت هشدار تکراری است
  }
  const shortSha = done.head_sha.slice(0, 7);
  const message = [
    'هشدار نگهبان بیلد سایت',
    '',
    `آخرین بیلد شاخه‌ی dev سایت ناموفق بود (${dedupKey}).`,
    `نتیجه: ${done.conclusion ?? 'نامشخص'}`,
    `کامیت: ${shortSha}`,
    `لینک: ${done.html_url}`,
    '',
    'احتمالاً یکی از مرج‌های خودکار پل، بیلد را شکسته است.',
    'بررسی کنید؛ در صورت نیاز از صفحه‌ی پل، رول‌بک بزنید.',
    '',
    'این پیام فقط هشدار است؛ چیزی به‌صورت خودکار برنگردانده نشد.',
  ].join('\n');
  const { panelId, telegramMessageId } = await notifyTeamReport({
    team: BUILD_WATCH_LABEL,
    message,
  });
  console.log(
    `[cycle-watchdog] هشدار بیلد شکسته برای dev فرستاده شد ` +
      `(اجرای ${done.id}، پنل: ${panelId ?? 'ناموفق'}، تلگرام: ${telegramMessageId ?? 'ناموفق'}).`,
  );
}

void main();
