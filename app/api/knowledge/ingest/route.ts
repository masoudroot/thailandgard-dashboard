import { NextRequest } from 'next/server';
import { ok, fail, getSupabase } from '@/lib/api';
import { indexKnowledge, RAGError } from '@/lib/rag';
import { reportIndexOutcome } from '@/lib/rag-index-health';
import { TEAM_META } from '@/lib/team-meta';

/**
 * POST /api/knowledge/ingest (تیم ۹: خزش منابع)
 *
 * بدنه: { team: string, url?: string, text?: string, title?: string }
 * - اگر url داده شود: صفحه با تایم‌اوت ۲۰ ثانیه fetch می‌شود، HTML به متن
 *   تمیز تبدیل می‌شود (حذف اسکریپت/استایل/تگ‌ها، سقف ۲۰۰۰۰ کاراکتر).
 * - اگر text داده شود: همان متن مستقیم استفاده می‌شود.
 * - اگر هر دو داده شوند، url اولویت دارد.
 * سپس یک رکورد در team_knowledge ساخته می‌شود (source همان url یا
 * «متن دستی») و با indexKnowledge از lib/rag.ts ایندکس RAG می‌شود.
 *
 * فقط دامنه‌های http و https مجاز‌اند. احراز ادمین توسط میان‌افزار انجام
 * می‌شود. همه‌ی خطاها با پیام فارسی واضح برمی‌گردند.
 */

const FETCH_TIMEOUT_MS = 20_000;
const MAX_CONTENT_CHARS = 20_000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const TITLE_FALLBACK_LEN = 80;

interface IngestBody {
  team?: unknown;
  url?: unknown;
  text?: unknown;
  title?: unknown;
}

/** فقط http و https مجاز‌اند؛ بقیه (از جمله URL نسبی) رد می‌شوند. */
function parseAllowedUrl(raw: string): URL | null {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed;
    return null;
  } catch {
    return null;
  }
}

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/** دیکد موجودیت‌های رایج HTML و موجودیت‌های عددی. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => {
      const n = parseInt(code, 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => {
      const n = parseInt(code, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _;
    })
    .replace(/&[a-zA-Z]+;/g, (entity) => ENTITY_MAP[entity] ?? entity);
}

/** استخراج عنوان از تگ title صفحه. */
function extractPageTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return '';
  return decodeEntities(match[1].replace(/\s+/g, ' ')).trim();
}

/** تبدیل HTML به متن تمیز: حذف اسکریپت/استایل/کامنت و تگ‌ها. */
function htmlToText(html: string): string {
  const noScripts = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const noTags = noScripts.replace(/<[^>]*>/g, ' ');
  return decodeEntities(noTags).replace(/\s+/g, ' ').trim();
}

/** دریافت صفحه با تایم‌اوت ۲۰ ثانیه. */
async function fetchPage(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'ThailandGard-Knowledge/1.0 (+https://thailandgard.ir)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      throw new RAGError(`دریافت صفحه ناموفق بود (کد ${res.status}).`);
    }
    const buffer = await res.arrayBuffer();
    const bytes = buffer.byteLength > MAX_HTML_BYTES ? buffer.slice(0, MAX_HTML_BYTES) : buffer;
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new RAGError('دریافت صفحه بیش از ۲۰ ثانیه طول کشید.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  let body: IngestBody;
  try {
    body = await request.json();
  } catch {
    return fail('بدنه درخواست نامعتبر است.', 400);
  }

  const team = typeof body.team === 'string' ? body.team.trim() : '';
  if (!team || !(team in TEAM_META)) {
    return fail('تیم نامعتبر است.', 400);
  }

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const titleHint = typeof body.title === 'string' ? body.title.trim() : '';

  if (!url && !text) {
    return fail('یکی از url یا text باید داده شود.', 400);
  }

  let content = '';
  let source = '';
  let resolvedTitle = titleHint;

  try {
    if (url) {
      const parsed = parseAllowedUrl(url);
      if (!parsed) {
        return fail('آدرس معتبر نیست؛ فقط http و https پشتیبانی می‌شود.', 400);
      }
      const html = await fetchPage(parsed.toString());
      if (!resolvedTitle) resolvedTitle = extractPageTitle(html);
      content = htmlToText(html);
      source = parsed.toString();
    } else {
      content = text;
      source = 'متن دستی';
    }
  } catch (err) {
    if (err instanceof RAGError) return fail(err.message, 502);
    return fail(`خطا در دریافت منبع: ${err instanceof Error ? err.message : String(err)}`, 502);
  }

  if (content.length > MAX_CONTENT_CHARS) {
    content = content.slice(0, MAX_CONTENT_CHARS).trimEnd();
  }
  if (!content) {
    return fail('متن قابل‌استخراجی از این منبع به دست نیامد.', 422);
  }

  if (!resolvedTitle) {
    resolvedTitle =
      content.replace(/\s+/g, ' ').slice(0, TITLE_FALLBACK_LEN).trim() ||
      (url ? source : 'متن دستی');
  }

  try {
    const supabase = getSupabase();
    const { data: item, error } = await supabase
      .from('team_knowledge')
      .insert({ team, title: resolvedTitle, content, source })
      .select('id')
      .single();
    if (error || !item) {
      return fail(`ثبت دانش در دیتابیس ناموفق بود: ${error?.message ?? 'خطای ناشناخته'}`, 500);
    }

    // ایندکس RAG؛ شکستش نباید رکورد ساخته‌شده را از بین ببرد، ولی دیگر
    // بی‌صدا هم نیست: در سلامت مسیر ثبت می‌شود (رفع ریشه‌ای مشکل ۳).
    let indexed = false;
    let indexWarning: string | undefined;
    try {
      await indexKnowledge(item.id, team, resolvedTitle, content);
      indexed = true;
      await reportIndexOutcome({
        knowledgeId: item.id,
        team,
        ok: true,
        source: 'api/knowledge/ingest',
      });
    } catch (err) {
      indexWarning =
        err instanceof RAGError ? err.message : 'ایندکس معنایی انجام نشد.';
      await reportIndexOutcome({
        knowledgeId: item.id,
        team,
        ok: false,
        error: indexWarning,
        source: 'api/knowledge/ingest',
      });
    }

    return ok(
      {
        id: item.id,
        team,
        title: resolvedTitle,
        source,
        chars: content.length,
        indexed,
        ...(indexWarning ? { indexWarning } : {}),
      },
      201,
    );
  } catch (err) {
    return fail(`خطای غیرمنتظره: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
}
