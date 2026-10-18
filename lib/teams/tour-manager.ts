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

/** خواندن تسک‌های باز صف برای ضدتکراری (fail-soft). */
async function loadOpenTasks(): Promise<Array<{ team: string; title: string }>> {
  try {
    const { data, error } = await getSupabase()
      .from('build_queue')
      .select('team, title')
      .in('status', ['pending', 'approved', 'in_progress', 'deferred'])
      .limit(200);
    if (error) return [];
    return (data ?? []) as Array<{ team: string; title: string }>;
  } catch {
    return [];
  }
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
}

export async function runTeam(input: TeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;
  const blockers: string[] = [];
  const queued: QueuedTask[] = [];

  await reportLive?.('خواندن تورهای دیتابیس و الگوهای بازار', 15);

  const [dbTours, openTasks] = await Promise.all([
    loadDbTours(),
    loadOpenTasks(),
  ]);

  const dbSlugs = new Set(dbTours.map((t) => t.slug));
  const openTitles = new Set(
    openTasks.map((t) => `${t.team}::${t.title}`),
  );

  await reportLive?.('تحلیل شکاف تورها و قیمت‌های کهنه', 40);

  const planned: PlannedTourTask[] = [];

  // ۱. الگوهای بازار که در دیتابیس نیستند → تسک تعریف تور
  for (const pattern of MARKET_PATTERNS) {
    if (dbSlugs.has(pattern.slug)) continue;
    // ضدتکراری: تسک مشابه باز نباشد
    const dupKey = `dev::[تور] تعریف تور ${pattern.shortTitle}`;
    if (openTasks.some((t) => t.title.includes(pattern.shortTitle) && t.team === 'dev')) continue;

    planned.push({
      team: 'dev',
      title: `[تور] تعریف تور ${pattern.shortTitle} (${pattern.nights} شب)`,
      description:
        `تور تازه از الگوی بازار (تحلیل رقبا). ` +
        `مشخصات: عنوان «${pattern.title}»، اسلاگ ${pattern.slug}، ` +
        `${pattern.days} روز / ${pattern.nights} شب، مقاصد: ${pattern.destinations.join('، ')}، ` +
        `نوع گردشگر: ${pattern.touristType}. ` +
        `قیمت پایه «از ${pattern.priceFrom.toLocaleString('fa-IR')} تومان» (بازهٔ کف بازار؛ برچسب «از» اجباری است). ` +
        `خدمات استاندارد: پرواز ماهان مستقیم + هتل با صبحانه + ترانسفر فرودگاهی + ویزا + بیمه + راهنمای فارسی‌زبان. ` +
        `تور را با active=false ثبت کن (پیش‌نویس)؛ برنامهٔ روزبه‌روز و سؤال‌ها را در tour_days و tour_faqs بگذار. ` +
        `قانون: هیچ قیمت ساختگی؛ اگر قیمت مطمئن نیستی price_from را null بگذار تا «تماس بگیرید» نمایش داده شود.`,
      acceptance: `ردیف تور با اسلاگ ${pattern.slug} در جدول tours با active=false موجود باشد.`,
      estimate: 2,
      priority: 'high',
      files_hint: 'دیتابیس: tours, tour_days, tour_faqs',
    });
  }

  // ۲. قیمت‌های کهنه → تسک آپدیت قیمت
  for (const tour of dbTours) {
    if (!tour.active) continue;
    if (!isPriceStale(tour)) continue;
    if (openTasks.some((t) => t.title.includes(tour.slug) && t.title.includes('قیمت'))) continue;

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
    });
  }

  // ۳. تورهای غیرفعال قدیمی → یادآوری بازبینی فصلی (نه حذف؛ قانون مسعود)
  const inactiveOld = dbTours.filter((t) => !t.active);
  if (inactiveOld.length > 0) {
    const names = inactiveOld.map((t) => t.short_title).join('، ');
    // فقط اگر تسک مشابهی باز نیست
    if (!openTasks.some((t) => t.title.includes('بازبینی تورهای غیرفعال'))) {
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
