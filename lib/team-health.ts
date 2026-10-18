import type { SupabaseClient } from '@supabase/supabase-js';
import { settleOrphanedClaimedTasks } from './taskqueue';

/**
 * سلامت اجرای تیم‌ها: تشخیص «هنگ» در برابر «سالم» و «مرده».
 *
 * ریشه‌ی باگ (رفع‌شده در مایگریشن 20261016160000_team_runs_heartbeat):
 * ضربان ۶۰ ثانیه‌ای ارکستراتور ردیف team_runs را لمس می‌کرد و تریگر دیتابیس
 * روی هر UPDATE ستون updated_at را تازه می‌کرد؛ پس تیمی که ضربان می‌زد ولی
 * هیچ پیشرفتی نمی‌کرد، همیشه «سالم» دیده می‌شد.
 *
 * مدل جدید دو سیگنال جدا دارد:
 *  - heartbeat_at: زنده‌بودنِ فرایند (ضربان هر ۶۰ ثانیه فقط همین ستون را می‌نویسد)
 *  - updated_at:   آخرین «پیشرفت واقعی» (تغییر وضعیت، درصد، مرحله، خروجی، خطا)
 *
 * طبقه‌بندی یک تیمِ در حال اجرا:
 *  - dead:  بیش از ۱۵ دقیقه هیچ ضربانی نزده  → فرایند احتمالاً مرده است
 *  - hung:  ضربان زنده است ولی بیش از ۱۵ دقیقه هیچ پیشرفتی نشده → هنگ کرده است
 *  - healthy: در غیر این صورت
 *
 * چرا آستانه‌ی هنگ ۱۵ دقیقه است (نه ۱۰)؟ (۲۵ مهر ۱۴۰۵)
 * تسک‌های عادی سامانه (نوشتن راهنمای چندبخشی با حلقه‌ی نقد در content،
 * بهینه‌سازی صفحه با ده‌ها فراخوانی در seo) به‌طور سالم ۱۰ تا ۲۰ دقیقه
 * کار می‌کنند بی‌آن‌که مرز مرحله‌ای updated_at را لمس کنند. آستانه‌ی
 * ۱۰ دقیقه دو بار تیمِ سالمِ در حال کار را کشت (u7n2ku/content با
 * ۱۱ پاسخ موفق و بدون هیچ خطا؛ 31epjc/seo) و چرخه‌ها را ناموفق کرد.
 * نگهبانِ فرایندِ واقعاً مرده همان آستانه‌ی ۱۵دقیقه‌ای dead است و
 * تایم‌اوت ۲۵دقیقه‌ای تیک هم سقف نهایی هر اجرای تیم است.
 *
 * تابع classifyTeamRun خالص است تا مستقیم تست شود؛ sweepHungTeams همان منطق
 * را روی دیتابیس واقعی اجرا می‌کند (ورکر چرخه و تست واقعی هر دو از آن
 * استفاده می‌کنند).
 */

/**
 * تیمِ در حال اجرا چقدر بی‌پیشرفت بماند تا «هنگ» شناخته شود.
 * ۱۵ دقیقه (۲۵ مهر ۱۴۰۵؛ قبلاً ۱۰ بود): تسک‌های سالم چندفراخوانی
 * (content/seo) به‌طور عادی بیش از ۱۰ دقیقه بی‌مرزِ مرحله کار می‌کنند؛
 * آستانه‌ی ۱۰ دقیقه دو بار تیم سالم را کشت و چرخه را ناموفق کرد.
 */
export const HANG_NO_PROGRESS_MS = 15 * 60 * 1000;
/** ضربان چقدر قطع بماند تا فرایند «مرده» شناخته شود. */
export const DEAD_HEARTBEAT_MS = 15 * 60 * 1000;

export type TeamHealth = 'healthy' | 'hung' | 'dead';

export interface TeamRunHealthInput {
  status: string;
  heartbeatAt?: string | null;
  updatedAt?: string | null;
  startedAt?: string | null;
  /** برای تست؛ پیش‌فرض Date.now(). */
  now?: number;
}

function toMs(value: string | null | undefined): number {
  if (!value) return NaN;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? NaN : t;
}

/**
 * طبقه‌بندی سلامت یک ردیف team_runs. خالص و بدون I/O.
 * تیمی که running نیست، از نظر نگهبان «idle» است و کاری با آن نداریم
 * (فراخوان آن را رد می‌کند؛ این تابع برای غیر-running مقدار 'healthy'
 * برمی‌گرداند تا فراخوان ساده بماند).
 */
export function classifyTeamRun(input: TeamRunHealthInput): TeamHealth {
  const now = input.now ?? Date.now();
  if (input.status !== 'running') return 'healthy';

  const heartbeatMs = toMs(input.heartbeatAt);
  const progressMs = toMs(input.updatedAt);
  const startedMs = toMs(input.startedAt);

  // مبنای زنده‌بودن: heartbeat_at اگر هست؛ اگر نیست (ردیف قدیمیِ پیش از
  // مایگریشن) به updated_at برمی‌گردیم که پس از فیکس تریگر دیگر با ضربان
  // آلوده نمی‌شود.
  const liveMs = !Number.isNaN(heartbeatMs)
    ? heartbeatMs
    : !Number.isNaN(progressMs)
      ? progressMs
      : startedMs;

  // ۱. مرگ فرایند: مدت طولانی هیچ ضربانی (و هیچ نشانه‌ی حیاتی) نیست.
  if (!Number.isNaN(liveMs) && now - liveMs > DEAD_HEARTBEAT_MS) return 'dead';

  // ۲. هنگ: فرایند زنده است (ضربان تازه) ولی پیشرفتی رخ نداده است.
  // اگر updated_at نامعتبر بود، از زمان شروع به‌عنوان آخرین پیشرفت استفاده کن.
  const lastProgressMs = !Number.isNaN(progressMs) ? progressMs : startedMs;
  if (!Number.isNaN(lastProgressMs) && now - lastProgressMs > HANG_NO_PROGRESS_MS) return 'hung';

  return 'healthy';
}

export interface HungSweepResult {
  team: string;
  health: 'hung' | 'dead';
  /** دقیقه‌ی سپری‌شده از آخرین پیشرفت واقعی (برای پیام خطا/هشدار). */
  minutesWithoutProgress: number;
  /** دقیقه‌ی سپری‌شده از آخرین ضربان (null اگر ضربانی ثبت نشده). */
  minutesWithoutHeartbeat: number | null;
}

/**
 * جزئیات یک تیمِ ناسالم برای گزارش. خروجی findUnhealthyTeams است؛
 * خودِ تابع هیچ دست‌کاری در دیتابیس نمی‌کند.
 */
export interface UnhealthyTeam extends HungSweepResult {
  currentTask?: string | null;
  startedAt: string | null;
  updatedAt?: string | null;
  heartbeatAt?: string | null;
}

interface TeamRunRow {
  team: string;
  status: string;
  started_at: string | null;
  updated_at?: string | null;
  heartbeat_at?: string | null;
  current_task?: string | null;
}

/** آیا خطای PostgREST یعنی «ستون heartbeat_at هنوز وجود ندارد»؟ */
function isMissingHeartbeatColumn(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === '42703' || /heartbeat_at/.test(err.message ?? '');
}

const HUNG_ERROR = (m: number, hbStaleMin: number | null) =>
  `هنگ شناسایی شد: بیش از ۱۵ دقیقه بدون هیچ پیشرفتی (آخرین پیشرفت ${m} دقیقه پیش)` +
  (hbStaleMin === null || hbStaleMin <= 10
    ? ' با وجود زنده‌بودن ضربان.'
    : `؛ ضربان هم ${hbStaleMin} دقیقه است که قطع است.`);
const DEAD_ERROR = (m: number | null) =>
  `تایم‌اوت ورکر: فرایند تیم بیش از ۱۵ دقیقه هیچ ضربانی نزده است` +
  (m === null ? '' : ` (آخرین ضربان ${m} دقیقه پیش)`);

/** خواندن ردیف‌های running یک چرخه؛ اگر ستون heartbeat_at نباشد عقب‌گرد می‌کند. */
async function readRunningTeams(sb: SupabaseClient, cycleId: string): Promise<TeamRunRow[]> {
  const full = await sb
    .from('team_runs')
    .select('team, status, started_at, updated_at, heartbeat_at, current_task')
    .eq('cycle_id', cycleId)
    .eq('status', 'running');
  if (!full.error) return (full.data ?? []) as TeamRunRow[];
  if (!isMissingHeartbeatColumn(full.error)) {
    console.error('[team-health] خواندن team_runs ناموفق بود:', full.error.message);
    return [];
  }
  // مایگریشن ضربان هنوز اعمال نشده؛ بدون heartbeat_at ادامه بده
  // (classifyTeamRun در این حالت به updated_at برمی‌گردد).
  console.warn('[team-health] ستون heartbeat_at نیست؛ بدون سیگنال ضربان بررسی شد.');
  const base = await sb
    .from('team_runs')
    .select('team, status, started_at, updated_at, current_task')
    .eq('cycle_id', cycleId)
    .eq('status', 'running');
  if (base.error) {
    console.error('[team-health] خواندن team_runs ناموفق بود:', base.error.message);
    return [];
  }
  return (base.data ?? []) as TeamRunRow[];
}

/**
 * یافتن تیم‌های ناسالم یک چرخه (فقط خواندن؛ هیچ دست‌کاری نمی‌کند).
 * ورکر (برای «ناموفق» ثبت‌کردن = جلو رفتن موج) و واچ‌داگ (فقط هشدار)
 * هر دو از همین تابع استفاده می‌کنند تا منطق تشخیص دو جا تکرار نشود.
 * هرگز throw نمی‌کند.
 */
export async function findUnhealthyTeams(
  sb: SupabaseClient,
  cycleId: string,
  now: number = Date.now(),
): Promise<UnhealthyTeam[]> {
  const out: UnhealthyTeam[] = [];
  let rows: TeamRunRow[];
  try {
    rows = await readRunningTeams(sb, cycleId);
  } catch (err) {
    console.error('[team-health] خطا در خواندن team_runs:', err instanceof Error ? err.message : err);
    return out;
  }
  for (const r of rows) {
    let health: TeamHealth;
    try {
      health = classifyTeamRun({
        status: r.status,
        heartbeatAt: r.heartbeat_at ?? null,
        updatedAt: r.updated_at ?? null,
        startedAt: r.started_at ?? null,
        now,
      });
    } catch (err) {
      console.error(`[team-health] خطا در طبقه‌بندی تیم ${r.team}:`, err instanceof Error ? err.message : err);
      continue;
    }
    if (health === 'healthy') continue;
    const progressMs = toMs(r.updated_at ?? r.started_at ?? null);
    const heartbeatMs = toMs(r.heartbeat_at ?? null);
    const minutesWithoutProgress = Number.isNaN(progressMs)
      ? Math.round((now - (toMs(r.started_at) || now)) / 60000)
      : Math.floor((now - progressMs) / 60000);
    const minutesWithoutHeartbeat = Number.isNaN(heartbeatMs) ? null : Math.floor((now - heartbeatMs) / 60000);
    out.push({
      team: r.team,
      health,
      minutesWithoutProgress,
      minutesWithoutHeartbeat,
      currentTask: r.current_task ?? null,
      startedAt: r.started_at,
      updatedAt: r.updated_at ?? null,
      heartbeatAt: r.heartbeat_at ?? null,
    });
  }
  return out;
}

/**
 * جاروی تیم‌های گیرکرده‌ی یک چرخه: تیم‌های ناسالم (hung/dead) را «ناموفق»
 * ثبت می‌کند تا موج جلو برود (همان «ری‌استارت» چرخه) و نتیجه را برمی‌گرداند
 * تا فراخوان (ورکر/واچ‌داگ) گزارش دهد. هرگز throw نمی‌کند.
 */
export async function sweepHungTeams(
  sb: SupabaseClient,
  cycleId: string,
  now: number = Date.now(),
): Promise<HungSweepResult[]> {
  const results: HungSweepResult[] = [];
  const bad = await findUnhealthyTeams(sb, cycleId, now);

  for (const t of bad) {
    const error =
      t.health === 'hung'
        ? HUNG_ERROR(t.minutesWithoutProgress, t.minutesWithoutHeartbeat)
        : DEAD_ERROR(t.minutesWithoutHeartbeat);

    try {
      // فقط ردیف‌هایی که «هنوز» running هستند ناموفق می‌شوند؛ بین خواندن
      // (findUnhealthyTeams) و این UPDATE ممکن است تیم کارش را تمام و
      // موفق ثبت کرده باشد — آن موفقیت نباید با failed بازنویسی شود.
      // (رفع race: قبلاً فیلتر status نبود و همه‌ی ردیف‌های تیم failed می‌شد.)
      const { error: updErr } = await sb
        .from('team_runs')
        .update({ status: 'failed', error, finished_at: new Date(now).toISOString() })
        .eq('cycle_id', cycleId)
        .eq('team', t.team)
        .eq('status', 'running');
      if (updErr) {
        console.error(`[team-health] ثبت ناموفق برای تیم ${t.team} خطا داد:`, updErr.message);
        continue;
      }
    } catch (err) {
      console.error(`[team-health] خطا در ثبت ناموفق تیم ${t.team}:`, err instanceof Error ? err.message : err);
      continue;
    }
    console.log(`[team-health] تیم ${t.team} «${t.health === 'hung' ? 'هنگ' : 'مرده'}» شناخته و ناموفق ثبت شد.`);
    // بستن تسک‌های یتیم: اگر فرایند تیم بدون settle مرده باشد (ری‌بوت/SIGKILL)،
    // تسک claimشده‌اش in_progress می‌ماند و چرخه‌ی بعدی همان کهنه را تحویل
    // می‌گیرد؛ این‌جا با سرنوشت interrupted بسته می‌شود. fail-soft است.
    try {
      const healthFa = t.health === 'hung' ? 'هنگ' : 'مرگ فرایند';
      const settled = await settleOrphanedClaimedTasks(
        t.team,
        cycleId,
        `تیم ${t.team} در جاروی سلامت «${healthFa}» شناخته و ناموفق ثبت شد؛ ` +
          `فرایند اجراکننده در دسترس نیست (${error}).`,
      );
      if (settled > 0) {
        console.log(`[team-health] ${settled} تسک یتیم تیم ${t.team} بسته شد.`);
      }
    } catch (err) {
      console.error(
        `[team-health] بستن تسک‌های یتیم تیم ${t.team} خطا داد:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    results.push({
      team: t.team,
      health: t.health,
      minutesWithoutProgress: t.minutesWithoutProgress,
      minutesWithoutHeartbeat: t.minutesWithoutHeartbeat,
    });
  }
  return results;
}

/**
 * «موفقیت توخالی»: تیمی که وضعیت success گرفته ولی عملاً چیزی تحویل نداده.
 *
 * خطرناک‌ترین خرابیِ بی‌صداست: گیت ساختاری ارکستراتور (validateWorkerOutput)
 * خروجیِ «کاملاً خالی» را پیش از ثبت success رد می‌کند، ولی تیمی که یک
 * پاراگرافِ روانِ بی‌محتوا تحویل بدهد از آن گیت رد می‌شود و success می‌گیرد
 * بی‌آن‌که حتی یک پچ در bridge_patches ثبت کرده باشد. این تابع همان شکافِ
 * پسینی را می‌بندد.
 *
 * معیار پرچم (محافظه‌کارانه، برای جلوگیری از هشدار کاذب):
 *   - هیچ پچی برای (تیم، چرخه) در bridge_patches ثبت نشده، و
 *   - (خلاصه‌ی خروجی خالی است یا هیچ فراخوانی LLM ثبت نشده)
 * تیم تحلیلی که گزارش واقعی نوشته (hasSummary=true) یا واقعاً کار کرده
 * (llmCalls>0) پرچم نمی‌خورد؛ فقط ترکیب «نه پچ، نه خلاصه/نه کار» پرچم می‌خورد.
 *
 * فقط خواندن؛ هیچ دست‌کاری در دیتابیس نمی‌کند. هرگز throw نمی‌کند.
 * واچ‌داگ می‌تواند خروجی را بگیرد و مثل هشدارهای هنگ/مرگ، به پنل و تلگرام
 * اطلاع‌رسانی کند.
 */
export interface EmptySuccessTeam {
  team: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** تعداد فراخوانی‌های LLM ثبت‌شده برای این اجرا. */
  llmCalls: number;
  /** تعداد پچ‌های ثبت‌شده‌ی تیم در این چرخه (هر وضعیتی؛ حتی ردشده یعنی «چیزی تولید شد»). */
  patchCount: number;
  /** آیا خلاصه‌ی خروجی غیرخالی ثبت شده؟ */
  hasSummary: boolean;
  /** زیرمجموعه‌ای از: 'no-patches' | 'no-summary' | 'no-llm-calls' */
  reasons: string[];
}

interface SuccessRunRow {
  team: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  llm_calls?: number | null;
  output_summary?: string | null;
}

export async function findEmptySuccessTeams(
  sb: SupabaseClient,
  cycleId: string,
): Promise<EmptySuccessTeam[]> {
  const out: EmptySuccessTeam[] = [];
  try {
    const { data: runs, error } = await sb
      .from('team_runs')
      .select('team, status, started_at, finished_at, llm_calls, output_summary')
      .eq('cycle_id', cycleId)
      .eq('status', 'success')
      .order('started_at', { ascending: false });
    if (error) {
      console.error('[team-health] خواندن اجراهای موفق ناموفق بود:', error.message);
      return out;
    }
    // فقط آخرین اجرای هر تیم؛ سرنوشت تلاش‌های قدیمی‌تر مشخص است.
    const latest = new Map<string, SuccessRunRow>();
    for (const r of (runs ?? []) as SuccessRunRow[]) {
      if (!latest.has(r.team)) latest.set(r.team, r);
    }
    if (latest.size === 0) return out;

    // شمارش پچ‌های هر تیم در این چرخه (هر وضعیتی).
    const patchCounts = new Map<string, number>();
    try {
      const { data: patches, error: pErr } = await sb
        .from('bridge_patches')
        .select('team')
        .eq('cycle_id', cycleId);
      if (pErr) {
        console.error('[team-health] خواندن bridge_patches ناموفق بود:', pErr.message);
      } else {
        for (const p of (patches ?? []) as Array<{ team?: string | null }>) {
          const t = p.team ?? '';
          if (t) patchCounts.set(t, (patchCounts.get(t) ?? 0) + 1);
        }
      }
    } catch (err) {
      console.error(
        '[team-health] خطا در خواندن bridge_patches:',
        err instanceof Error ? err.message : err,
      );
    }

    for (const [team, r] of Array.from(latest.entries())) {
      const patchCount = patchCounts.get(team) ?? 0;
      const llmCalls = typeof r.llm_calls === 'number' ? r.llm_calls : 0;
      const hasSummary =
        typeof r.output_summary === 'string' && r.output_summary.trim().length > 0;
      if (patchCount === 0 && (!hasSummary || llmCalls === 0)) {
        const reasons: string[] = ['no-patches'];
        if (!hasSummary) reasons.push('no-summary');
        if (llmCalls === 0) reasons.push('no-llm-calls');
        out.push({
          team,
          startedAt: r.started_at,
          finishedAt: r.finished_at,
          llmCalls,
          patchCount,
          hasSummary,
          reasons,
        });
        console.log(
          `[team-health] «موفقیت توخالی» مشکوک برای تیم ${team} ` +
            `(پچ: ۰، خلاصه: ${hasSummary ? 'دارد' : 'ندارد'}، فراخوان LLM: ${llmCalls}).`,
        );
      }
    }
  } catch (err) {
    console.error(
      '[team-health] خطا در بررسی موفقیت‌های توخالی:',
      err instanceof Error ? err.message : err,
    );
  }
  return out;
}
