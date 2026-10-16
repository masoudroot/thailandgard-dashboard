/**
 * lib/teams/leader.ts: تیم leader تایلندگرد (موج ۱، دستور مسعود ۱۴۰۵/۰۷/۲۴)
 *
 * رهبر، بک‌لاگ را از داده می‌سازد، تخصیص می‌دهد، چک ساده می‌کند و یادگیری
 * را مدیریت می‌کند. در هر چرخه:
 *
 *   ورودی: intel_feed (تازه‌ترین‌ها)، gsc_queries، page_analytics
 *   خروجی: سقف هوشمند — فقط وقتی دادهٔ تازه و واقعی است، تسک تازه برای
 *           ۴ تیم سازنده (content، seo، design، dev) ساخته می‌شود؛ صفر تسک
 *           هم اگر دادهٔ تازه‌ای نیست، تصمیم درست است. سقف اضطراری ۲۰ تسک
 *           در روز فقط برای جلوگیری از انفجار در صورت باگ.
 *
 * هر تسک: عنوان، توضیح مشخص، معیار قبولی (acceptance)، برآورد تلاش
 * (estimate: ۱=کم‌ریسک، ۲=متوسط، ۳=سنگین).
 *
 * ضدتکراری: تسکی که برای همان تیم با موضوع مشابه در وضعیت باز (pending /
 * approved / in_progress / deferred) هست، دوباره ساخته نمی‌شود.
 * سقف هوشمند (دستور مسعود ۱۴۰۵/۰۷/۲۴): سقف عددی ثابت حذف شده؛ رهبر فقط
 * وقتی تسک می‌سازد که دادهٔ تازه و واقعی در فیدرها باشد، تکراری نباشد، و
 * واقعاً ارزش اجرا داشته باشد. سقف اضطراری ۲۰ تسک در روز فقط برای
 * جلوگیری از انفجار در صورت باگ است.
 *
 * قانون همیشگی: هیچ دادهٔ نمایشی؛ اگر فیدر داده‌ای خالی بود، رهبر از
 * همان دادهٔ موجود کار می‌کند و صادقانه گزارش می‌دهد.
 * قانون مسعود: خط تیرهٔ بلند (U+2014) مطلقاً ممنوع.
 */

import { getSupabase } from '../api';
import { callLLMJson } from '../llm';
import { enqueueTask } from '../taskqueue';
import type {
  MemoryEntry,
  ProgressReporter,
  QueuedTask,
  TeamName,
  TeamResult,
} from '../types';

export const TEAM: TeamName = 'leader';

export const MISSION =
  'از دادهٔ تازه (اینتل، سرچ کنسول، آنالیتیکس) بک‌لاگ می‌سازد و فقط برای کار واقعی تسک مشخص با معیار قبولی به ۴ تیم سازنده تخصیص می‌دهد؛ بدون تکرار، بدون حدس. اگر دادهٔ تازه‌ای نیست، صفر تسک تصمیم درست است.';

/** تیم‌هایی که رهبر برایشان تسک می‌سازد. */
const BUILDER_TEAMS: TeamName[] = ['content', 'seo', 'design', 'dev'];

/** سقف اضطراری رهبر: فقط برای جلوگیری از انفجار در صورت باگ. */
const EMERGENCY_TASK_CEILING = 20;

export interface TeamInput {
  /** گزارش زنده‌ی پیشرفت به ارکستر؛ ارکستر همیشه آن را می‌دهد. */
  reportProgress?: ProgressReporter;
  cycleId: string;
  runId: string;
  ragContext: string;
  memory: MemoryEntry[];
  previousWavesOutput: Record<string, TeamResult | null>;
  /** دستور صریح رهبر/ارکستر از دور اصلاح (همین چرخه)؛ اگر بود، بالاترین اولویت را دارد. */
  reviewDirective?: string;
  /** شمارهٔ دور (۱ = اجرای اول؛ ۲ = دور اصلاح). */
  round?: number;
}

/** یک آیتم تازهٔ اینتل. */
interface IntelItem {
  title: string | null;
  summary: string | null;
  source_name: string | null;
  blog_angle: string | null;
  created_at: string | null;
}

/** یک ردیف کوئری سرچ کنسول. */
interface GscRow {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  avg_position: number | null;
}

/** یک ردیف آنالیتیکس صفحه. */
interface PageRow {
  page_path: string;
  views: number;
  clicks: number;
  impressions: number;
  avg_position: number | null;
}

/** تسک پیشنهادی LLM برای یک تیم سازنده. */
interface PlannedTask {
  team: string;
  title: string;
  description: string;
  acceptance: string;
  estimate: number;
  priority: 'low' | 'medium' | 'high' | 'critical';
  files_hint: string;
}

/** خواندن تازه‌ترین آیتم‌های اینتل (fail-soft). */
async function loadIntelFeed(limit = 20): Promise<IntelItem[]> {
  try {
    const { data, error } = await getSupabase()
      .from('intel_feed')
      .select('title, summary, source_name, blog_angle, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return [];
    return (data ?? []) as IntelItem[];
  } catch {
    return [];
  }
}

/** خواندن کوئری‌های ۷ روز اخیر سرچ کنسول، مرتب بر اساس ایمپرشن (fail-soft). */
async function loadGscQueries(limit = 30): Promise<GscRow[]> {
  try {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const { data, error } = await getSupabase()
      .from('gsc_queries')
      .select('query, clicks, impressions, ctr, avg_position')
      .gte('date', since)
      .order('impressions', { ascending: false })
      .limit(limit);
    if (error) return [];
    return (data ?? []) as GscRow[];
  } catch {
    return [];
  }
}

/** خواندن آنالیتیکس ۷ روز اخیر صفحات (fail-soft). */
async function loadPageAnalytics(limit = 30): Promise<PageRow[]> {
  try {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const { data, error } = await getSupabase()
      .from('page_analytics')
      .select('page_path, views, clicks, impressions, avg_position')
      .gte('date', since)
      .order('impressions', { ascending: false })
      .limit(limit);
    if (error) return [];
    return (data ?? []) as PageRow[];
  } catch {
    return [];
  }
}

/** تعداد تسک‌های leader امروز (سقف روزانه). */
async function countTodayLeaderTasks(): Promise<number> {
  try {
    const dayStart = new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
    const { count, error } = await getSupabase()
      .from('build_queue')
      .select('id', { count: 'exact', head: true })
      .eq('source', 'leader')
      .gte('created_at', dayStart);
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

/** تسک‌های باز (برای ضدتکراری): عنوان + تیم. */
async function loadOpenTasks(): Promise<Array<{ team: string; title: string }>> {
  try {
    const { data, error } = await getSupabase()
      .from('build_queue')
      .select('team, title')
      .in('status', ['pending', 'approved', 'in_progress', 'deferred'])
      .limit(500);
    if (error) return [];
    return ((data ?? []) as Array<{ team: string; title: string }>).map((r) => ({
      team: String(r.team ?? ''),
      title: String(r.title ?? ''),
    }));
  } catch {
    return [];
  }
}

/** نرمال‌سازی عنوان برای مقایسهٔ ضدتکراری. */
function normalizeTitle(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** آیا این تسک، موضوعش با یکی از تسک‌های باز همان تیم هم‌پوشانی دارد؟ */
function isDuplicate(
  team: string,
  title: string,
  open: Array<{ team: string; title: string }>,
): boolean {
  const t = normalizeTitle(title);
  if (t.length < 6) return false;
  return open.some((o) => {
    if (o.team !== team) return false;
    const ot = normalizeTitle(o.title);
    return ot.length >= 6 && (ot.includes(t) || t.includes(ot));
  });
}

function summarizeIntel(items: IntelItem[]): string {
  if (items.length === 0) return '(اینتل تازه‌ای ثبت نشده)';
  return items
    .slice(0, 15)
    .map(
      (it, i) =>
        `${i + 1}. ${it.title ?? '(بدون تیتر)'}` +
        (it.summary ? ` | ${it.summary.slice(0, 160)}` : '') +
        (it.blog_angle ? ` [زاویه: ${it.blog_angle.slice(0, 80)}]` : ''),
    )
    .join('\n');
}

function summarizeGsc(rows: GscRow[]): string {
  if (rows.length === 0) return '(دادهٔ سرچ کنسول در ۷ روز اخیر نیست)';
  return rows
    .slice(0, 20)
    .map(
      (r, i) =>
        `${i + 1}. «${r.query}» | ایمپرشن ${r.impressions}، کلیک ${r.clicks}، ` +
        `پوزیشن ${r.avg_position != null ? r.avg_position.toFixed(1) : '؟'}`,
    )
    .join('\n');
}

function summarizePages(rows: PageRow[]): string {
  if (rows.length === 0) return '(دادهٔ آنالیتیکس صفحات در ۷ روز اخیر نیست)';
  return rows
    .slice(0, 20)
    .map(
      (r, i) =>
        `${i + 1}. ${r.page_path} | بازدید ${r.views}، ایمپرشن ${r.impressions}، ` +
        `پوزیشن ${r.avg_position != null ? r.avg_position.toFixed(1) : '؟'}`,
    )
    .join('\n');
}

/**
 * اجرای یک نوبت تیم leader: ساخت بک‌لاگ روزانه از داده و درج در build_queue.
 */
export async function runTeam(input: TeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;
  const blockers: string[] = [];
  const queued: QueuedTask[] = [];

  await reportLive?.('خواندن فیدرهای داده', 10);
  const [intel, gsc, pages, todayCount, openTasks] = await Promise.all([
    loadIntelFeed(),
    loadGscQueries(),
    loadPageAnalytics(),
    countTodayLeaderTasks(),
    loadOpenTasks(),
  ]);

  // سقف اضطراری: فقط در برابر باگ؛ در حالت عادی هرگز فعال نمی‌شود
  if (todayCount >= EMERGENCY_TASK_CEILING) {
    const summary = `سقف اضطراری رهبر (${EMERGENCY_TASK_CEILING} تسک در روز) فعال شد؛ برای جلوگیری از رفتار غیرعادی، تسک تازه‌ای ساخته نشد.`;
    return { team: TEAM, summary, blockers, tasks: [], approved: true };
  }
  // سقف هوشمند: اگر هیچ دادهٔ تازه‌ای نیست، تسکی ساخته نمی‌شود؛
  // این تصمیم درست است، نه خرابی.
  if (intel.length === 0 && gsc.length === 0 && pages.length === 0) {
    const summary =
      'دادهٔ تازه‌ای در فیدرها نیست (اینتل، سرچ کنسول و آنالیتیکس خالی‌اند)؛ ' +
      'رهبر تسکی نساخت. این تصمیم درست است، نه خرابی.';
    return { team: TEAM, summary, blockers, tasks: [], approved: true };
  }
  const budget = EMERGENCY_TASK_CEILING - todayCount;

  const directive = (input.reviewDirective ?? '').trim();
  await reportLive?.('طراحی تسک‌ها از داده', 40);

  let planned: PlannedTask[] = [];
  try {
    const res = await callLLMJson<{ tasks: PlannedTask[] }>(
      [
        'تو رهبر تیم‌های تایلندگرد هستی. از روی این داده‌های واقعی، برای ۴ تیم سازنده تسک می‌سازی:',
        '',
        'تیم‌ها و کارشان:',
        '- content: مقاله و راهنمای فارسی تازه برای سایت',
        '- seo: متا، هدینگ، لینک داخلی و بهینه‌سازی صفحات موجود',
        '- design: کامپوننت و سکشن راست‌چین فارسی',
        '- dev: فیچر، فیکس و پرفورمنس',
        '',
        'داده‌ها:',
        '== اینتل تازه ==',
        summarizeIntel(intel),
        '',
        '== کوئری‌های سرچ کنسول (۷ روز اخیر) ==',
        summarizeGsc(gsc),
        '',
        '== آنالیتیکس صفحات (۷ روز اخیر) ==',
        summarizePages(pages),
        '',
        directive ? `دستور اصلاح رهبر (حتماً رعایت کن):\n${directive}\n` : '',
        `فقط برای داده‌ای که واقعاً تازه و ارزش اجرا دارد تسک بساز؛ حداکثر ${budget} تسک. صفر تسک هم اشکالی ندارد — برای پر کردن سهمیه تسک نساز.`,
        'قواعد:',
        '- هر تسک فقط برای یکی از ۴ تیم سازنده باشد (content/seo/design/dev)',
        '- عنوان کوتاه و مشخص؛ توضیح: دقیقاً چه کاری، چرا (کدام داده)، و خروجی مورد انتظار چیست',
        '- acceptance: معیار قبولی قابل راستی‌آزمایی در یک جمله',
        '- estimate: ۱=کم‌ریسک (خودکار تأیید می‌شود)، ۲=متوسط، ۳=سنگین',
        '- files_hint: مسیر فایل‌های مرتبط در ریپو (اگر می‌دانی)، وگرنه رشتهٔ خالی',
        '- هیچ عددی نساز؛ فقط از داده‌های بالا استفاده کن',
        '- کاراکتر U+2014 مطلقاً ممنوع',
        '',
        'فقط JSON معتبر بده: {"tasks": [{"team": "content|seo|design|dev", "title": "...", "description": "...", "acceptance": "...", "estimate": 1|2|3, "priority": "low|medium|high|critical", "files_hint": "..."}]}',
        'خروجی باید دقیقاً با { شروع و با } تمام شود. هیچ متن، توضیح یا کدفنس قبل و بعد از JSON ننویس.',
      ].join('\n'),
      { system: 'تو رهبر عمل‌گرای تیم‌های تایلندگرد هستی؛ از داده تسک مشخص می‌سازی، نه حرف کلی.' },
    );
    planned = Array.isArray(res.tasks) ? res.tasks : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    blockers.push(`طراحی تسک با LLM ناموفق بود: ${msg}`);
    return { team: TEAM, summary: blockers[0], blockers, tasks: [], approved: false };
  }

  await reportLive?.('ثبت تسک‌ها در صف', 75);
  const validTeams = new Set<string>(BUILDER_TEAMS);
  let skippedDup = 0;
  let skippedInvalid = 0;
  for (const p of planned.slice(0, budget)) {
    const team = String(p.team ?? '').trim();
    const title = String(p.title ?? '').trim();
    const description = String(p.description ?? '').trim();
    const acceptance = String(p.acceptance ?? '').trim();
    const estimate = [1, 2, 3].includes(Number(p.estimate)) ? (Number(p.estimate) as 1 | 2 | 3) : 2;
    const priority = ['low', 'medium', 'high', 'critical'].includes(p.priority)
      ? p.priority
      : 'medium';
    if (!validTeams.has(team) || !title || !description || !acceptance) {
      skippedInvalid++;
      continue;
    }
    if (isDuplicate(team, title, openTasks)) {
      skippedDup++;
      continue;
    }
    try {
      const id = await enqueueTask({
        team,
        title,
        description,
        files_hint: String(p.files_hint ?? ''),
        priority,
        source: 'leader',
        acceptance,
        estimate,
        cycleId: input.cycleId,
      });
      openTasks.push({ team, title }); // ضدتکراری درون همین اجرا
      queued.push({ title, description, files_hint: String(p.files_hint ?? ''), priority });
      console.log(`[leader] تسک «${title}» برای تیم ${team} ثبت شد (id=${id}).`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      blockers.push(`ثبت تسک «${title}» ناموفق بود: ${msg}`);
    }
  }

  await reportLive?.('پایان کار', 100);
  const summary =
    `رهبر ${queued.length} تسک تازه از داده ساخت و در صف ثبت کرد ` +
    `(اینتل: ${intel.length} آیتم، سرچ کنسول: ${gsc.length} کوئری، آنالیتیکس: ${pages.length} صفحه).` +
    (skippedDup > 0 ? ` ${skippedDup} مورد تکراری رد شد.` : '') +
    (skippedInvalid > 0 ? ` ${skippedInvalid} مورد نامعتبر رد شد.` : '') +
    (blockers.length > 0 ? ` ${blockers.length} خطای ثبت.` : '');

  return {
    team: TEAM,
    summary,
    blockers,
    tasks: queued,
    approved: blockers.length === 0,
  };
}
