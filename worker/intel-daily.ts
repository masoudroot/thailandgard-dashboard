/**
 * جمع‌کنندهٔ روزانهٔ intel_feed (فیدر داده، قدم صفر).
 *
 * هر روز یک بار (ورک‌فلو intel-daily.yml):
 *  ۱. RSS منابع خبری تایلند را می‌خواند (TAT News، The Thaiger، Bangkok Post)
 *  ۲. آیتم‌های ۴۸ ساعت اخیرِ مرتبط با سفر تایلند را جدا می‌کند
 *  ۳. ضدتکراری با source_url روی intel_feed (۱۴ روز اخیر)
 *  ۴. تیتر فارسی + خلاصهٔ فارسی + تگ + blog_angle را با LLM می‌سازد
 *  ۵. در intel_feed درج می‌کند (idempotent: اجرای دوباره چیزی اضافه نمی‌کند)
 *
 * اجرا: npx tsx worker/intel-daily.ts
 * نیازمند: SUPABASE_URL، SUPABASE_SERVICE_ROLE_KEY، LLM_API_BASE، LLM_API_KEY
 */

import { getSupabase } from '../lib/api';
import { callLLM } from '../lib/llm';

/** منابع RSS؛ بدون کلید، عمومی. */
const SOURCES: Array<{ name: string; url: string }> = [
  { name: 'TAT News', url: 'https://www.tatnews.org/feed/' },
  { name: 'The Thaiger', url: 'https://thethaiger.com/feed' },
  { name: 'Bangkok Post', url: 'https://www.bangkokpost.com/rss/data/topstories.xml' },
];

/** حداکثر آیتم برای پردازش با LLM در هر اجرا (کنترل هزینه). */
const MAX_ITEMS = 10;
/** پنجرهٔ تازگی خبر (ساعت). */
const FRESH_HOURS = 48;
/** پنجرهٔ ضدتکراری (روز). */
const DEDUP_DAYS = 14;

/** کلمات کلیدی سفر تایلند (انگلیسی؛ فیدها انگلیسی‌اند). */
const TRAVEL_KEYWORDS = [
  'thailand', 'thai', 'bangkok', 'phuket', 'pattaya', 'chiang mai', 'krabi',
  'koh samui', 'phang nga', 'hua hin', 'ayutthaya', 'tourist', 'tourism',
  'travel', 'flight', 'flights', 'airline', 'airport', 'hotel', 'resort',
  'visa', 'festival', 'beach', 'island',
];
/** کلماتی که آیتم را حذف می‌کنند (غیرسفری: سیاست، جنایی، ورزش). */
const EXCLUDE_KEYWORDS = [
  'stock', 'baht falls', 'election', 'parliament', 'cabinet', 'court ruling',
  'football', 'premier league', 'crypto', 'arrest', 'arrested', 'jail', 'jailed',
  'prison', 'murder', 'crime', 'police', 'drug bust', 'scam centre',
];

interface RssItem {
  title: string;
  link: string;
  pubDate: Date | null;
  description: string;
  source: string;
}

/** پارس سادهٔ RSS/Atom بدون وابستگی. */
export function parseRss(xml: string, source: string): RssItem[] {
  const items: RssItem[] = [];
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/(item|entry)>/g) ?? [];
  for (const b of blocks) {
    const text = (tag: string): string => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      if (!m) return '';
      return m[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
    };
    let link = text('link');
    if (!link) {
      const lm = b.match(/<link[^>]+href="([^"]+)"/);
      if (lm) link = lm[1];
    }
    const pubRaw = text('pubDate') || text('published') || text('updated');
    let pubDate: Date | null = null;
    if (pubRaw) {
      const d = new Date(pubRaw);
      if (!Number.isNaN(d.getTime())) pubDate = d;
    }
    const title = text('title');
    if (!title || !link) continue;
    items.push({ title, link, pubDate, description: text('description').slice(0, 500), source });
  }
  return items;
}

export function isTravelRelevant(item: RssItem): boolean {
  const hay = `${item.title} ${item.description}`.toLowerCase();
  if (EXCLUDE_KEYWORDS.some((k) => hay.includes(k))) return false;
  return TRAVEL_KEYWORDS.some((k) => hay.includes(k));
}

export function isFresh(item: RssItem): boolean {
  if (!item.pubDate) return true; // بدون تاریخ، رد نمی‌کنیم
  const ageMs = Date.now() - item.pubDate.getTime();
  return ageMs >= 0 && ageMs <= FRESH_HOURS * 3600 * 1000;
}

interface EnrichedItem {
  title_fa: string;
  summary_fa: string;
  tags: string[];
  blog_angle: string;
}

function extractJsonArray(text: string): unknown[] | null {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function asEnriched(v: unknown): EnrichedItem | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const title_fa = typeof o.title_fa === 'string' ? o.title_fa.trim() : '';
  const summary_fa = typeof o.summary_fa === 'string' ? o.summary_fa.trim() : '';
  if (!title_fa || !summary_fa) return null;
  const tags = Array.isArray(o.tags)
    ? (o.tags as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, 5)
    : [];
  const blog_angle = typeof o.blog_angle === 'string' ? o.blog_angle.trim() : '';
  return { title_fa, summary_fa, tags, blog_angle };
}

async function enrichWithLLM(items: RssItem[]): Promise<Map<RssItem, EnrichedItem>> {
  const out = new Map<RssItem, EnrichedItem>();
  if (items.length === 0) return out;
  const prompt = [
    'تو ویراستار فارسی تیم intel تایلندگرد هستی. برای هر خبر زیر، به فارسی روان و محاوره‌ایِ ساده:',
    '- یک تیتر فارسی کوتاه و دقیق (title_fa)',
    '- یک خلاصهٔ فارسی ۱ تا ۲ جمله‌ای، غیرکپی از متن خبر (summary_fa)',
    '- حداکثر ۵ تگ فارسی مرتبط (tags)',
    '- یک زاویهٔ پیشنهادی برای تبدیل به مقالهٔ بلاگ (blog_angle، یک جمله)',
    '',
    'فقط واقعیتِ متن خبر؛ هیچ حدسی نزن. خروجی: فقط یک آرایهٔ JSON با همین ترتیب، هر عضو با کلیدهای title_fa، summary_fa، tags، blog_angle.',
    '',
    ...items.map(
      (it, i) =>
        `${i + 1}. [${it.source}] ${it.title}\n   ${it.description.slice(0, 300)}\n   لینک: ${it.link}`,
    ),
  ].join('\n');
  const text = await callLLM(prompt, {
    system: 'تو ویراستار فارسی تیم intel تایلندگرد هستی.',
    temperature: 0.3,
    maxTokens: 3000,
  });
  const arr = extractJsonArray(text);
  if (!arr) {
    console.error('[intel-daily] خروجی LLM آرایهٔ JSON معتبر نبود.');
    return out;
  }
  arr.slice(0, items.length).forEach((v, i) => {
    const e = asEnriched(v);
    if (e) out.set(items[i], e);
  });
  return out;
}

async function main(): Promise<void> {
  const sb = getSupabase();
  const seen = new Set<string>();
  const candidates: RssItem[] = [];

  // ۱) خواندن RSSها
  for (const src of SOURCES) {
    try {
      const res = await fetch(src.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (ThailandGard intel-daily)' },
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) {
        console.error(`[intel-daily] ${src.name}: HTTP ${res.status}`);
        continue;
      }
      const xml = await res.text();
      const parsed = parseRss(xml, src.name);
      console.log(`[intel-daily] ${src.name}: ${parsed.length} آیتم خام`);
      for (const it of parsed) {
        if (seen.has(it.link)) continue;
        seen.add(it.link);
        if (isFresh(it) && isTravelRelevant(it)) candidates.push(it);
      }
    } catch (err) {
      console.error(`[intel-daily] ${src.name} خطا:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[intel-daily] ${candidates.length} آیتم تازه و مرتبط`);

  // ۲) ضدتکراری با intel_feed (۱۴ روز اخیر)
  const since = new Date(Date.now() - DEDUP_DAYS * 24 * 3600 * 1000).toISOString();
  const { data: existing, error: existErr } = await sb
    .from('intel_feed')
    .select('source_url')
    .gte('created_at', since);
  if (existErr) {
    console.error('[intel-daily] خطا در خواندن intel_feed:', existErr.message);
    process.exit(1);
  }
  const knownUrls = new Set((existing ?? []).map((r: { source_url: string | null }) => r.source_url));
  const fresh = candidates.filter((it) => !knownUrls.has(it.link)).slice(0, MAX_ITEMS);
  console.log(`[intel-daily] ${fresh.length} آیتم تازهٔ غیرتکراری`);
  if (fresh.length === 0) {
    console.log('[intel-daily] چیز تازه‌ای نیست؛ پایان.');
    return;
  }

  // ۳) غنی‌سازی با LLM
  const enriched = await enrichWithLLM(fresh);
  if (enriched.size === 0) {
    console.error('[intel-daily] غنی‌سازی ناموفق بود؛ چیزی درج نشد.');
    process.exit(1);
  }

  // ۴) درج
  const rows: Array<{ title: string; summary: string; source_url: string; source_name: string; tags: string[]; blog_angle: string }> = [];
  enriched.forEach((e, it) => {
    rows.push({
      title: e.title_fa,
      summary: e.summary_fa,
      source_url: it.link,
      source_name: it.source,
      tags: e.tags.length > 0 ? e.tags : ['تایلند'],
      blog_angle: e.blog_angle,
    });
  });
  const { error: insErr } = await sb.from('intel_feed').insert(rows);
  if (insErr) {
    console.error('[intel-daily] خطا در درج:', insErr.message);
    process.exit(1);
  }
  console.log(`[intel-daily] ${rows.length} آیتم در intel_feed درج شد.`);
}

main().catch((err) => {
  console.error('[intel-daily] خطای غیرمنتظره:', err instanceof Error ? err.message : err);
  process.exit(1);
});
