/**
 * lib/teams/leader.ts: تیم leader تایلندگرد (موج ۱، دستور مسعود ۱۴۰۵/۰۷/۲۴)
 *
 * رهبر، بک‌لاگ را از داده می‌سازد، تخصیص می‌دهد، چک ساده می‌کند و یادگیری
 * را مدیریت می‌کند. در هر چرخه:
 *
 *   ورودی: intel_feed (۷ روز اخیر)، gsc_queries (۷ روز اخیر، تجمیع‌شده بر اساس
 *           کوئری)، page_analytics (۷ روز اخیر، تجمیع‌شده بر اساس مسیر صفحه)
 *   خروجی: سقف هوشمند: فقط وقتی دادهٔ تازه و واقعی است، تسک تازه برای
 *           ۴ تیم سازنده (content، seo، design، dev) ساخته می‌شود؛ صفر تسک
 *           هم اگر دادهٔ تازه‌ای نیست، تصمیم درست است.
 *
 * هر تسک: عنوان، توضیح مشخص، معیار قبولی (acceptance)، برآورد تلاش
 * (estimate: ۱=کم‌ریسک، ۲=متوسط، ۳=سنگین).
 *
 * ضدتکراری: تسکی که برای همان تیم با موضوع مشابه در وضعیت باز (pending /
 * approved / in_progress / deferred) هست، دوباره ساخته نمی‌شود.
 * ضدتکراری معنایی (دستور مسعود ۱۴۰۵/۰۷/۲۴): رهبر پیش از ساخت تسک content
 * تازه، راهنماهای موجود روی سایت را می‌خواند؛ اگر موضوع تسک پیشنهادی با
 * یکی از آن‌ها هم‌پوشانی معنایی داشت (شباهت ژاکار کلیدواژه‌ها)، به‌جای
 * محتوای تازه، تسک «[آپدیت]» برای همان موجود می‌سازد. زاویهٔ واقعاً متفاوت
 * مجاز است ولی باید در بریف مشخص شود.
 * سقف هوشمند (دستور مسعود ۱۴۰۵/۰۷/۲۴): سقف عددی ثابت حذف شده؛ رهبر فقط
 * وقتی تسک می‌سازد که دادهٔ تازه و واقعی در فیدرها باشد، تکراری نباشد، و
 * واقعاً ارزش اجرا داشته باشد. (سقف اضطراری ۲۰ تسک/روز که قبلاً برای
 * جلوگیری از انفجار در صورت باگ بود، به دستور مسعود در ۱۴۰۵/۰۷/۲۵
 * برداشته شد و برنمی‌گردد؛ بودجه نامحدود ولی فقط برای دادهٔ واقعی.)
 *
 * قانون همیشگی: هیچ دادهٔ نمایشی؛ اگر فیدر داده‌ای خالی بود، رهبر از
 * همان دادهٔ موجود کار می‌کند و صادقانه گزارش می‌دهد.
 * قانون مسعود: خط تیرهٔ بلند (U+2014) مطلقاً ممنوع.
 */

import { getSupabase } from '../api';
import { readSiteFile } from '../bridge/read';
import { callLLMJson } from '../llm';
import { enqueueTask, formatError } from '../taskqueue';
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

/** خواندن آیتم‌های اینتلِ ۷ روز اخیر، تازه‌ترین اول (fail-soft). */
async function loadIntelFeed(limit = 20): Promise<IntelItem[]> {
  try {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const { data, error } = await getSupabase()
      .from('intel_feed')
      .select('title, summary, source_name, blog_angle, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return [];
    return (data ?? []) as IntelItem[];
  } catch {
    return [];
  }
}

/**
 * خواندن کوئری‌های ۷ روز اخیر سرچ کنسول، تجمیع‌شده بر اساس کوئری (fail-soft).
 *
 * جدول gsc_queries ردیف روزانه دارد (UNIQUE(query, date))؛ پس ردیف‌ها اول
 * در حافظه تجمیع می‌شوند وگرنه یک کوئری تا ۷ بار تکرار می‌شد و آستانه‌های
 * نگهداشت روی عدد روزانهٔ اشتباه اعمال می‌شد. CTR از نو حساب می‌شود و
 * پوزیشن میانگین وزنی با ایمپرشن است.
 * ردیف‌های دیتابیس با safeNum ضدّتهی‌سازی می‌شوند تا null سر جایشان ننشیند.
 */

/** عدد امن از دیتابیس: هر چه غیرعددی بود، صفر. */
function safeNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** عدد امنِ تهی‌پذیر از دیتابیس: هر چه غیرعددی بود، null. */
function safeNumOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
async function loadGscQueries(limit = 30): Promise<GscRow[]> {
  try {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const { data, error } = await getSupabase()
      .from('gsc_queries')
      .select('query, clicks, impressions, avg_position')
      .gte('date', since)
      .order('date', { ascending: false }) // اگر برش ۵۰۰۰ ردیف فعال شد، تازه‌ترین روزها بمانند
      .limit(5000);
    if (error) return [];
    const byQuery = new Map<
      string,
      { clicks: number; impressions: number; posW: number; posImp: number }
    >();
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const q = String(r.query ?? '').trim();
      if (!q) continue;
      const imp = safeNum(r.impressions);
      const agg = byQuery.get(q) ?? { clicks: 0, impressions: 0, posW: 0, posImp: 0 };
      agg.clicks += safeNum(r.clicks);
      agg.impressions += imp;
      const pos = safeNumOrNull(r.avg_position);
      if (pos != null && imp > 0) {
        agg.posW += pos * imp;
        agg.posImp += imp;
      }
      byQuery.set(q, agg);
    }
    return Array.from(byQuery.entries())
      .map(([query, a]) => ({
        query,
        clicks: a.clicks,
        impressions: a.impressions,
        ctr: a.impressions > 0 ? a.clicks / a.impressions : null,
        avg_position: a.posImp > 0 ? a.posW / a.posImp : null,
      }))
      .sort((x, y) => y.impressions - x.impressions)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * خواندن آنالیتیکس ۷ روز اخیر صفحات، تجمیع‌شده بر اساس مسیر صفحه (fail-soft).
 *
 * مثل gsc_queries، جدول page_analytics هم ردیف روزانه دارد؛ آستانه‌های
 * نگهداشت (ایمپرشن ۱۰۰+/۵۰۰+) روی جمع ۷ روزه معنا دارند نه روی ردیف روزانه.
 */
async function loadPageAnalytics(limit = 30): Promise<PageRow[]> {
  try {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const { data, error } = await getSupabase()
      .from('page_analytics')
      .select('page_path, views, clicks, impressions, avg_position')
      .gte('date', since)
      .order('date', { ascending: false }) // اگر برش ۵۰۰۰ ردیف فعال شد، تازه‌ترین روزها بمانند
      .limit(5000);
    if (error) return [];
    const byPath = new Map<
      string,
      { views: number; clicks: number; impressions: number; posW: number; posImp: number }
    >();
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const p = String(r.page_path ?? '').trim();
      if (!p) continue;
      const imp = safeNum(r.impressions);
      const agg = byPath.get(p) ?? { views: 0, clicks: 0, impressions: 0, posW: 0, posImp: 0 };
      agg.views += safeNum(r.views);
      agg.clicks += safeNum(r.clicks);
      agg.impressions += imp;
      const pos = safeNumOrNull(r.avg_position);
      if (pos != null && imp > 0) {
        agg.posW += pos * imp;
        agg.posImp += imp;
      }
      byPath.set(p, agg);
    }
    return Array.from(byPath.entries())
      .map(([page_path, a]) => ({
        page_path,
        views: a.views,
        clicks: a.clicks,
        impressions: a.impressions,
        avg_position: a.posImp > 0 ? a.posW / a.posImp : null,
      }))
      .sort((x, y) => y.impressions - x.impressions)
      .slice(0, limit);
  } catch {
    return [];
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

/**
 * نرمال‌سازی عنوان برای مقایسهٔ ضدتکراری (فارسی‌آگاه).
 *
 * نیم‌فاصله، ی/ک عربی، ارقام فارسی و نقطه‌گذاری یکدست می‌شوند تا «می‌شود»
 * با «می شود»، «۱۴۰۵» با «1405» و «راهنما!» با «راهنما» یکسان دیده شوند.
 */
function normalizeTitle(s: string): string {
  return s
    .replace(/[‌‍]/g, ' ')
    .replace(/[ي]/g, 'ی')
    .replace(/[ك]/g, 'ک')
    .replace(/[ة]/g, 'ه')
    .replace(/[ً-ْٰ]/g, '') // اعراب (حرکت‌گذاری)
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[«»"'`]/g, ' ')
    .replace(/[؟?!:؛،.\-–…/٪٫ـ•()[\]{}]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
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

// === ضدتکراری معنایی محتواهای موجود (دستور مسعود ۱۴۰۵/۰۷/۲۴) ===
// مشکل: تیم content محتواهایی با «مضمون یکسان» تولید می‌کرد (نه فقط عنوان
// یکسان). راه‌حل: رهبر پیش از ساخت تسک content تازه، فهرست راهنماهای موجود
// روی سایت را می‌خواند؛ اگر موضوع تسک پیشنهادی با یکی از آن‌ها هم‌پوشانی
// معنایی داشت، به‌جای ساخت محتوای تازه، تسک «[آپدیت]» برای همان موجود می‌سازد.

/** راهنمای موجود روی سایت. */
interface ExistingGuide {
  slug: string;
  title: string;
}

/** مسیر فایل راهنماها در ریپوی سایت. */
const GUIDES_PATH = 'site/lib/guides.ts';

/**
 * خواندن راهنماهای موجود از ریپوی سایت (fail-soft؛ اگر گیت‌هاب متصل نبود،
 * ضدتکراری معنایی بی‌صدا غیرفعال می‌شود).
 *
 * اسلاگ و تیتر ممکن است در آبجکت به هر ترتیبی باشند و فیلدهای طولانی
 * (مثل description) بینشان فاصله بیندازد؛ پس بر اساس نزدیکی موقعیت در
 * متن جفت می‌شوند، نه با فاصلهٔ ثابت روبه‌جلو. کوتیشن تکی هم پشتیبانی می‌شود.
 */
async function loadExistingGuides(): Promise<ExistingGuide[]> {
  try {
    const content = await readSiteFile(GUIDES_PATH);
    if (!content) return [];
    const slugs: Array<{ slug: string; index: number }> = [];
    const titles: Array<{ title: string; index: number }> = [];
    for (const m of Array.from(content.matchAll(/\bslug\s*:\s*["']([a-z0-9-]+)["']/g)) {
      slugs.push({ slug: m[1], index: m.index ?? 0 });
    }
    for (const m of Array.from(content.matchAll(/\btitle\s*:\s*["']([^"']+)["']/g)) {
      titles.push({ title: m[1], index: m.index ?? 0 });
    }
    const usedTitle = new Set<number>();
    const seenSlug = new Set<string>();
    const out: ExistingGuide[] = [];
    const MAX_GAP = 2000; // حداکثر فاصلهٔ قابل‌قبول اسلاگ تا تیتر همسایه
    for (const s of slugs) {
      if (seenSlug.has(s.slug)) continue;
      let best = -1;
      let bestDist = MAX_GAP;
      titles.forEach((t, i) => {
        if (usedTitle.has(i)) return;
        const dist = Math.abs(t.index - s.index);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      });
      if (best >= 0) {
        usedTitle.add(best);
        seenSlug.add(s.slug);
        out.push({ slug: s.slug, title: titles[best].title });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * ایست‌واژه‌هایی که در تشخیص «موضوع» قدرت تمایز ندارند؛ از جمله کلماتی که
 * در همهٔ محتوای تایلندگرد تکرار می‌شوند (تایلند، سفر، راهنما...).
 */
const TOPIC_STOPWORDS = new Set([
  'و', 'به', 'از', 'در', 'با', 'که', 'را', 'یا', 'این', 'آن', 'های', 'ها',
  'برای', 'تا', 'هم', 'نیز', 'اما', 'ولی', 'اگر', 'چون', 'زیرا', 'پس',
  'من', 'تو', 'او', 'ما', 'شما', 'آنها', 'خود', 'خودت', 'خودتان',
  'چه', 'چطور', 'چگونه', 'کجا', 'کی', 'چند', 'کدام',
  'است', 'هست', 'شد', 'شده', 'میشود', 'می‌شود', 'بشود', 'کنید', 'کن',
  'بکنید', 'دارد', 'دارند', 'داشته', 'باشد', 'بود', 'کنیم', 'کنم',
  'تایلند', 'تایلندگرد', 'سفر', 'راهنما', 'راهنمای', 'تور', 'کامل', 'جامع',
  'بهترین', 'نحوه', 'طریقه', 'همه', 'درباره', 'معرفی',
]);

/** نرمال‌سازی متن فارسی برای استخراج کلیدواژهٔ موضوعی. */
function normalizeTopicText(s: string): string {
  return s
    .replace(/[‌‍]/g, ' ')
    .replace(/[ي]/g, 'ی') // ی عربی ← ی فارسی
    .replace(/[ك]/g, 'ک') // ک عربی ← ک فارسی
    .replace(/[ً-ْٰ]/g, '') // اعراب (حرکت‌گذاری)
    .replace(/[«»"'`]/g, ' ')
    .replace(/[؟?!:؛،.\-–()[\]{}]/g, ' ')
    .replace(/[\d۰-۹]+/g, ' ') // حذف عددها (لاتین و فارسی؛ عدد موضوع نیست)
    .toLowerCase();
}

/** استخراج کلیدواژه‌های موضوعی (بدون ایست‌واژه، با ساده‌سازی پسوند). */
function extractTopicKeywords(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of normalizeTopicText(s).split(/\s+/)) {
    if (w.length < 3 || TOPIC_STOPWORDS.has(w)) continue;
    const stemmed = w
      .replace(/(های|هایی|هایم|هایتان|هاشان)$/, '')
      .replace(/ها$/, '') // جمع چسبیده: «ویزاها» ← «ویزا»
      .replace(/(ترین|تر)$/, '');
    if (stemmed.length >= 3 && !TOPIC_STOPWORDS.has(stemmed)) out.add(stemmed);
  }
  return out;
}

/** شباهت ژاکار بین دو مجموعهٔ کلیدواژه. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  a.forEach((w) => {
    if (b.has(w)) inter++;
  });
  return inter / (a.size + b.size - inter);
}

/** آستانهٔ هم‌پوشانی معنایی: بالاتر از این یعنی «همان موضوع». */
const SEMANTIC_OVERLAP_THRESHOLD = 0.35;

/**
 * پیدا کردن راهنمای موجودی که با موضوع تسک پیشنهادی هم‌پوشانی معنایی دارد.
 * null یعنی موضوع تازه است و ساخت محتوای جدید اشکالی ندارد.
 */
function findOverlappingGuide(
  taskTitle: string,
  taskDescription: string,
  guides: ExistingGuide[],
): ExistingGuide | null {
  const taskKeys = extractTopicKeywords(`${taskTitle} ${taskDescription.slice(0, 300)}`);
  if (taskKeys.size < 2) return null; // کلیدواژهٔ کافی برای قضاوت نیست
  let best: ExistingGuide | null = null;
  let bestScore = 0;
  for (const g of guides) {
    const score = jaccard(taskKeys, extractTopicKeywords(g.title));
    if (score > bestScore) {
      bestScore = score;
      best = g;
    }
  }
  return bestScore >= SEMANTIC_OVERLAP_THRESHOLD ? best : null;
}

/** خلاصهٔ راهنماهای موجود برای تزریق به پرامپت رهبر. */
function summarizeExistingGuides(guides: ExistingGuide[]): string {
  if (guides.length === 0) return '(فهرست راهنماهای موجود خوانده نشد)';
  return guides
    .slice(0, 40)
    .map((g, i) => `${i + 1}. ${g.title} (اسلاگ: ${g.slug})`)
    .join('\n');
}

/** آیا تسک، تسک نگهداشت (آپدیت/بازنویسی) است؟ این‌ها از چک معنایی معاف‌اند. */
function isMaintenanceTask(title: string): boolean {
  return /^\[(آپدیت|بازنویسی)\]/.test(title.trim());
}

/**
 * تبدیل تسک content تکراری‌معنا به تسک «[آپدیت]» روی راهنمای موجود.
 * قالب شرح با قرارداد تیم content سازگار است (اسلاگ: / دلیل: / کار:).
 */
function convertToUpdateTask(p: PlannedTask, guide: ExistingGuide): PlannedTask {
  return {
    ...p,
    team: 'content',
    title: `[آپدیت] ${guide.slug}`,
    description:
      `اسلاگ: ${guide.slug}\n` +
      `دلیل: موضوع تسک پیشنهادی («${p.title}») با راهنمای موجود «${guide.title}» هم‌پوشانی معنایی دارد؛ به‌جای ساخت محتوای تازه، همان موجود به‌روز می‌شود.\n` +
      `کار: اطلاعات تازه و مفید دربارهٔ «${p.title}» اضافه شود؛ اطلاعات غلط/قدیمی حذف؛ حداقل ۲ لینک داخلی تازه؛ تاریخ به‌روزرسانی عوض شود؛ نشانی (URL) صفحه عوض نشود\n` +
      `زاویهٔ پیشنهادی اولیه: ${p.description.slice(0, 400)}`,
    files_hint: GUIDES_PATH,
  };
}

function summarizeIntel(items: IntelItem[]): string {
  if (items.length === 0) return '(اینتل تازه‌ای ثبت نشده)';
  return items
    .slice(0, 15)
    .map(
      (it, i) =>
        `${i + 1}. ${it.title ?? '(بدون تیتر)'}` +
        (it.created_at ? ` (${it.created_at.slice(0, 10)})` : '') +
        (it.source_name ? ` [منبع: ${it.source_name.slice(0, 40)}]` : '') +
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
        `CTR ${r.ctr != null ? `${(r.ctr * 100).toFixed(1)}٪` : '؟'}، ` +
        `پوزیشن ${r.avg_position != null ? r.avg_position.toFixed(1) : '؟'}`,
    )
    .join('\n');
}

function summarizePages(rows: PageRow[]): string {
  if (rows.length === 0) return '(دادهٔ آنالیتیکس صفحات در ۷ روز اخیر نیست)';
  return rows
    .slice(0, 20)
    .map((r, i) => {
      const ctr = r.impressions > 0 ? `${((r.clicks / r.impressions) * 100).toFixed(1)}٪` : '؟';
      return (
        `${i + 1}. ${r.page_path} | بازدید ${r.views}، کلیک ${r.clicks}، ` +
        `ایمپرشن ${r.impressions}، CTR ${ctr}، ` +
        `پوزیشن ${r.avg_position != null ? r.avg_position.toFixed(1) : '؟'}`
      );
    })
    .join('\n');
}

/**
 * تشخیص صفحه‌های راهنما که نیاز به آپدیت یا بازنویسی دارند (دستور مسعود ۱۴۰۵/۰۷/۲۴).
 *
 * منطق:
 * - آپدیت: صفحهٔ /guide/* با ایمپرشن بالا ولی CTR پایین یا در حال افت
 *   (محتوا کهنه شده؛ تعمیر می‌خواهد نه بازسازی)
 * - بازنویسی: ایمپرشن خیلی بالا ولی CTR خیلی پایین (محتوا با نیت کاربر
 *   جور نیست؛ از نو ساختن می‌خواهد)
 */
interface StaleGuide {
  slug: string;
  pagePath: string;
  impressions: number;
  clicks: number;
  ctr: number;
  kind: 'update' | 'rewrite';
  reason: string;
}

function detectStaleGuides(rows: PageRow[]): StaleGuide[] {
  const out: StaleGuide[] = [];
  for (const r of rows) {
    const m = /^\/guide\/([a-z0-9-]+)\/?$/.exec(r.page_path.trim());
    if (!m) continue;
    const slug = m[1];
    const impressions = r.impressions || 0;
    const clicks = r.clicks || 0;
    if (impressions < 100) continue; // ترافیک کم؛ اولویت نیست
    const ctr = impressions > 0 ? clicks / impressions : 0;
    if (impressions >= 500 && ctr < 0.01) {
      out.push({
        slug,
        pagePath: r.page_path,
        impressions,
        clicks,
        ctr,
        kind: 'rewrite',
        reason: `ایمپرشن بالا (${impressions}) ولی CTR خیلی پایین (${(ctr * 100).toFixed(1)}٪)؛ محتوا با نیت جست‌وجو جور نیست`,
      });
    } else if (ctr < 0.03) {
      out.push({
        slug,
        pagePath: r.page_path,
        impressions,
        clicks,
        ctr,
        kind: 'update',
        reason: `CTR پایین (${(ctr * 100).toFixed(1)}٪) با ${impressions} ایمپرشن؛ اطلاعات احتمالاً کهنه شده`,
      });
    }
  }
  return out.slice(0, 5);
}

function summarizeStaleGuides(guides: StaleGuide[]): string {
  if (guides.length === 0) return '(صفحهٔ راهنمایی که نیاز به آپدیت/بازنویسی داشته باشد پیدا نشد)';
  return guides
    .map(
      (g, i) =>
        `${i + 1}. [${g.kind === 'update' ? 'آپدیت' : 'بازنویسی'}] اسلاگ: ${g.slug} | ${g.reason}`,
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
  // هر لودر به‌تنهایی fail-soft است (خطا ← مقدار خالی)؛ ولی قفل‌کردن یک لودر
  // (اتصال معلق بدون timeout در لایهٔ سوپابیس) نه خطا می‌دهد نه برمی‌گردد و
  // Promise.all را برای همیشه نگه می‌دارد. این سقف زمانی، لودر قفل‌کرده را هم
  // به مقدار پیش‌فرض fail-soft برمی‌گرداند تا کل تیم نمیرد.
  const LOADER_TIMEOUT_MS = 45_000;
  const withLoaderTimeout = <T>(promise: Promise<T>, fallback: T): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), LOADER_TIMEOUT_MS);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  };
  const [intel, gsc, pages, openTasks, existingGuides] = await Promise.all([
    withLoaderTimeout(loadIntelFeed(), [] as IntelItem[]),
    withLoaderTimeout(loadGscQueries(), [] as GscRow[]),
    withLoaderTimeout(loadPageAnalytics(), [] as PageRow[]),
    withLoaderTimeout(loadOpenTasks(), [] as Array<{ team: string; title: string }>),
    withLoaderTimeout(loadExistingGuides(), [] as ExistingGuide[]),
  ]);
  ]);

  // سقف هوشمند: اگر هیچ دادهٔ تازه‌ای نیست، تسکی ساخته نمی‌شود؛
  // این تصمیم درست است، نه خرابی.
  // (سقف اضطراری ۲۰ تسک/روز به دستور مسعود در ۱۴۰۵/۰۷/۲۵ برداشته شد و برنمی‌گردد.)
  if (intel.length === 0 && gsc.length === 0 && pages.length === 0) {
    const summary =
      'دادهٔ تازه‌ای در فیدرها نیست (اینتل، سرچ کنسول و آنالیتیکس خالی‌اند)؛ ' +
      'رهبر تسکی نساخت. این تصمیم درست است، نه خرابی.';
    return { team: TEAM, summary, blockers, tasks: [], approved: true };
  }
  // سقف برداشته شد به دستور مسعود؛ بودجه نامحدود
  const budget = 1000;

  // تشخیص صفحه‌های نیازمند آپدیت/بازنویسی (سیستم نگهداشت محتوا، دستور مسعود ۱۴۰۵/۰۷/۲۴)
  const staleGuides = detectStaleGuides(pages);

  const directive = (input.reviewDirective ?? '').trim();
  await reportLive?.('طراحی تسک‌ها از داده', 40);

  let planned: PlannedTask[] = [];
  try {
    const res = await callLLMJson<{ tasks: unknown }>(
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
        '== صفحه‌های راهنمای نیازمند نگهداشت (آپدیت/بازنویسی) ==',
        summarizeStaleGuides(staleGuides),
        '',
        '== راهنماهای موجود روی سایت (این موضوعات را دوباره نساز) ==',
        summarizeExistingGuides(existingGuides),
        '',
        directive ? `دستور اصلاح رهبر (حتماً رعایت کن):\n${directive}\n` : '',
        `فقط برای داده‌ای که واقعاً تازه و ارزش اجرا دارد تسک بساز؛ حداکثر ${budget} تسک. صفر تسک هم اشکالی ندارد؛ برای پر کردن سهمیه تسک نساز.`,
        'قواعد:',
        '- هر تسک فقط برای یکی از ۴ تیم سازنده باشد (content/seo/design/dev)',
        '- عنوان کوتاه و مشخص؛ توضیح: دقیقاً چه کاری، چرا (کدام داده)، و خروجی مورد انتظار چیست',
        '- acceptance: معیار قبولی قابل راستی‌آزمایی در یک جمله',
        '- estimate: ۱=کم‌ریسک (خودکار تأیید می‌شود)، ۲=متوسط، ۳=سنگین',
        '- files_hint: مسیر فایل‌های مرتبط در ریپو (اگر می‌دانی)، وگرنه رشتهٔ خالی',
        '- هیچ عددی نساز؛ فقط از داده‌های بالا استفاده کن',
        '- کاراکتر U+2014 مطلقاً ممنوع',
        '',
        'قواعد نگهداشت محتوا (آپدیت/بازنویسی):',
        '- برای هر صفحه در فهرست «نیازمند نگهداشت»، یک تسک برای تیم content بساز',
        '- عنوان تسک آپدیت با «[آپدیت]» شروع شود؛ مثل: [آپدیت] راهنمای best-time-to-visit-thailand',
        '- عنوان تسک بازنویسی با «[بازنویسی]» شروع شود؛ مثل: [بازنویسی] راهنمای thailand-visa-guide',
        '- در description حتماً این سه خط باشد: «اسلاگ: <slug>» در خط اول، «دلیل: <دلیل از فهرست>» در خط دوم، «کار: <چه کاری>» در خط سوم',
        '- کار آپدیت: اطلاعات تازه و مفید اضافه، اطلاعات غلط/قدیمی حذف، لینک داخلی به محتواهای جدید، تاریخ به‌روزرسانی عوض شود',
        '- کار بازنویسی: ساختار کاملاً جدید ولی اسلاگ حفظ شود (برای سئو)',
        '',
        'قواعد ضدتکراری معنایی (خیلی مهم):',
        '- فهرست «راهنماهای موجود» بالا را بخوان؛ موضوعی که آنجا هست را دوباره به‌عنوان محتوای تازه پیشنهاد نده',
        '- اگر موضوع با یک راهنمای موجود هم‌پوشانی دارد، تسک «[آپدیت] <اسلاگ>» برای همان موجود بساز (نه محتوای تازه)',
        '- فقط اگر زاویه واقعاً متفاوت است (مثلاً راهنمای کلی موجود است ولی تو «مقایسه» می‌خواهی)، محتوای تازه مجاز است؛ در این صورت در description خط «تفاوت با راهنمای موجود <اسلاگ>: <توضیح یک‌جمله‌ای>» بنویس',
        '',
        'فقط JSON معتبر بده: {"tasks": [{"team": "content|seo|design|dev", "title": "...", "description": "...", "acceptance": "...", "estimate": 1|2|3, "priority": "low|medium|high|critical", "files_hint": "..."}]}',
        'خروجی باید دقیقاً با { شروع و با } تمام شود. هیچ متن، توضیح یا کدفنس قبل و بعد از JSON ننویس.',
      ].join('\n'),
      { system: 'تو رهبر عمل‌گرای تیم‌های تایلندگرد هستی؛ از داده تسک مشخص می‌سازی، نه حرف کلی.' },
    );
    // خروجی خراب (null یا بدون آرایهٔ tasks) با «صفر تسکِ واقعی» فرق دارد؛
    // صفرِ واقعی {"tasks": []} است و تصمیم درست محسوب می‌شود، ولی پاسخِ
    // بی‌ساختار یعنی طراحی تسک شکست خورده و باید بلاکر ثبت شود.
    if (!res || typeof res !== 'object' || !Array.isArray((res as { tasks?: unknown }).tasks)) {
      throw new Error('ساختار خروجی LLM معتبر نبود (فیلد tasks آرایه نیست)');
    }
    planned = (res as { tasks: PlannedTask[] }).tasks;
  } catch (err) {
    const msg = formatError(err);
    blockers.push(`طراحی تسک با LLM ناموفق بود: ${msg}`);
    return { team: TEAM, summary: blockers[0], blockers, tasks: [], approved: false };
  }

  await reportLive?.('ثبت تسک‌ها در صف', 75);
  const validTeams = new Set<string>(BUILDER_TEAMS);
  let skippedDup = 0;
  let skippedInvalid = 0;
  let convertedSemantic = 0;
  const batch = planned.slice(0, budget);
  for (let i = 0; i < batch.length; i++) {
    const p = batch[i];
    // ضربان زنده در هر تسک: حلقهٔ ثبت با خروجی بزرگ LLM یا دیتابیس کند ممکن
    // است دقایق طول بکشد؛ بدون ضربان تازه، نگهبان «هنگ» اعلام می‌کند (الگوی
    // فیکس seo/dev/content). درصد صعودی است تا گزارش ادغام نشود؛ لیبل ثابت
    // می‌ماند تا سطر ساب‌ایجنت تکثیر نشود.
    const enqueuePct = 75 + Math.round((24 * (i + 1)) / batch.length);
    await reportLive?.('ثبت تسک‌ها در صف', enqueuePct);
    // آیتم خراب (null یا غیرآبجکت) نباید کل حلقه را با TypeError بکشد؛
    // این حلقه بیرون try/catch است و خطایش به ارکستر می‌رسد.
    if (!p || typeof p !== 'object') {
      skippedInvalid++;
      continue;
    }
    const team = String(p.team ?? '').trim();
    let title = String(p.title ?? '').trim();
    let description = String(p.description ?? '').trim();
    let filesHint = String(p.files_hint ?? '');
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
    // ضدتکراری معنایی: اگر تسک content موضوعش با راهنمای موجود هم‌پوشانی
    // دارد، به‌جای محتوای تازه، تسک [آپدیت] برای همان موجود ساخته می‌شود.
    if (team === 'content' && !isMaintenanceTask(title) && existingGuides.length > 0) {
      const overlap = findOverlappingGuide(title, description, existingGuides);
      if (overlap) {
        const converted = convertToUpdateTask(
          { ...p, team, title, description, files_hint: filesHint },
          overlap,
        );
        title = converted.title;
        description = converted.description;
        filesHint = converted.files_hint;
        convertedSemantic++;
        console.log(
          `[leader] تسک «${p.title}» با «${overlap.title}» هم‌پوشانی معنایی داشت؛ به [آپدیت] ${overlap.slug} تبدیل شد.`,
        );
        // تسک تبدیلی هم نباید با تسک باز دیگری تکراری باشد
        if (isDuplicate(team, title, openTasks)) {
          skippedDup++;
          continue;
        }
      }
    }
    try {
      const id = await enqueueTask({
        team,
        title,
        description,
        files_hint: filesHint,
        priority,
        source: 'leader',
        acceptance,
        estimate,
        cycleId: input.cycleId,
      });
      openTasks.push({ team, title }); // ضدتکراری درون همین اجرا
      queued.push({ title, description, files_hint: filesHint, priority });
      console.log(`[leader] تسک «${title}» برای تیم ${team} ثبت شد (id=${id}).`);
    } catch (err) {
      const msg = formatError(err);
      blockers.push(`ثبت تسک «${title}» ناموفق بود: ${msg}`);
    }
  }

  await reportLive?.('پایان کار', 100);
  const statsClause =
    `(اینتل: ${intel.length} آیتم، سرچ کنسول: ${gsc.length} کوئری، آنالیتیکس: ${pages.length} صفحه، ` +
    `نگهداشت محتوا: ${staleGuides.length} صفحه نیازمند آپدیت/بازنویسی)`;
  const skippedClause =
    (skippedDup > 0 ? ` ${skippedDup} مورد تکراری رد شد.` : '') +
    (convertedSemantic > 0
      ? ` ${convertedSemantic} تسک content با موضوع تکراری به [آپدیت] راهنمای موجود تبدیل شد.`
      : '') +
    (skippedInvalid > 0 ? ` ${skippedInvalid} مورد نامعتبر رد شد.` : '');
  // وقتی رهبر آگاهانه صفر تسک می‌سازد (داده بود ولی چیز باارزشی برای اجرا
  // نبود)، خلاصه باید همان عبارت «دادهٔ تازه» را داشته باشد تا استثنای سقف
  // هوشمند در چک سادهٔ ارکستر (runSimpleCheck) آن را «تصمیم درست» بشناسد و
  // به اشتباه رد نکند؛ وگرنه دور اصلاح بیهوده اجرا می‌شود.
  const summary =
    queued.length === 0 && blockers.length === 0
      ? `دادهٔ تازه‌ای که ارزش اجرا داشته باشد در این چرخه پیدا نشد؛ رهبر تسکی نساخت. این تصمیم درست است، نه خرابی. ${statsClause}.${skippedClause}`
      : `رهبر ${queued.length} تسک تازه از داده ساخت و در صف ثبت کرد ${statsClause}.` +
        skippedClause +
        (blockers.length > 0 ? ` ${blockers.length} خطای ثبت.` : '');

  return {
    team: TEAM,
    summary,
    blockers,
    tasks: queued,
    approved: blockers.length === 0,
  };
}
