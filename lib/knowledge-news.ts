/**
 * lib/knowledge-news.ts - اخبار حوزه‌ی هر تیم دانش.
 *
 * هر تیم چند «حوزه خبری» دارد که به صورت دستی به کوئری/منبع نگاشت شده
 * (تیم ۱۰: اخبار حوزه). خروجی حداکثر ۵ خبر تازه با عنوان و لینک است.
 *
 * قراردادها:
 * - بدون کلید خارجی پولی؛ فقط RSS/جست‌وجوی ساده (Google News RSS).
 * - کاملاً fail-soft: هر خطا (شبکه، پارس، تنظیمات) به آرایه‌ی خالی می‌رسد؛
 *   هرگز throw نمی‌کند.
 * - هیچ داده‌ی نمایشی ساخته نمی‌شود؛ اگر برای تیمی منبعی تعریف نشده باشد،
 *   API پیام «منبع خبر تنظیم نشده» را برمی‌گرداند.
 * - منابع داده‌ی بازار (settings با کلید market_source) در صورت فعال بودن
 *   به عنوان ورودی مکمل استفاده می‌شوند ولی هیچ وابستگی به آن‌ها نیست.
 */

import type { TeamName } from './types';
import { TEAM_META } from './team-meta';
import { fetchMarketData } from './market';

/** یک خبر. */
export interface NewsItem {
  title: string;
  url: string;
  summary: string;
}

interface NewsQuery {
  /** متن جست‌وجو. */
  q: string;
  /** زبان فید. */
  lang: 'fa' | 'en';
}

export const MAX_NEWS_ITEMS = 5;

/** خط تیره‌ی بلند (U+2014) در هیچ خروجی نباید باشد. */
function sanitize(input: string): string {
  return input.replace(/\u2014/g, '-');
}

/**
 * نگاشت دستی حوزه‌ی خبری هر تیم به کوئری‌ها.
 * برای تیم‌های فارسی‌محور معادل فارسی داده شده است.
 */
const TEAM_NEWS_QUERIES: Partial<Record<TeamName, NewsQuery[]>> = {
  intel: [
    { q: 'تایلند گردشگری', lang: 'fa' },
    { q: 'Thailand tourism', lang: 'en' },
  ],
  seo: [{ q: 'Google algorithm update', lang: 'en' }],
  seocontent: [{ q: 'SEO content strategy', lang: 'en' }],
  content: [{ q: 'content marketing', lang: 'en' }],
  analytics: [{ q: 'marketing analytics', lang: 'en' }],
  lead: [{ q: 'lead generation marketing', lang: 'en' }],
  branding: [{ q: 'brand identity news', lang: 'en' }],
  artdir: [{ q: 'art direction design trends', lang: 'en' }],
  design: [{ q: 'web design trends', lang: 'en' }],
  vibefarsi: [{ q: 'طراحی رابط کاربری فارسی', lang: 'fa' }],
  farsiui: [{ q: 'طراحی راست‌چین وب', lang: 'fa' }],
  'design-ir': [{ q: 'طراحی سایت ایرانی', lang: 'fa' }],
  dev: [{ q: 'Next.js release', lang: 'en' }],
  qa: [{ q: 'software testing news', lang: 'en' }],
  inspector: [{ q: 'quality assurance audit', lang: 'en' }],
};

/** آیا برای این تیم منبع خبری تعریف شده است؟ */
export function teamHasNewsSource(team: string): boolean {
  const queries = TEAM_NEWS_QUERIES[team as TeamName];
  return Array.isArray(queries) && queries.length > 0;
}

function googleNewsRssUrl(query: NewsQuery): string {
  const locale =
    query.lang === 'fa' ? 'hl=fa&gl=IR&ceid=IR:fa' : 'hl=en-US&gl=US&ceid=US:en';
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query.q)}&${locale}`;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/&amp;/g, '&');
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** برداشت متن یک تگ از یک بلوک آیتم RSS (پشتیبانی از CDATA). */
function tagText(tag: string, block: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = block.match(re);
  if (!match) return null;
  let value = match[1].trim();
  if (value.startsWith('<![CDATA[')) value = value.slice(9, -3);
  return decodeEntities(value).trim();
}

const MAX_SUMMARY_CHARS = 220;

function parseRssItems(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const block of blocks) {
    const url = tagText('link', block);
    const title = tagText('title', block);
    if (!url || !title || !/^https?:\/\//i.test(url)) continue;
    const rawSummary = tagText('description', block) ?? '';
    const summary = sanitize(stripTags(rawSummary)).slice(0, MAX_SUMMARY_CHARS);
    items.push({ title: sanitize(title), url: url.trim(), summary });
  }
  return items;
}

async function fetchRssNews(query: NewsQuery): Promise<NewsItem[]> {
  const res = await fetch(googleNewsRssUrl(query), {
    signal: AbortSignal.timeout(12_000),
    headers: { 'User-Agent': 'thailandgard-dashboard/1.0' },
  });
  if (!res.ok) throw new Error(`RSS پاسخ ${res.status} برگرداند.`);
  return parseRssItems(await res.text());
}

/**
 * ورودی مکمل: پیوندهایی که در داده‌ی منابع بازار تنظیم‌شده در settings هست.
 * اگر settings در دسترس نباشد یا منبعی فعال نباشد، آرایه‌ی خالی.
 */
async function newsFromMarketSources(): Promise<NewsItem[]> {
  const result = await fetchMarketData();
  if (!result.ok || !result.data) return [];
  const urls = Array.from(
    new Set(result.data.match(/https?:\/\/[^\s"'<>()]+/gi) ?? []),
  );
  return urls.slice(0, 3).map((url) => {
    let host = 'منبع بازار';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      // host پیش‌فرض می‌ماند
    }
    return {
      title: `پیوند بازار: ${host}`,
      url,
      summary: 'از منابع داده‌ی بازار تنظیم‌شده در تنظیمات داشبورد.',
    };
  });
}

/**
 * اخبار تازه‌ی حوزه‌ی یک تیم (حداکثر MAX_NEWS_ITEMS).
 * تیم ناشناس یا خطای هر منبع به آرایه‌ی خالی می‌رسد.
 */
export async function fetchTeamNews(team: string): Promise<NewsItem[]> {
  if (!(team in TEAM_META)) return [];
  const queries = TEAM_NEWS_QUERIES[team as TeamName];
  if (!queries || queries.length === 0) return [];

  const items: NewsItem[] = [];
  const seen = new Set<string>();
  const push = (item: NewsItem): void => {
    if (!seen.has(item.url)) {
      seen.add(item.url);
      items.push(item);
    }
  };

  const settled = await Promise.allSettled(queries.map(fetchRssNews));
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    for (const item of s.value) {
      push(item);
      if (items.length >= MAX_NEWS_ITEMS) break;
    }
    if (items.length >= MAX_NEWS_ITEMS) break;
  }

  if (items.length < MAX_NEWS_ITEMS) {
    try {
      for (const item of await newsFromMarketSources()) {
        push(item);
        if (items.length >= MAX_NEWS_ITEMS) break;
      }
    } catch {
      // ورودی بازار مکمل است؛ خطایش نادیده گرفته می‌شود.
    }
  }

  return items.slice(0, MAX_NEWS_ITEMS);
}
