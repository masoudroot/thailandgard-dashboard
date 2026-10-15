/**
 * lib/knowledge-pipeline.ts — قدم ۲ خط لوله دانش: استخراج نکته دانشی.
 *
 * تفکیک نکته دانشی از خلاصه: خلاصه می‌گوید «این صفحه درباره چه بود»؛
 * نکته دانشی جمله‌ای است که تیم بتواند فردا در تصمیم یا اجرا به آن استناد کند.
 * طراحی: docs/knowledge-pipeline.md (تیم ۳)
 *
 * fail-soft: هر خطایی فقط آرایه خالی برمی‌گرداند، هرگز چرخه را نمی‌شکند.
 */

import { callLLMJson } from './llm';

/** یک نکته دانشی استخراج‌شده از متن منبع. */
export interface KnowledgePoint {
  /** عنوان کوتاه نکته */
  title: string;
  /** متن نکته (۱ تا ۳ جمله، فارسی روان) */
  point: string;
  /** در یک جمله: چرا برای این تیم مهم است */
  why_matters: string;
  /** جمله عینی متن منبع که نکته از آن گرفته شده (اختیاری) */
  quote?: string;
}

export interface ExtractKnowledgePointsOptions {
  /** نام فارسی تیم برای لحن پرامپت (مثلاً: «سئو») */
  teamFa?: string;
  /** نام نمایشی منبع (مثلاً: «Google Search Central Blog») */
  sourceName?: string;
  /** URL دقیق صفحه خوانده‌شده */
  sourceUrl?: string;
  /** عنوان‌های دانش موجود همان تیم تا نکته تکراری تولید نشود (حداکثر ۲۰ عنوان) */
  existingTitles?: string[];
  /** سقف نکته در هر استخراج؛ پیش‌فرض ۵ */
  maxPoints?: number;
}

const MAX_POINTS_DEFAULT = 5;

const EXTRACT_PROMPT = `تو استخراج‌کننده «نکته دانشی» برای تیم «{team_fa}» هستی.
مأموریت این تیم: {mission}

متن زیر از منبع «{source_name}» ({source_url}) گرفته شده است:

---
{clean_text}
---

دانش‌هایی که این تیم از قبل دارد (تکراری نگو):
{existing_titles}

قانون‌ها:
۱. فقط نکته‌هایی استخراج کن که مستقیم به مأموریت این تیم ربط دارند.
۲. هر نکته باید «قابل استناد» باشد: یک ادعای مشخص، یک عدد، یک قاعده اجرایی یا یک هشدار درباره اشتباه رایج.
۳. چیزهای بدیهی («محتوا مهم است»)، تبلیغات منبع، و نظر شخصی نویسنده بدون پشتوانه را نیاور.
۴. اگر متن هیچ نکته به‌دردبخوری نداشت، آرایه خالی برگردان و چیزی نساز.
۵. حداکثر {max_points} نکته. هر نکته ۱ تا ۳ جمله، فارسی روان.
۶. خروجی فقط JSON معتبر باشد، بدون هیچ متن اضافه.

ساختار هر نکته:
{
  "title": "عنوان کوتاه نکته",
  "point": "متن نکته",
  "why_matters": "در یک جمله: چرا برای این تیم مهم است",
  "quote": "جمله عینی متن منبع که نکته از آن گرفته شده (اختیاری)"
}

خروجی باید آرایه‌ای از همین ساختار باشد.`;

function fillTemplate(tpl: string, vars: Record<string, string>): string {
  let out = tpl;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{${key}}`, value);
  }
  return out;
}

/**
 * از متن تمیزشده یک منبع، نکته‌های دانشی مرتبط با مأموریت تیم استخراج می‌کند.
 *
 * @param content متن تمیزشده صفحه (تا سقف حجم؛ برش در مرز پاراگراف)
 * @param teamMission مأموریت یک‌خطی تیم (مثلاً: «بهینه‌سازی فنی و محتوایی سایت برای گوگل»)
 * @param opts تنظیمات اختیاری: نام فارسی تیم، منبع، عنوان‌های موجود، سقف نکته
 * @returns آرایه نکته‌های دانشی؛ در صورت خطا یا نبود نکته، آرایه خالی
 */
export async function extractKnowledgePoints(
  content: string,
  teamMission: string,
  opts: ExtractKnowledgePointsOptions = {},
): Promise<KnowledgePoint[]> {
  const cleanText = (content ?? '').trim();
  if (!cleanText || cleanText.length < 100) return [];

  const maxPoints = opts.maxPoints ?? MAX_POINTS_DEFAULT;
  const existingTitles = (opts.existingTitles ?? []).slice(0, 20);

  const prompt = fillTemplate(EXTRACT_PROMPT, {
    team_fa: opts.teamFa ?? 'این تیم',
    mission: teamMission,
    source_name: opts.sourceName ?? 'منبع',
    source_url: opts.sourceUrl ?? '',
    clean_text: cleanText,
    existing_titles:
      existingTitles.length > 0
        ? existingTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')
        : '(هنوز دانشی ثبت نشده است)',
    max_points: String(maxPoints),
  });

  let raw: unknown;
  try {
    raw = await callLLMJson(prompt, {
      temperature: 0.1,
      maxTokens: 1500,
    });
  } catch {
    return [];
  }

  const items = Array.isArray(raw) ? raw : [];
  const points: KnowledgePoint[] = [];
  for (const item of items.slice(0, maxPoints)) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const title = typeof rec.title === 'string' ? rec.title.trim() : '';
    const point = typeof rec.point === 'string' ? rec.point.trim() : '';
    const whyMatters = typeof rec.why_matters === 'string' ? rec.why_matters.trim() : '';
    if (!title || !point || !whyMatters) continue;
    const quote = typeof rec.quote === 'string' && rec.quote.trim() ? rec.quote.trim() : undefined;
    points.push({ title, point, why_matters: whyMatters, ...(quote ? { quote } : {}) });
  }
  return points;
}

/* ------------------------------------------------------------------ */
/* قدم ۱ خط لوله: دریافت (fetch) محتوای منبع                            */
/* ------------------------------------------------------------------ */

import { createHash } from 'node:crypto';
import { readMemory, writeMemory } from './memory';

/** نتیجه‌ی دریافت و تمیزسازی یک منبع. */
export interface FetchSourceContentResult {
  ok: boolean;
  /** URL درخواستی (همان ورودی). */
  url: string;
  /** عنوان صفحه از تگ title، اگر پیدا شود. */
  title: string | null;
  /** متن تمیزشده (حداکثر ۶۰ هزار کاراکتر). */
  text: string;
  /** آیا متن در سقف ۶۰ هزار کاراکتر برش خورده است. */
  truncated: boolean;
  /** آیا از کش ۷ روزه آمده است. */
  fromCache: boolean;
  /** پیام کوتاه فارسی در صورت شکست. */
  error?: string;
  /** زمان ISO دریافت اصلی. */
  fetchedAt?: string;
}

const FETCH_TIMEOUT_MS = 20_000;
const MAX_TEXT_CHARS = 60_000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // ۷ روز
const CACHE_TEAM = 'system';
const FETCH_USER_AGENT = 'ThailandGard-KnowledgeBot';

/** خط تیره‌ی بلند (U+2014) در هیچ خروجی نباید باشد. */
function sanitizeFetchText(input: string): string {
  return input.replace(/\u2014/g, '-');
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function fetchCacheKey(url: string): string {
  return `knowledge:fetch-cache:${sha256Hex(url)}`;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => {
      const code = parseInt(n, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/&amp;/g, '&');
}

/** حذف بلوک‌های <tag>...</tag> (غیرحریصانه). */
function removeHtmlBlocks(html: string, tags: string[]): string {
  let out = html;
  for (const tag of tags) {
    out = out.replace(new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  }
  return out;
}

/** استخراج عنوان صفحه از تگ title. */
function extractPageTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  const title = decodeHtmlEntities(match[1].replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return title ? sanitizeFetchText(title).slice(0, 300) : null;
}

/** بدنه‌ی اصلی: article/main در اولویت، وگرنه body، وگرنه کل سند. */
function extractMainBody(html: string): string {
  const pick = (tag: string): string | null => {
    const match = html.match(new RegExp(`<${tag}[\\s>]([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return match ? match[1] : null;
  };
  return pick('article') ?? pick('main') ?? pick('body') ?? html;
}

/**
 * تبدیل HTML به متن ساده با حفظ سرفصل‌ها.
 * حذف script/style/noscript، کامنت‌ها و بلوک‌های nav/header/footer/aside/form؛
 * سرفصل‌های h1 تا h3 به‌صورت خط جدا؛ بقیه تگ‌های بلوکی به خط جدید.
 */
export function cleanHtmlToText(html: string): string {
  let out = html;
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  out = removeHtmlBlocks(out, ['script', 'style', 'noscript']);
  out = removeHtmlBlocks(out, ['nav', 'header', 'footer', 'aside', 'form']);
  out = extractMainBody(out);
  out = out.replace(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi, '\n\n$2\n\n');
  out = out.replace(/<\/?(p|div|section|li|tr|hr|blockquote)(\s[^>]*)?>/gi, '\n');
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<[^>]*>/g, ' ');
  out = decodeHtmlEntities(out);
  out = out
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return sanitizeFetchText(out);
}

/** برش در سقف، با اولویت مرز پاراگراف (نه وسط جمله). */
function truncateAtParagraph(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = text.slice(0, max);
  const paraBreak = head.lastIndexOf('\n\n');
  if (paraBreak > max * 0.5) return { text: head.slice(0, paraBreak).trimEnd(), truncated: true };
  const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.\n'));
  if (sentenceEnd > max * 0.5) return { text: head.slice(0, sentenceEnd + 1), truncated: true };
  const lastSpace = head.lastIndexOf(' ');
  if (lastSpace > max * 0.5) return { text: head.slice(0, lastSpace), truncated: true };
  return { text: head, truncated: true };
}

interface FetchCacheValue {
  url: string;
  title: string | null;
  text: string;
  truncated: boolean;
  fetchedAt: string;
}

/** خواندن کش؛ null یعنی کش معتبر نیست (منقضی، خراب یا خطا). */
async function readFetchCache(url: string): Promise<FetchCacheValue | null> {
  try {
    const entries = await readMemory(CACHE_TEAM);
    const row = entries.find((e) => e.key === fetchCacheKey(url));
    if (!row) return null;
    const value = JSON.parse(row.value) as FetchCacheValue;
    if (!value || typeof value.text !== 'string' || !value.fetchedAt) return null;
    if (Date.now() - Date.parse(value.fetchedAt) > CACHE_TTL_MS) return null;
    return value;
  } catch {
    return null;
  }
}

/** ذخیره در کش؛ خطا نادیده گرفته می‌شود (کش اختیاری است). */
async function writeFetchCache(url: string, value: FetchCacheValue): Promise<void> {
  try {
    await writeMemory(CACHE_TEAM, fetchCacheKey(url), value);
  } catch {
    // کش خراب نباید دریافت را بشکند
  }
}

/**
 * دریافت و تمیزسازی محتوای یک منبع دانشی.
 * فقط http/https، فقط پاسخ ۲۰۰، فقط text/html یا text/plain.
 * هرگز throw نمی‌کند؛ شکست در آبجکت نتیجه با ok=false برمی‌گردد.
 */
export async function fetchSourceContent(url: string): Promise<FetchSourceContentResult> {
  const fail = (error: string): FetchSourceContentResult => ({
    ok: false,
    url,
    title: null,
    text: '',
    truncated: false,
    fromCache: false,
    error,
  });

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail('نشانی منبع معتبر نیست.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail('فقط نشانی‌های http و https پشتیبانی می‌شوند.');
  }

  // کش ۷ روزه
  const cached = await readFetchCache(url);
  if (cached) {
    return {
      ok: true,
      url,
      title: cached.title,
      text: cached.text,
      truncated: cached.truncated,
      fromCache: true,
      fetchedAt: cached.fetchedAt,
    };
  }

  let html: string;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': FETCH_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
      },
    });
    if (!res.ok) return fail(`منبع پاسخ ${res.status} برگرداند.`);
    const contentType = res.headers.get('content-type') ?? '';
    if (!/text\/(html|plain)/i.test(contentType) && !/application\/xhtml/i.test(contentType)) {
      return fail('نوع محتوای منبع پشتیبانی نمی‌شود (فقط HTML).');
    }
    html = await res.text();
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return fail('پاسخ منبع در ۲۰ ثانیه نیامد (تایم‌اوت).');
    }
    return fail('دریافت منبع ناموفق بود.');
  }

  if (!html || html.trim().length < 100) {
    return fail('محتوای منبع خالی یا خیلی کوتاه است.');
  }

  const title = extractPageTitle(html);
  const cleaned = cleanHtmlToText(html);
  if (cleaned.length < 100) {
    return fail('پس از تمیزسازی، متن قابل‌استفاده‌ای نماند.');
  }

  const { text, truncated } = truncateAtParagraph(cleaned, MAX_TEXT_CHARS);
  const fetchedAt = new Date().toISOString();

  const result: FetchSourceContentResult = {
    ok: true,
    url,
    title,
    text,
    truncated,
    fromCache: false,
    fetchedAt,
  };

  await writeFetchCache(url, { url, title, text, truncated, fetchedAt });

  return result;
}
