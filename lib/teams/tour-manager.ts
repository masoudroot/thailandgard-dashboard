/**
 * lib/teams/tour-manager.ts: تیم مدیر تور تایلندگرد (موج ۱، دستور مسعود ۱۴۰۵/۰۷/۲۶)
 *
 * مدیر تور یک «تحلیل‌گر و تصمیم‌گیر» سبک است، نه مجری سنگین. خروجی‌اش
 * «تسک دقیق برای تیم‌های دیگر» است:
 *
 *   tour-manager: «تور بانکوک+پاتایا ۷ شبه بساز؛ برنامه سفر این است؛
 *                  قیمت پایه این است؛ کلمات کلیدی هدف این‌هاست»
 *   content: برنامه سفر را به متن فارسی تبدیل می‌کند
 *   dev: در دیتابیس ثبت می‌کند
 *   seo: متا می‌زند
 *   design: کارت تور می‌سازد
 *
 * مرز با رهبر: رهبر «چه کاری» را از روی داده (اینتل، سرچ کنسول، آنالیتیکس)
 * می‌گوید؛ مدیر تور فقط «دامنهٔ تور» را پوشش می‌دهد. هم‌پوشانی ممنوع:
 * مدیر تور هرگز تسک غیرتوری نمی‌سازد.
 * تفکیک لایه‌ها (ممیزی B2، ۱۴۰۵/۰۷/۲۶): رهبر روی «صفحه و محتوا» کار می‌کند
 * (مثل «بهینه‌سازی صفحه تور سامویی»)؛ مدیر تور روی «موجودیت تور در دیتابیس»
 * (تعریف تور تازه، آپدیت price_from، بازبینی فعال‌سازی). اگر رهبر هم تسک
 * توری بسازد، سطح صفحه است نه سطح موجودیت؛ تکراری نیست.
 *
 * در هر چرخه:
 *   ۱. تورهای فعلی دیتابیس را می‌خواند (فعال/غیرفعال، قیمت، تازگی قیمت)
 *   ۲. الگوهای استاندارد بازار (۷ الگوی رقیب) را با موجودی مقایسه می‌کند
 *   ۳. قیمت‌های کهنه (>۷ روز) را تشخیص می‌دهد → تسک آپدیت قیمت
 *   ۴. تورهای جاافتاده را تشخیص می‌دهد → تسک تعریف تور تازه
 *   ۵. تورهای منقضی را تشخیص می‌دهد → نگه‌داشت برای سئو، هرگز حذف
 *
 * قوانین مسعود:
 * - هیچ دادهٔ نمایشی؛ قیمت بدون منبع = «تماس بگیرید»
 * - قیمت نمایشی همیشه «از X» است
 * - تور منقضی حذف نمی‌شود (برای سئو نگه داشته می‌شود)
 * - خط تیرهٔ بلند (U+2014) مطلقاً ممنوع
 */

import { getSupabase } from '../api';
import { callLLMJson } from '../llm';
import { enqueueTask, formatError } from '../taskqueue';
import type {
  MemoryEntry,
  ProgressReporter,
  QueuedTask,
  TeamName,
  TeamResult,
} from '../types';

export const TEAM: TeamName = 'tour-manager';

export const MISSION =
  'مالک دامنهٔ تور است: تورهای موجود را پایش می‌کند، جای خالی الگوهای بازار را پیدا می‌کند، قیمت کهنه را تشخیص می‌دهد و تسک دقیق تور برای تیم‌های سازنده می‌سازد؛ هرگز تسک غیرتوری نمی‌سازد.';

/** تیم‌های سازنده‌ای که مدیر تور برایشان تسک می‌سازد. */
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

/** تور موجود در دیتابیس. */
interface DbTour {
  slug: string;
  title: string;
  short_title: string;
  days: number;
  nights: number;
  price_from: number | null;
  active: boolean;
  price_updated_at: string | null;
  is_last_minute: boolean;
  season: string | null;
}

/** الگوی استاندارد بازار (از تحلیل رقبا، ۷ الگوی اصلی). */
interface TourPattern {
  slug: string;
  title: string;
  shortTitle: string;
  days: number;
  nights: number;
  destinations: string[];
  priceFrom: number;
  touristType: string;
  priority: number;
  /**
   * برنامهٔ پیشنهادی روزبه‌روز (از ~/workspace/thailandgard-kw-research/competitor-tours-analysis.md).
   * برای الگوهایی که تحلیل رقبا برنامهٔ روزبه‌روز نداشت، ترکیب صادقانه از
   * برنامه‌های ثبت‌شده است و در متن تسک «پیشنهاد اولیه» خوانده می‌شود؛
   * تیم content متن نهایی را می‌نویسد. هیچ‌وقت جزئیات ساختگی (هتل/ساعت/قیمت) ندارد.
   */
  itinerary: string[];
  /** کلمات کلیدی هدف سئو برای صفحهٔ این تور. */
  keywords: string[];
}

/**
 * ۷ الگوی اصلی تور از تحلیل رقبا
 * (~/workspace/thailandgard-kw-research/competitor-tours-analysis.md).
 * قیمت‌ها بازهٔ کف بازار پاییز ۱۴۰۴، اتاق دوتخته، هر نفر، تومان.
 */
const MARKET_PATTERNS: TourPattern[] = [
  {
    slug: 'bangkok-pattaya-7days',
    title: 'تور ترکیبی بانکوک و پاتایا ۷ شبه؛ شهر و ساحل در یک سفر',
    shortTitle: 'بانکوک + پاتایا',
    days: 8,
    nights: 7,
    destinations: ['بانکوک', 'پاتایا'],
    priceFrom: 54900000,
    touristType: 'خانواده، زوج‌ها',
    priority: 10,
    itinerary: [
      'پرواز تهران به بانکوک، انتقال زمینی به پاتایا (حدود ۲ ساعت)، تحویل هتل',
      'گشت شهری پاتایا (ساحل جومتین، بازار شناور)',
      'روز آزاد؛ پیشنهاد: جزیره کورال یا پارک آبی رامایانا',
      'روز آزاد یا گشت نیم‌روزی؛ انتقال به بانکوک',
      'گشت شهری بانکوک (کاخ بزرگ، وات فو، وات آرون)',
      'روز آزاد؛ پیشنهاد: بازارها و مراکز خرید یا سافاری ورلد',
      'روز آزاد',
      'انتقال به فرودگاه، پرواز برگشت به تهران',
    ],
    keywords: ['تور بانکوک پاتایا', 'تور ترکیبی بانکوک و پاتایا', 'قیمت تور بانکوک پاتایا', 'تور ۷ شبه بانکوک پاتایا'],
  },
  {
    slug: 'phuket-7days',
    title: 'تور پوکت ۷ شبه؛ جزیره فی‌فی، جیمز باند و ساحل پاتونگ',
    shortTitle: 'پوکت',
    days: 8,
    nights: 7,
    destinations: ['پوکت'],
    priceFrom: 59900000,
    touristType: 'زوج‌ها، خانواده‌ها',
    priority: 20,
    itinerary: [
      'پرواز مستقیم تهران به پوکت، ترانسفر فرودگاهی، تحویل هتل',
      'گشت شهری پوکت (بودای بزرگ، وات چالونگ، شهر قدیم پوکت)',
      'تور یک‌روزه جزایر فی‌فی با قایق تندرو',
      'روز آزاد ساحل',
      'پیشنهاد: خلیج فانگ نگا و جزیره جیمز باند',
      'روز آزاد؛ پیشنهاد: نمایش فانتاسی یا سیام نیرامیت',
      'روز آزاد',
      'ترانسفر فرودگاه، پرواز برگشت',
    ],
    keywords: ['تور پوکت', 'قیمت تور پوکت', 'تور ۷ شبه پوکت', 'تور پوکت پاییز'],
  },
  {
    slug: 'bangkok-phuket-7days',
    title: 'تور ترکیبی بانکوک و پوکت ۷ شبه؛ شهر و جزیره',
    shortTitle: 'بانکوک + پوکت',
    days: 8,
    nights: 7,
    destinations: ['بانکوک', 'پوکت'],
    priceFrom: 68900000,
    touristType: 'خانواده، زوج‌ها',
    priority: 30,
    itinerary: [
      'ورود به بانکوک، تحویل هتل، استراحت',
      'گشت شهری بانکوک (کاخ بزرگ، وات فو، رودخانه چائو پرایا)',
      'پرواز داخلی به پوکت، تحویل هتل، غروب ساحل',
      'تور یک‌روزه جزایر فی‌فی',
      'روز آزاد ساحل',
      'پیشنهاد: خلیج فانگ نگا یا غواصی',
      'پرواز داخلی به بانکوک',
      'پرواز برگشت به تهران',
    ],
    keywords: ['تور بانکوک پوکت', 'تور ترکیبی بانکوک و پوکت', 'قیمت تور بانکوک پوکت', 'تور ۷ شبه بانکوک پوکت'],
  },
  {
    slug: 'phuket-pattaya-7days',
    title: 'تور ترکیبی پوکت و پاتایا ۷ شبه؛ دو ساحل متفاوت',
    shortTitle: 'پوکت + پاتایا',
    days: 8,
    nights: 7,
    destinations: ['پوکت', 'پاتایا'],
    priceFrom: 66900000,
    touristType: 'جوانان، خانواده‌ها',
    priority: 40,
    itinerary: [
      'پرواز تهران به بانکوک، پرواز داخلی به پوکت، تحویل هتل',
      'تور یک‌روزه جزایر فی‌فی',
      'روز آزاد ساحل؛ پیشنهاد: خلیج فانگ نگا',
      'پرواز داخلی به بانکوک و انتقال زمینی به پاتایا',
      'گشت شهری پاتایا (ساحل جومتین، بازار شناور)',
      'روز آزاد؛ پیشنهاد: جزیره کورال',
      'انتقال به بانکوک، روز آزاد',
      'پرواز برگشت به تهران',
    ],
    keywords: ['تور پوکت پاتایا', 'تور ترکیبی پوکت و پاتایا', 'قیمت تور پوکت پاتایا'],
  },
  {
    slug: 'thailand-grand-14days',
    title: 'تور دور کامل تایلند ۱۴ شبه؛ بانکوک، پاتایا و پوکت',
    shortTitle: 'دور کامل تایلند',
    days: 15,
    nights: 14,
    destinations: ['بانکوک', 'پاتایا', 'پوکت'],
    priceFrom: 156000000,
    touristType: 'لوکس، ماه عسل',
    priority: 50,
    itinerary: [
      'پرواز تهران به بانکوک، تحویل هتل',
      'گشت شهری بانکوک (کاخ بزرگ، وات فو، وات آرون)',
      'روز آزاد بانکوک',
      'انتقال زمینی به پاتایا، تحویل هتل',
      'گشت شهری پاتایا (ساحل جومتین، بازار شناور)',
      'جزیره کورال',
      'روز آزاد پاتایا',
      'پرواز داخلی به پوکت، تحویل هتل',
      'تور یک‌روزه جزایر فی‌فی',
      'روز آزاد ساحل',
      'پیشنهاد: خلیج فانگ نگا و جزیره جیمز باند',
      'روز آزاد',
      'روز آزاد؛ پیشنهاد: نمایش شبانه',
      'روز آزاد',
      'پرواز برگشت (از پوکت یا از طریق بانکوک)',
    ],
    keywords: ['تور دور تایلند', 'تور ۱۴ شبه تایلند', 'تور لوکس تایلند', 'تور ماه عسل تایلند', 'قیمت تور دور تایلند'],
  },
  {
    slug: 'phuket-samui-7days',
    title: 'تور ترکیبی پوکت و سامویی ۷ شبه؛ لوکس و ماه عسل',
    shortTitle: 'پوکت + سامویی',
    days: 8,
    nights: 7,
    destinations: ['پوکت', 'سامویی'],
    priceFrom: 89900000,
    touristType: 'ماه عسل، لوکس',
    priority: 60,
    itinerary: [
      'پرواز تهران به پوکت (از طریق بانکوک)، تحویل هتل',
      'تور یک‌روزه جزایر فی‌فی',
      'روز آزاد ساحل پوکت',
      'انتقال به سامویی (پرواز داخلی یا کشتی)، تحویل هتل',
      'گشت جزیره سامویی (معبد بودای بزرگ، ساحل چاونگ)',
      'روز آزاد؛ پیشنهاد: تور جزایر اطراف سامویی',
      'روز آزاد',
      'پرواز برگشت به تهران',
    ],
    keywords: ['تور پوکت سامویی', 'تور ترکیبی پوکت و سامویی', 'تور ماه عسل پوکت', 'قیمت تور پوکت سامویی'],
  },
  {
    slug: 'phuket-krabi-7days',
    title: 'تور ترکیبی پوکت و کرابی ۷ شبه؛ طبیعت آندامان',
    shortTitle: 'پوکت + کرابی',
    days: 8,
    nights: 7,
    destinations: ['پوکت', 'کرابی'],
    priceFrom: 72000000,
    touristType: 'طبیعت‌گردان',
    priority: 70,
    itinerary: [
      'پرواز تهران به پوکت، انتقال به کرابی، تحویل هتل',
      'تور چهار جزیره کرابی',
      'روز آزاد؛ پیشنهاد: ساحل رایلی',
      'انتقال به پوکت، تحویل هتل',
      'تور یک‌روزه جزایر فی‌فی',
      'روز آزاد؛ پیشنهاد: خلیج فانگ نگا',
      'روز آزاد ساحل',
      'پرواز برگشت به تهران',
    ],
    keywords: ['تور پوکت کرابی', 'تور ترکیبی پوکت و کرابی', 'تور طبیعت تایلند', 'قیمت تور پوکت کرابی'],
  },
];

/** آستانهٔ کهنگی قیمت: بیش از ۷ روز = «تماس بگیرید». */
const PRICE_STALE_DAYS = 7;

/** خواندن تورهای فعلی دیتابیس (fail-soft). */
async function loadDbTours(): Promise<DbTour[]> {
  try {
    const { data, error } = await getSupabase()
      .from('tours')
      .select(
        'slug, title, short_title, days, nights, price_from, active, price_updated_at, is_last_minute, season',
      );
    if (error) return [];
    return (data ?? []) as DbTour[];
  } catch {
    return [];
  }
}

/** خواندن تسک‌های اخیر صف برای ضدتکراری (fail-soft). */
async function loadRecentTasks(): Promise<
  Array<{ team: string; title: string; status: string; created_at: string }>
> {
  try {
    const { data, error } = await getSupabase()
      .from('build_queue')
      .select('team, title, status, created_at')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) return [];
    return (data ?? []) as Array<{
      team: string;
      title: string;
      status: string;
      created_at: string;
    }>;
  } catch {
    return [];
  }
}

/** وضعیت‌هایی که تسک را «باز» حساب می‌کنیم. */
const OPEN_STATUSES = new Set(['pending', 'approved', 'in_progress', 'deferred']);

/**
 * پنجرهٔ ضدتکراری برای تسک‌های تکراری‌شونده (مثل بازبینی فصلی): ۷۲ ساعت.
 * درس ممیزی B2 (۱۴۰۵/۰۷/۲۶): فقط «باز بودن» چک می‌شد؛ وقتی تیم content تسک
 * «بازبینی تورهای غیرفعال» را done می‌کرد، چرخهٔ بعد همان تسک دوباره ساخته
 * می‌شد (۳ بار در ۵.۵ ساعت). از این به بعد «تازه بودن» هم ضدتکراری است.
 */
const RECENT_TASK_MS = 72 * 3600 * 1000;

/** آیا تسک باز است یا آن‌قدر تازه که ساخت دوباره‌اش اسپم است؟ */
function isOpenOrRecent(t: { status: string; created_at: string }): boolean {
  if (OPEN_STATUSES.has(t.status)) return true;
  if (!t.created_at) return false;
  const age = Date.now() - new Date(t.created_at).getTime();
  return !Number.isNaN(age) && age < RECENT_TASK_MS;
}

/** آیا قیمت کهنه است؟ (بیش از ۷ روز از price_updated_at گذشته) */
function isPriceStale(tour: DbTour): boolean {
  if (!tour.price_updated_at) return true;
  const updated = new Date(tour.price_updated_at).getTime();
  if (Number.isNaN(updated)) return true;
  return Date.now() - updated > PRICE_STALE_DAYS * 24 * 3600 * 1000;
}

/** تسک پیشنهادی برای تعریف تور تازه. */
interface PlannedTourTask {
  team: string;
  title: string;
  description: string;
  acceptance: string;
  estimate: number;
  priority: 'low' | 'medium' | 'high' | 'critical';
  files_hint: string;
  /** کلید ضدتکراری پایدار (ستون dedupe_key در build_queue). */
  dedupe_key: string;
}

export async function runTeam(input: TeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;
  const blockers: string[] = [];
  const queued: QueuedTask[] = [];

  await reportLive?.('خواندن تورهای دیتابیس و الگوهای بازار', 15);

  const [dbTours, recentTasks] = await Promise.all([
    loadDbTours(),
    loadRecentTasks(),
  ]);

  const dbSlugs = new Set(dbTours.map((t) => t.slug));

  await reportLive?.('تحلیل شکاف تورها و قیمت‌های کهنه', 40);

  const planned: PlannedTourTask[] = [];

  // ۱. الگوهای بازار که در دیتابیس نیستند → تسک تعریف تور
  for (const pattern of MARKET_PATTERNS) {
    if (dbSlugs.has(pattern.slug)) continue;
    // ضدتکراری: تسک مشابه باز یا تازه (۷۲ ساعت) نباشد
    if (
      recentTasks.some(
        (t) => isOpenOrRecent(t) && t.team === 'dev' && t.title.includes(pattern.shortTitle),
      )
    )
      continue;

    planned.push({
      team: 'dev',
      title: `[تور] تعریف تور ${pattern.shortTitle} (${pattern.nights} شب)`,
      description:
        `الگوی «${pattern.shortTitle}» از ۷ الگوی استاندارد بازار (تحلیل رقبا) در دیتابیس نیست؛ این تور را تعریف کن. ` +
        `مشخصات: عنوان «${pattern.title}»، اسلاگ ${pattern.slug}، ` +
        `${pattern.days} روز / ${pattern.nights} شب، مقاصد: ${pattern.destinations.join('، ')}، ` +
        `نوع گردشگر: ${pattern.touristType}. ` +
        `قیمت پایه «از ${pattern.priceFrom.toLocaleString('fa-IR')} تومان» (بازهٔ کف بازار؛ برچسب «از» اجباری است). ` +
        `خدمات استاندارد: پرواز ماهان مستقیم + هتل با صبحانه + ترانسفر فرودگاهی + ویزا + بیمه + راهنمای فارسی‌زبان. ` +
        `برنامهٔ پیشنهادی روزبه‌روز (از تحلیل رقبا؛ پیش‌نویس است، تیم content متن نهایی را می‌نویسد):\n` +
        pattern.itinerary.map((d, i) => `روز ${i + 1}: ${d}`).join('\n') +
        `\nکلمات کلیدی هدف سئو برای صفحهٔ این تور: ${pattern.keywords.join('، ')}. ` +
        `تور را با active=false ثبت کن (پیش‌نویس)؛ برنامهٔ روزبه‌روز و سؤال‌ها را در tour_days و tour_faqs بگذار. ` +
        `قانون: هیچ قیمت ساختگی؛ اگر قیمت مطمئن نیستی price_from را null بگذار تا «تماس بگیرید» نمایش داده شود.`,
      acceptance: `ردیف تور با اسلاگ ${pattern.slug} در جدول tours با active=false موجود باشد.`,
      estimate: 2,
      priority: 'high',
      files_hint: 'دیتابیس: tours, tour_days, tour_faqs',
      dedupe_key: `tour-manager:new-tour:${pattern.slug}`,
    });
  }

  // ۲. قیمت‌های کهنه → تسک آپدیت قیمت
  for (const tour of dbTours) {
    if (!tour.active) continue;
    if (!isPriceStale(tour)) continue;
    if (
      recentTasks.some(
        (t) => isOpenOrRecent(t) && t.title.includes(tour.slug) && t.title.includes('قیمت'),
      )
    )
      continue;

    planned.push({
      team: 'dev',
      title: `[تور] بررسی و آپدیت قیمت تور ${tour.short_title}`,
      description:
        `قیمت تور «${tour.title}» (اسلاگ ${tour.slug}) بیش از ${PRICE_STALE_DAYS} روز به‌روز نشده است. ` +
        `بازهٔ فعلی رقبا را بررسی کن و price_from را با برچسب «از» به‌روز کن؛ ` +
        `price_updated_at را به زمان حال ست کن. ` +
        `اگر قیمت مطمئنی پیدا نکردی، price_from را null کن تا سایت «برای قیمت تماس بگیرید» نشان دهد. ` +
        `هرگز عدد حدسی نگذار.`,
      acceptance: `price_updated_at تور ${tour.slug} تازه باشد یا price_from آن null باشد.`,
      estimate: 1,
      priority: 'medium',
      files_hint: 'دیتابیس: tours',
      dedupe_key: `tour-manager:price:${tour.slug}`,
    });
  }

  // ۳. تورهای غیرفعال قدیمی → یادآوری بازبینی فصلی (نه حذف؛ قانون مسعود)
  const inactiveOld = dbTours.filter((t) => !t.active);
  if (inactiveOld.length > 0) {
    const names = inactiveOld.map((t) => t.short_title).join('، ');
    // فقط اگر تسک مشابهی باز یا تازه (۷۲ ساعت) نیست
    if (!recentTasks.some((t) => isOpenOrRecent(t) && t.title.includes('بازبینی تورهای غیرفعال'))) {
      planned.push({
        team: 'content',
        title: '[تور] بازبینی تورهای غیرفعال برای فصل جاری',
        description:
          `این تورها غیرفعال‌اند: ${names}. ` +
          `بررسی کن کدام برای فصل جاری (نزدیک نوروز/تابستان) ارزش فعال‌سازی دارد. ` +
          `قانون: تور منقضی هرگز حذف نمی‌شود؛ فقط با بنر مناسب روی سایت می‌ماند (سئو).`,
        acceptance: 'گزارش بازبینی با پیشنهاد فعال/غیرفعال برای هر تور غیرفعال.',
        estimate: 1,
        priority: 'low',
        files_hint: 'دیتابیس: tours',
        dedupe_key: 'tour-manager:inactive-review',
      });
    }
  }

  await reportLive?.('ثبت تسک‌های تور در صف', 75);

  let n = 0;
  for (const p of planned) {
    n++;
    const pct = 75 + Math.round((n / Math.max(planned.length, 1)) * 20);
    await reportLive?.('ثبت تسک‌های تور در صف', pct);
    // اعتبارسنجی تیم
    if (!BUILDER_TEAMS.includes(p.team as TeamName)) {
      blockers.push(`تیم نامعتبر در تسک تور: ${p.team}`);
      continue;
    }
    try {
      const id = await enqueueTask({
        team: p.team,
        title: p.title,
        description: p.description,
        files_hint: p.files_hint,
        priority: p.priority,
        acceptance: p.acceptance,
        estimate: p.estimate as 1 | 2 | 3,
        dedupe_key: p.dedupe_key,
        source: 'tour-manager',
        cycleId: input.cycleId,
      });
      queued.push({
        title: p.title,
        description: p.description,
        files_hint: p.files_hint,
        priority: p.priority,
      });
      console.log(`[tour-manager] تسک «${p.title}» برای تیم ${p.team} ثبت شد (id=${id}).`);
    } catch (err) {
      const msg = formatError(err);
      blockers.push(`ثبت تسک «${p.title}» ناموفق بود: ${msg}`);
    }
  }

  await reportLive?.('پایان کار', 100);

  const missingCount = MARKET_PATTERNS.filter((p) => !dbSlugs.has(p.slug)).length;
  const staleCount = dbTours.filter((t) => t.active && isPriceStale(t)).length;
  const statsClause =
    `(تورهای دیتابیس: ${dbTours.length}، فعال: ${dbTours.filter((t) => t.active).length}، ` +
    `الگوی بازار جاافتاده: ${missingCount}، قیمت کهنه: ${staleCount})`;

  const summary =
    queued.length === 0 && blockers.length === 0
      ? `توری برای اقدام تازه پیدا نشد؛ همهٔ الگوهای بازار پوشش داده شده و قیمت‌ها تازه‌اند. این تصمیم درست است، نه خرابی. ${statsClause}.`
      : `مدیر تور ${queued.length} تسک تور ساخت و در صف ثبت کرد ${statsClause}.` +
        (blockers.length > 0 ? ` ${blockers.length} خطای ثبت.` : '');

  return {
    team: TEAM,
    summary,
    blockers,
    tasks: queued,
    approved: blockers.length === 0,
  };
}
