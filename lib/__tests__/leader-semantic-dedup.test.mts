/**
 * تست ضدتکراری معنایی محتواها (دستور مسعود ۱۴۰۵/۰۷/۲۴)
 *
 * منطق از lib/teams/leader.ts کپی شده (قرارداد تست‌های این ریپو).
 * سناریوها با عنوان‌های واقعی راهنماهای سایت ساخته شده‌اند.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---- کپی منطق از lib/teams/leader.ts ----

interface ExistingGuide {
  slug: string;
  title: string;
}

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

function normalizeTopicText(s: string): string {
  return s
    .replace(/[‌‍]/g, ' ')
    .replace(/[«»"'`]/g, ' ')
    .replace(/[؟?!:؛،.\-–—()[\]{}]/g, ' ')
    .replace(/\d+/g, ' ')
    .toLowerCase();
}

function extractTopicKeywords(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of normalizeTopicText(s).split(/\s+/)) {
    if (w.length < 3 || TOPIC_STOPWORDS.has(w)) continue;
    const stemmed = w
      .replace(/(های|هایی|هایم|هایتان|هاشان)$/, '')
      .replace(/(ترین|تر)$/, '');
    if (stemmed.length >= 3 && !TOPIC_STOPWORDS.has(stemmed)) out.add(stemmed);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  a.forEach((w) => {
    if (b.has(w)) inter++;
  });
  return inter / (a.size + b.size - inter);
}

const SEMANTIC_OVERLAP_THRESHOLD = 0.35;

function findOverlappingGuide(
  taskTitle: string,
  taskDescription: string,
  guides: ExistingGuide[],
): ExistingGuide | null {
  const taskKeys = extractTopicKeywords(`${taskTitle} ${taskDescription.slice(0, 300)}`);
  if (taskKeys.size < 2) return null;
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

function isMaintenanceTask(title: string): boolean {
  return /^\[(آپدیت|بازنویسی)\]/.test(title.trim());
}

// ---- تست‌ها ----

const GUIDES: ExistingGuide[] = [
  { slug: 'best-time-to-visit-thailand', title: 'بهترین زمان سفر به تایلند' },
  { slug: 'thailand-visa-guide', title: 'راهنمای ویزای تایلند؛ مدارک، هزینه و شرایط' },
  { slug: 'bangkok-chiangmai-train', title: 'راهنمای جامع سفر با قطار بانکوک به چیانگ مای؛ قیمت، ساعات و رزرو بلیط' },
  { slug: 'thailand-travel-cost', title: 'هزینه سفر به تایلند؛ برآورد واقعی برای هر سبک سفر' },
];

describe('ضدتکراری معنایی', () => {
  it('موضوع تکراری با جمله‌بندی متفاوت را پیدا می‌کند', () => {
    const found = findOverlappingGuide(
      'هزینه‌های سفر به تایلند چقدر است؟',
      'برآورد واقعی بودجه سفر برای سبک‌های اقتصادی و لوکس',
      GUIDES,
    );
    assert.ok(found, 'باید هم‌پوشانی پیدا می‌شد');
    assert.equal(found!.slug, 'thailand-travel-cost');
  });

  it('موضوع واقعاً تازه را تکراری تشخیص نمی‌دهد', () => {
    const found = findOverlappingGuide(
      'راهنمای غواصی در جزایر سیمیلان',
      'بهترین سایت‌های غواصی، فصل مناسب و مجوزهای لازم',
      GUIDES,
    );
    assert.equal(found, null);
  });

  it('ویزا با زمان سفر قاطی نمی‌شود (مثبت کاذب نمی‌دهد)', () => {
    const found = findOverlappingGuide(
      'شرایط ویزای تایلند برای ایرانیان',
      'مدارک لازم، هزینه ویزا و مدت اعتبار',
      GUIDES,
    );
    assert.ok(found, 'باید راهنمای ویزا پیدا می‌شد');
    assert.equal(found!.slug, 'thailand-visa-guide');
  });

  it('تسک‌های [آپدیت] از چک معنایی معاف‌اند', () => {
    assert.ok(isMaintenanceTask('[آپدیت] best-time-to-visit-thailand'));
    assert.ok(isMaintenanceTask('[بازنویسی] thailand-visa-guide'));
    assert.ok(!isMaintenanceTask('راهنمای تازه ویزای تایلند'));
  });

  it('عنوان خیلی کوتاه قضاوت نمی‌شود', () => {
    const found = findOverlappingGuide('پوکت', '', GUIDES);
    assert.equal(found, null);
  });

  it('کلمات عمومی (تایلند، سفر، راهنما) تمایز نمی‌سازند', () => {
    const keys = extractTopicKeywords('راهنمای جامع سفر به تایلند');
    assert.equal(keys.size, 0, 'همهٔ کلمات باید ایست‌واژه می‌بودند');
  });
});
