/**
 * نگهبان چرخه‌ی تایلندگرد: هشدار خودکار برای چرخه‌ی گیرکرده و تیم هنگ‌کرده.
 *
 * هر ۱۰ دقیقه اجرا می‌شود (ورک‌فلو cycle-watchdog.yml):
 *  ۱. برای هر تیمِ در حال اجرا، سلامت را با دو سیگنال جدا می‌سنجد
 *     (heartbeat_at = زنده‌بودن فرایند، updated_at = آخرین پیشرفت واقعی):
 *     - ضربان زنده ولی بیش از ۱۰ دقیقه بدون پیشرفت → «هنگ» → هشدار تیمی؛
 *     - بیش از ۱۵ دقیقه بدون هیچ ضربانی → «مرده» → هشدار تیمی؛
 *  ۲. اگر کل چرخه بیش از ۱۰ دقیقه هیچ پیشرفتی نکرده باشد (نه اتمام، نه
 *     به‌روزرسانی واقعی)، هشدار سطح-چرخه می‌فرستد (پشتیبان)؛
 *  ۳. برای جلوگیری از اسپم، برای هر (چرخه، تیم، وضعیت) حداکثر هر ۶۰ دقیقه
 *     یک هشدار می‌فرستد.
 *
 * نکته‌ی ریشه‌ای: پیش از جداسازی ضربان از پیشرفت، updated_at با هر ضربانِ
 * ۶۰ ثانیه‌ای تازه می‌شد و تیمِ هنگِ ضربان‌زن همیشه «سالم» دیده می‌شد.
 * حالا updated_at فقط با پیشرفت واقعی تازه می‌شود، پس هنگ در ≤۱۰ دقیقه
 * (در اولین اجرای نگهبان پس از عبور از آستانه) شناسایی می‌شود.
 *
 * قانون سفت: این اسکریپت فقط هشدار می‌دهد و هرگز چرخه، قفل یا تیمی را
 * دست‌کاری نمی‌کند (نه به‌روزرسانی وضعیت، نه آزادسازی قفل، نه شروع/توقف).
 * هیچ‌وقت throw نمی‌کند تا ورک‌فلو سبز بماند.
 *
 * اجرا: npx tsx worker/cycle-watchdog.ts
 * نیازمند: SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY در env
 */
import { getSupabase } from '../lib/api';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ACTIVE_CYCLE_STATUSES, type TeamRun } from '../lib/types';
import { notifyTeamReport } from '../lib/notify';
import { faNum } from '../lib/format';
import { findUnhealthyTeams, type UnhealthyTeam } from '../lib/team-health';
import { pathToFileURL } from 'node:url';

/** آستانه‌ی توقف: بیش از این دقیقه بدون پیشرفت واقعی یعنی گیر کرده است. */
const STALL_THRESHOLD_MINUTES = 10;
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

/** آیا در ۶۰ دقیقه‌ی گذشته برای این کلید (چرخه یا چرخه+تیم) هشداری فرستاده شده؟ (ضد اسپم) */
async function recentlyAlerted(sb: SupabaseClient, cycleId: string, dedupKey?: string): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - ALERT_COOLDOWN_MINUTES * 60 * 1000).toISOString();
    let q = sb
      .from('notifications')
      .select('id')
      .eq('cycle_id', cycleId)
      .eq('team', WATCHDOG_LABEL)
      .gte('sent_at', cutoff);
    if (dedupKey) q = q.ilike('message', `%${dedupKey}%`);
    const { data, error } = await q.limit(1);
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
  // اول سطح-تیم: هنگ/مرگ هر تیمِ در حال اجرا جداگانه شناسایی و هشدار داده می‌شود.
  try {
    await checkHungTeams(sb, cycle);
  } catch (err) {
    console.error(`[cycle-watchdog] خطا در بررسی هنگ تیم‌های چرخه ${cycle.run_id}:`, err instanceof Error ? err.message : err);
  }

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

  if (await recentlyAlerted(sb, cycle.id)) {
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

/** ساخت متن فارسی هشدار هنگ/مرگ یک تیم. */
function buildHangAlertMessage(
  runId: string,
  t: UnhealthyTeam,
  dedupKey: string,
): string {
  const hb = t.minutesWithoutHeartbeat;
  const hbLine =
    hb === null
      ? 'ضربان: هیچ ضربانی ثبت نشده است'
      : hb <= 10
        ? `ضربان: زنده (آخرین ضربان ${faDuration(hb)} پیش) — فرایند زنده است ولی کار جلو نمی‌رود`
        : `ضربان: قطع شده (آخرین ضربان ${faDuration(hb)} پیش)`;
  const lines = [
    t.health === 'hung' ? 'هشدار: تیم هنگ کرده است' : 'هشدار: فرایند تیم به نظر مرده می‌رسد',
    '',
    `چرخه: ${runId}`,
    `تیم: ${t.team}`,
  ];
  if (t.health === 'hung') {
    lines.push(`بدون هیچ پیشرفتی: ${faDuration(t.minutesWithoutProgress)} (آستانه: ۱۰ دقیقه)`);
    lines.push(hbLine);
  } else {
    lines.push(
      `بدون ضربان: ${hb === null ? 'هیچ‌وقت' : faDuration(hb)} (آستانه: ۱۵ دقیقه)`,
    );
    lines.push(`آخرین پیشرفت واقعی: ${faDuration(t.minutesWithoutProgress)} پیش`);
  }
  if (t.currentTask) lines.push(`مرحله‌ی جاری: ${t.currentTask}`);
  lines.push(
    '',
    'ورکر در تیک بعدی این تیم را «ناموفق» ثبت می‌کند تا موج جلو برود.',
    'این پیام فقط هشدار است؛ چرخه به‌صورت خودکار دست‌کاری نشد.',
    '',
    dedupKey,
  );
  return lines.join('\n');
}

/**
 * بررسی سطح-تیم: تیم‌های ناسالم (هنگ/مرده) را با همان منطق مشترک ورکر
 * (findUnhealthyTeams در lib/team-health) پیدا می‌کند و برای هر کدام
 * هشدار جداگانه می‌فرستد.
 * فقط هشدار؛ هیچ دست‌کاری در وضعیت تیم انجام نمی‌شود.
 *
 * کلاینت دیتابیس و تابع اطلاع‌رسانی تزریق می‌شوند تا مسیر واقعی
 * (خواندن ردیف‌های واقعی، طبقه‌بندی واقعی، ضداسپم واقعی) در تست هم
 * اجرا شود؛ پیش‌فرض‌ها همان مسیر پروداکشن‌اند.
 */
export async function checkHungTeams(
  sb: SupabaseClient,
  cycle: { id: string; run_id: string },
  notify: typeof notifyTeamReport = notifyTeamReport,
): Promise<void> {
  let bad: UnhealthyTeam[];
  try {
    bad = await findUnhealthyTeams(sb, cycle.id);
  } catch (err) {
    console.error(
      `[cycle-watchdog] خطا در بررسی هنگ تیم‌های چرخه ${cycle.run_id}:`,
      err instanceof Error ? err.message : err,
    );
    return;
  }

  for (const t of bad) {
    const dedupKey = `[hang:${t.team}:${t.health}]`;
    if (await recentlyAlerted(sb, cycle.id, dedupKey)) {
      console.log(`[cycle-watchdog] تیم ${t.team} (${t.health}) قبلاً هشدار داده شده؛ رد شد.`);
      continue;
    }
    const message = buildHangAlertMessage(cycle.run_id, t, dedupKey);
    const { panelId, telegramMessageId } = await notify({
      team: WATCHDOG_LABEL,
      message,
      cycleId: cycle.id,
    });
    console.log(
      `[cycle-watchdog] هشدار «${t.health === 'hung' ? 'هنگ' : 'مرگ فرایند'}» برای تیم ${t.team} ` +
        `در چرخه ${cycle.run_id} فرستاده شد (پنل: ${panelId ?? 'ناموفق'}، تلگرام: ${telegramMessageId ?? 'ناموفق'}).`,
    );
  }
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

// فقط وقتی مستقیم اجرا شد (npx tsx worker/cycle-watchdog.ts) main را بزن؛
// با ایمپورت (تست) اجرا نشود.
if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
