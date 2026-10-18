/**
 * lib/teams/knowledge.ts | تیم دانش: مربی و ناظر دانش ۱۵ تیم
 *
 * «تیم دانش» مثل یک معلم بر کیفیت و رشد دانش هر تیم نظارت می‌کند:
 * - `evaluateTeamKnowledge(team)`: خواندن جدول‌های team_knowledge و
 *   knowledge_categories از دیتابیس و ارزیابی عددی + پیشنهادهای فارسی.
 * - `suggestSources(team)`: پیشنهاد منبع دستی (نه AI) بر اساس مأموریت تیم از TEAM_META.
 * - `buildKnowledgePrompt(team, evaluation)`: پرامپت فارسی نقش مربی برای LLM؛
 *   ورودی: آمار دانش تیم، خروجی: ارزیابی + ۳ پیشنهاد مشخص برای گسترش دانش.
 *
 * این تیم در چرخه‌های ارکستر اجرا نمی‌شود و عضو TEAMS/TEAM_META نیست؛
 * فقط ابزار کمکی برای صفحه‌ها و APIهای دانش است.
 */

import { getSupabase } from '../api';
import { TEAM_META } from '../team-meta';
import type { TeamName } from '../types';

/** نام تیم در رجیستری تیم‌ها. */
export const TEAM_SLUG = 'knowledge' as const;

/** مأموریت یک‌خطی تیم. */
export const MISSION =
  'مربی دانش تایلندگرد: بر کیفیت، تازگی و پوشش دانش هر ۱۵ تیم نظارت می‌کند، امتیاز می‌دهد و پیشنهاد گسترش می‌کند.';

interface KnowledgeRow {
  id: string;
  category_id: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
}

interface CategoryRow {
  id: string;
  name: string;
}

/** نتیجه ارزیابی دانش یک تیم. */
export interface TeamKnowledgeEvaluation {
  /** نام تیم. */
  team: TeamName;
  /** امتیاز کلی دانش تیم از ۰ تا ۱۰۰. */
  score: number;
  /** پوشش دسته‌ها: نسبت دسته‌هایی که حداقل یک دانش دارند (۰ تا ۱). */
  coverage: number;
  /** تازگی: میانگین سن دانش‌ها به روز (null وقتی دانشی نیست). */
  freshness: number | null;
  /** تنوع منابع: تعداد دامنه‌ها/منبع‌های یکتا. */
  diversity: number;
  /** پیشنهادهای فارسی برای بهبود. */
  suggestions: string[];
  /** تعداد کل دانش‌های تیم. */
  itemCount: number;
  /** تعداد دسته‌های تعریف‌شده تیم. */
  categoryCount: number;
  /** تعداد دسته‌های دارای دانش. */
  coveredCategoryCount: number;
  /** سن آخرین دانش به روز (null وقتی دانشی نیست). */
  lastUpdatedDaysAgo: number | null;
}

const DAY_MS = 86_400_000;
/** آستانهٔ «کهنگی» دانش برای هشدار تازگی (روز). */
const STALENESS_THRESHOLD_DAYS = 30;
/** سن دانشی که از آن به بعد امتیاز تازگی صفر می‌شود (روز). */
const FRESHNESS_ZERO_DAYS = 120;
/** تعداد منابع یکتا که برای امتیاز کامل تنوع کافی است. */
const DIVERSITY_FULL_SCORE = 4;

const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

/** عدد را با ارقام فارسی می‌نویسد (برای متن‌های پیشنهادی). */
function faNum(n: number | null): string {
  if (n === null || n === undefined) return 'نامشخص';
  return Math.round(n)
    .toString()
    .replace(/\d/g, (d) => FA_DIGITS[Number(d)]);
}

/** سن یک تایم‌استمپ به روز. */
function ageDays(ts: string): number {
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (Date.now() - t) / DAY_MS);
}

/**
 * شناسهٔ یکتای منبع برای سنجش تنوع:
 * اگر منبع URL یا هاست باشد، دامنه‌اش؛ وگرنه خود متن نرمال‌شده.
 */
function sourceKey(source: string | null): string | null {
  if (!source) return null;
  const s = source.trim();
  if (!s) return null;
  const looksLikeUrl = /^https?:\/\//i.test(s);
  const looksLikeHost = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/\S*)?$/i.test(s);
  if (looksLikeUrl || looksLikeHost) {
    try {
      const u = new URL(looksLikeUrl ? s : `https://${s}`);
      return u.hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return s.toLowerCase();
    }
  }
  return s.toLowerCase().replace(/\s+/g, ' ');
}

/**
 * ارزیابی دانش یک تیم از روی جدول‌های team_knowledge و knowledge_categories.
 * هیچ داده‌ای نمی‌سازد؛ فقط از دیتابیس می‌خواند.
 */
export async function evaluateTeamKnowledge(team: TeamName): Promise<TeamKnowledgeEvaluation> {
  const supabase = getSupabase();

  const { data: items, error: itemsError } = await supabase
    .from('team_knowledge')
    .select('id, category_id, source, created_at, updated_at')
    .eq('team', team);
  if (itemsError) {
    throw new Error(`evaluateTeamKnowledge: خواندن team_knowledge ناموفق بود: ${itemsError.message}`);
  }

  const { data: categories, error: catsError } = await supabase
    .from('knowledge_categories')
    .select('id, name')
    .eq('team', team);
  if (catsError) {
    throw new Error(
      `evaluateTeamKnowledge: خواندن knowledge_categories ناموفق بود: ${catsError.message}`,
    );
  }

  const rows = (items ?? []) as KnowledgeRow[];
  const cats = (categories ?? []) as CategoryRow[];
  const suggestions: string[] = [];

  const itemCount = rows.length;
  const categoryCount = cats.length;

  // پوشش: دسته‌هایی که حداقل یک دانش دارند.
  const coveredIds = new Set<string>();
  for (const r of rows) {
    if (r.category_id) coveredIds.add(r.category_id);
  }
  const coveredCategoryCount = cats.filter((c) => coveredIds.has(c.id)).length;
  const coverage = categoryCount > 0 ? coveredCategoryCount / categoryCount : 0;

  // تازگی: میانگین سن دانش‌ها به روز.
  const freshness = itemCount > 0 ? rows.reduce((sum, r) => sum + ageDays(r.updated_at), 0) / itemCount : null;
  const lastUpdatedDaysAgo =
    itemCount > 0 ? Math.min(...rows.map((r) => ageDays(r.updated_at))) : null;

  // تنوع منابع: تعداد شناسه‌های یکتا.
  const uniqueSources = new Set<string>();
  for (const r of rows) {
    const key = sourceKey(r.source);
    if (key) uniqueSources.add(key);
  }
  const diversity = uniqueSources.size;

  // پیشنهادها (فارسی، بدون خط تیره بلند).
  if (itemCount === 0) {
    const meta = TEAM_META[team];
    suggestions.push(
      `تیم «${meta.faName}» هنوز هیچ دانشی ثبت نکرده است؛ حداقل یک دانش پایه از منابع پیشنهادی اضافه شود.`,
    );
  } else {
    const emptyCats = cats.filter((c) => !coveredIds.has(c.id));
    for (const c of emptyCats) {
      suggestions.push(`دستهٔ «${c.name}» هیچ دانشی ندارد؛ حداقل یک دانش برای آن ثبت شود.`);
    }
    if (lastUpdatedDaysAgo !== null && lastUpdatedDaysAgo > STALENESS_THRESHOLD_DAYS) {
      suggestions.push(
        `آخرین دانش ${faNum(lastUpdatedDaysAgo)} روز پیش به‌روزرسانی شده است؛ دانش تازه اضافه شود.`,
      );
    }
    if (diversity <= 1) {
      suggestions.push('همهٔ دانش‌ها از یک منبع است؛ منابع متنوع‌تری اضافه شود.');
    }
  }
  if (categoryCount === 0 && itemCount > 0) {
    suggestions.push('برای این تیم هیچ دسته‌ای تعریف نشده است؛ دسته‌بندی دانش کمک می‌کند پوشش سنجیده شود.');
  }

  // امتیاز کلی: پوشش ۴۰٪، تازگی ۳۵٪، تنوع ۲۵٪.
  const freshnessScore =
    freshness === null ? 0 : Math.max(0, 1 - Math.min(freshness, FRESHNESS_ZERO_DAYS) / FRESHNESS_ZERO_DAYS);
  const diversityScore = Math.min(1, diversity / DIVERSITY_FULL_SCORE);
  const score = Math.round(100 * (0.4 * coverage + 0.35 * freshnessScore + 0.25 * diversityScore));

  return {
    team,
    score,
    coverage,
    freshness,
    diversity,
    suggestions,
    itemCount,
    categoryCount,
    coveredCategoryCount,
    lastUpdatedDaysAgo,
  };
}

/**
 * پیشنهادهای دستی منبع برای هر تیم، بر اساس مأموریتش در TEAM_META.
 * الگوی دستی است و هیچ تماس AI ندارد.
 */
export function suggestSources(team: TeamName): string[] {
  const sources: Record<TeamName, string[]> = {
    leader: [
      'اینتل روزانه (intel_feed) و روندهای سفر به تایلند',
      'داده‌های سرچ کنسول: کوئری‌های پرایمپرشن با پوزیشن میانی',
      'آنالیتیکس صفحات: صفحات پربازدیدِ نیازمند بهینه‌سازی',
    ],
    artdir: [
      'ترندهای بصری سایت‌هایی مثل Awwwards و Behance',
      'کتاب‌های کلاسیک دیزاین (مثل کتاب‌های Don Norman)',
      'گزارش‌های ترند دیزاین سالانهٔ وب‌سایت‌ها',
    ],
    branding: [
      'سند برند و گایدلاین‌های لحن داخلی تایلندگرد',
      'مطالعات موردی برندهای گردشگری موفق جهان',
      'کتاب‌های برندینگ و شخصیت برند',
    ],
    content: [
      'متن‌های تأییدشدهٔ قبلی خود تایلندگرد (بازتولید لحن موفق)',
      'راهنماهای سبک نگارش محتوای وب فارسی',
      'تحلیل پیام‌های رقبای مستقیم در صفحه‌های تور',
    ],
    seo: [
      'مستندات رسمی Google Search Central',
      'بلاگ‌های سئوی فارسی (مثل وبسیما)',
      'انتشارات تحلیلی Search Engine Journal و Moz',
    ],
    analytics: [
      'مستندات رسمی Google Analytics 4',
      'راهنماهای اندازه‌گیری نرخ تبدیل برای سایت‌های گردشگری',
      'مقالات تحلیلی دربارهٔ متریک‌های رشد محصول',
    ],
    intel: [
      'خبرگزاری‌های تایلند مثل TAT News و Bangkok Post',
      'گزارش‌های روند گردشگری تایلند از نهادهای رسمی',
      'تحلیل‌های بازار سفر منتشرشده در رسانه‌های معتبر',
    ],
    lead: [
      'مطالعات موردی بهینه‌سازی نرخ تبدیل (CRO) در سفر',
      'مصاحبه‌ها و بازخوردهای واقعی بازدیدکنندگان سایت',
      'مقالات فارسی و انگلیسی دربارهٔ روان‌شناسی فروش آنلاین',
    ],
    design: [
      'سیستم‌های دیزاین مرجع (Material، Apple HIG)',
      'نمونه‌کارهای برجستهٔ سایت‌های گردشگری',
      'راهنماهای تجربهٔ کاربری موبایل‌فرست',
    ],
    seocontent: [
      'پرسش‌های واقعی کاربران از سرچ کنسول گوگل',
      'محتوای رتبه‌گرفتهٔ رقبا برای کلمات کلیدی هدف',
      'راهنماهای محتوای E-E-A-T گوگل',
    ],
    vibefarsi: [
      'مستندات و رجیستری کامپوننت‌های vibefarsi.ir',
      'نمونه‌کارهای واقعی پیاده‌سازی با وایب‌فارسی',
      'بازخوردهای توسعه‌دهندگان از انجمن‌ها و گیت‌هاب',
    ],
    farsiui: [
      'راهنماهای راست‌چین (RTL) در مستندات فریم‌ورک‌ها',
      'قواعد تایپوگرافی و ارقام فارسی در رابط‌ها',
      'تست‌های کاربردپذیری با کاربران فارسی‌زبان',
    ],
    'design-ir': [
      'تحقیق سلیقهٔ بصری کاربران ایرانی (نظرسنجی و تست A/B)',
      'نمونه‌های موفق بومی‌سازی طرح برای بازار ایران',
      'گفت‌وگوهای تیم فروش با مشتریان ایرانی',
    ],
    dev: [
      'مستندات رسمی Next.js و React',
      'راهنماهای بهینه‌سازی عملکرد وب (Web Vitals)',
      'پست‌مورتم‌ها و درس‌آموخته‌های فنی خود تیم',
    ],
    qa: [
      'چک‌لیست‌های تست استاندارد برای وب‌سایت‌های فروش تور',
      'گزارش‌های باگ‌های قبلی و الگوهای تکراری خطا',
      'راهنماهای تست دسترس‌پذیری (Accessibility)',
    ],
    inspector: [
      'چک‌لیست‌های بازبینی نهایی چرخه‌های قبلی',
      'معیارهای سلامت تعریف‌شده در قراردادهای تیم',
      'گزارش‌های بازرس از چرخه‌های گذشته (درس‌آموخته‌ها)',
    ],
    'tour-manager': [
      'تحلیل رقبا: ~/workspace/thailandgard-kw-research/competitor-tours-analysis.md',
      'کلمات کلیدی تور (۳۱۴ عبارت مرتبط با تور)',
      'پلن مدیر تور: ~/workspace/thailandgard-tour-manager-PLAN.md',
    ],
  };
  return sources[team];
}

/** قالب‌بندی آمار ارزیابی برای تزریق در پرامپت (فارسی). */
function formatStats(team: TeamName, e: TeamKnowledgeEvaluation): string {
  const meta = TEAM_META[team];
  const freshnessLine =
    e.freshness === null
      ? 'میانگین سن دانش‌ها: بدون دانش'
      : `میانگین سن دانش‌ها: ${faNum(e.freshness)} روز`;
  const lastLine =
    e.lastUpdatedDaysAgo === null
      ? 'آخرین به‌روزرسانی: هرگز'
      : `آخرین به‌روزرسانی: ${faNum(e.lastUpdatedDaysAgo)} روز پیش`;
  return [
    `تیم: ${meta.faName} (${team})`,
    `مأموریت: ${meta.mission}`,
    `امتیاز کلی: ${faNum(e.score)} از ۱۰۰`,
    `تعداد دانش: ${faNum(e.itemCount)}`,
    `پوشش دسته‌ها: ${faNum(e.coveredCategoryCount)} از ${faNum(e.categoryCount)} دسته`,
    freshnessLine,
    `تنوع منابع: ${faNum(e.diversity)} منبع یکتا`,
    lastLine,
  ].join('\n');
}

/**
 * پرامپت فارسی تیم دانش (نقش مربی).
 * ورودی: آمار دانش تیم. خروجی موردانتظار از LLM: ارزیابی + ۳ پیشنهاد مشخص برای گسترش دانش.
 */
export const buildKnowledgePrompt = (team: TeamName, evaluation: TeamKnowledgeEvaluation): string =>
  [
    'تو مربی و ناظر دانش تایلندگرد هستی؛ مثل یک معلم سخت‌گیر ولی دلسوز.',
    '',
    'ورودی (آمار واقعی دانش تیم؛ هیچ عدد دیگری را حدس نزن):',
    formatStats(team, evaluation),
    '',
    'مأموریت تو:',
    '۱. ارزیابی: در چند جمله بگو دانش این تیم در چه وضعی است و بزرگ‌ترین ضعفش کجاست.',
    '۲. سه پیشنهاد مشخص و قابل‌اجرا برای گسترش دانش این تیم بده؛ هر پیشنهاد باید بگوید چه موضوعی،',
    'از چه منبعی و چرا برای مأموریت همین تیم لازم است.',
    '',
    'قوانین خروجی:',
    'فقط فارسی بنویس؛ هیچ عددی را که در آمار بالا نیست تخیلی نکن؛',
    'دسته‌ها و منابع را با نام واقعی‌شان از آمار بالا بیاور؛ جمله‌ها کوتاه و مشخص باشند.',
  ].join('\n');

/* ============================================================
 * چرخه حیات و تازگی دانش (بر اساس docs/knowledge-lifecycle.md)
 * ============================================================ */

/** عمر مجاز هر نوع دانش به روز؛ مبنای checkFreshness. */
export const KNOWLEDGE_TTL_DAYS = {
  technical: 30,
  source_note: 90,
  critic_lesson: 180,
  principle: 365,
} as const;

/** نوع دانش (ستون knowledge_type در team_knowledge). */
export type KnowledgeType = keyof typeof KNOWLEDGE_TTL_DAYS;

/** مقدار پیش‌فرض نوع وقتی ستون یا مقدار نامعتبر است. */
const DEFAULT_KNOWLEDGE_TYPE: KnowledgeType = 'source_note';

function normalizeKnowledgeType(value: unknown): KnowledgeType {
  return typeof value === 'string' && value in KNOWLEDGE_TTL_DAYS
    ? (value as KnowledgeType)
    : DEFAULT_KNOWLEDGE_TYPE;
}

/** ردیف حداقلی لازم برای سنجش تازگی. */
interface FreshnessRow {
  id: string;
  knowledge_type?: string | null;
  reviewed_at?: string | null;
  updated_at: string;
  created_at: string;
}

/** نتیجهٔ بررسی تازگی دانش یک تیم. */
export interface FreshnessCheckResult {
  /** نام تیم. */
  team: TeamName;
  /** لیست knowledge_id های نیازمند بازبینی. */
  needsReview: string[];
  /** تعداد دانش‌های بررسی‌شده. */
  checked: number;
  /** یادداشت (مثلاً وقتی ستون‌های چرخه حیات هنوز در دیتابیس نیستند). */
  note: string | null;
}

/**
 * دانش‌های نیازمند بازبینی یک تیم را پیدا می‌کند.
 *
 * قانون (docs/knowledge-lifecycle.md بخش ۳):
 * - technical: ۳۰ روز | source_note: ۹۰ روز
 * - critic_lesson: ۱۸۰ روز | principle: بازبینی سالانه (۳۶۵ روز)
 * - نقطه شروع = reviewed_at وگرنه updated_at وگرنه created_at
 *
 * fail-soft: اگر ستون‌های چرخه حیات (knowledge_type/reviewed_at) هنوز
 * مهاجرت نشده باشند، همهٔ دانش‌ها با TTL پیش‌فرض source_note سنجیده می‌شوند.
 * دانش‌های آرشیوشده (freshness_status = 'archived') نادیده گرفته می‌شوند.
 */
export async function checkFreshness(team: TeamName): Promise<FreshnessCheckResult> {
  const supabase = getSupabase();

  let rows: FreshnessRow[] | null = null;
  let note: string | null = null;

  const primary = await supabase
    .from('team_knowledge')
    .select('id, knowledge_type, reviewed_at, updated_at, created_at')
    .eq('team', team)
    .neq('freshness_status', 'archived');

  if (primary.error && /knowledge_type|reviewed_at/i.test(primary.error.message)) {
    // ستون‌های چرخه حیات هنوز در دیتابیس نیستند؛ با ستون‌های پایه ادامه بده.
    const fallback = await supabase
      .from('team_knowledge')
      .select('id, updated_at, created_at')
      .eq('team', team)
      .neq('freshness_status', 'archived');
    if (fallback.error) {
      throw new Error(`checkFreshness: خواندن team_knowledge ناموفق بود: ${fallback.error.message}`);
    }
    rows = ((fallback.data ?? []) as Array<Pick<FreshnessRow, 'id' | 'updated_at' | 'created_at'>>).map(
      (r) => ({ ...r, knowledge_type: DEFAULT_KNOWLEDGE_TYPE, reviewed_at: null }),
    );
    note = 'ستون‌های knowledge_type و reviewed_at در دیتابیس نیست؛ همه با TTL پیش‌فرض source_note (۹۰ روز) سنجیده شدند.';
  } else if (primary.error) {
    throw new Error(`checkFreshness: خواندن team_knowledge ناموفق بود: ${primary.error.message}`);
  } else {
    rows = (primary.data ?? []) as FreshnessRow[];
  }

  const now = Date.now();
  const needsReview: string[] = [];

  for (const r of rows) {
    const type = normalizeKnowledgeType(r.knowledge_type);
    const ttlDays = KNOWLEDGE_TTL_DAYS[type];
    const startTs = r.reviewed_at ?? r.updated_at ?? r.created_at;
    const start = new Date(startTs).getTime();
    if (Number.isNaN(start)) continue;
    if (now - start > ttlDays * DAY_MS) {
      needsReview.push(r.id);
    }
  }

  return { team, needsReview, checked: rows.length, note };
}
