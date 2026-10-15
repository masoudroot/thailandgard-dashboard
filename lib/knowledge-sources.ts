/**
 * lib/knowledge-sources.ts
 * منطق مشترک مدیریت منابع دانش (knowledge_sources).
 * اعتبارسنجی ورودی، نگاشت نوع/تناوب، و شکل پاسخ API.
 */
import { createHash } from 'node:crypto';
import { TEAMS } from './types';

/** نگاشت نوع نمایشی UI به مقدار دیتابیس. */
const UI_TYPE_TO_DB: Record<string, string> = {
  doc: 'official-doc',
  blog: 'expert-blog',
  competitor: 'competitor',
  research: 'research',
};

/** نگاشت مقدار دیتابیس به نوع نمایشی UI. */
const DB_TYPE_TO_UI: Record<string, string> = {
  'official-doc': 'doc',
  'expert-blog': 'blog',
  competitor: 'competitor',
  research: 'research',
  course: 'blog',
  community: 'blog',
  other: 'blog',
};

/** نگاشت تناوب نمایشی به ساعت. manual عملاً سالانه است (بازخوانی فقط دستی). */
const INTERVAL_TO_HOURS: Record<string, number> = {
  daily: 24,
  weekly: 168,
  monthly: 720,
  manual: 8760,
};

const HOURS_TO_INTERVAL: Array<[number, string]> = [
  [24, 'daily'],
  [168, 'weekly'],
  [720, 'monthly'],
];

export interface SourceInput {
  name?: unknown;
  url?: unknown;
  team?: unknown;
  type?: unknown;
  authority?: unknown;
  refresh_interval?: unknown;
  is_active?: unknown;
  notes?: unknown;
}

export interface ValidatedSource {
  title: string;
  url: string;
  team: string;
  source_type: string;
  authority_tier: number;
  fetch_frequency_hours: number;
  is_active: boolean;
  notes: string | null;
}

/** رکورد خام جدول knowledge_sources. */
export interface SourceRow {
  id: string;
  team: string;
  url: string;
  title: string | null;
  source_type: string;
  authority_tier: number;
  fetch_frequency_hours: number;
  last_fetched_at: string | null;
  last_fetch_status: string | null;
  last_fetch_error: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function isValidUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * اعتبارسنجی ورودی ساخت/ویرایش منبع.
 * در حالت partial فقط فیلدهای داده‌شده چک می‌شوند (برای PATCH).
 * در صورت خطا، پیام فارسی روان برمی‌گرداند.
 */
export function validateSourceInput(
  input: SourceInput,
  partial = false,
): { ok: true; value: Partial<ValidatedSource> } | { ok: false; error: string } {
  const out: Partial<ValidatedSource> = {};

  if (input.name !== undefined || !partial) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) return { ok: false, error: 'نام منبع لازم است.' };
    if (name.length > 200) return { ok: false, error: 'نام منبع خیلی طولانی است (حداکثر ۲۰۰ نویسه).' };
    out.title = name;
  }

  if (input.url !== undefined || !partial) {
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (!url) return { ok: false, error: 'نشانی منبع لازم است.' };
    if (!isValidUrl(url)) return { ok: false, error: 'نشانی معتبر نیست؛ باید با http یا https شروع شود.' };
    out.url = url;
  }

  if (input.team !== undefined || !partial) {
    const team = typeof input.team === 'string' ? input.team.trim() : '';
    if (!team) return { ok: false, error: 'تیم لازم است.' };
    if (!(TEAMS as string[]).includes(team)) return { ok: false, error: 'تیم نامعتبر است.' };
    out.team = team;
  }

  if (input.type !== undefined || !partial) {
    const type = typeof input.type === 'string' ? input.type.trim() : '';
    const mapped = UI_TYPE_TO_DB[type];
    if (!mapped) return { ok: false, error: 'نوع منبع نامعتبر است.' };
    out.source_type = mapped;
  }

  if (input.authority !== undefined || !partial) {
    const authority = Number(input.authority);
    if (![1, 2, 3].includes(authority)) return { ok: false, error: 'درجه اعتبار باید ۱، ۲ یا ۳ باشد.' };
    out.authority_tier = authority;
  }

  if (input.refresh_interval !== undefined || !partial) {
    const interval = typeof input.refresh_interval === 'string' ? input.refresh_interval.trim() : '';
    const hours = INTERVAL_TO_HOURS[interval];
    if (!hours) return { ok: false, error: 'تناوب بازخوانی نامعتبر است.' };
    out.fetch_frequency_hours = hours;
  }

  if (input.is_active !== undefined) {
    out.is_active = input.is_active === true || input.is_active === 'true';
  } else if (!partial) {
    out.is_active = true;
  }

  if (input.notes !== undefined) {
    const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
    out.notes = notes || null;
  } else if (!partial) {
    out.notes = null;
  }

  return { ok: true, value: out };
}

/** تبدیل سطر دیتابیس به شکل قرارداد API. */
export function toSourceResponse(row: SourceRow, recordsCount = 0): Record<string, unknown> {
  let refresh_interval = 'manual';
  for (const [hours, key] of HOURS_TO_INTERVAL) {
    if (row.fetch_frequency_hours === hours) {
      refresh_interval = key;
      break;
    }
  }
  return {
    id: row.id,
    name: row.title ?? row.url,
    url: row.url,
    team: row.team,
    type: DB_TYPE_TO_UI[row.source_type] ?? 'blog',
    authority: row.authority_tier,
    refresh_interval,
    is_active: row.is_active,
    last_fetched_at: row.last_fetched_at,
    last_fetch_status: row.last_fetch_status,
    last_test_ok: null,
    records_count: recordsCount,
  };
}

/** هش محتوای نرمال‌شده برای تشخیص تکراری. */
export function contentHash(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim().slice(0, 20000);
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** نتیجه تست اتصال. */
export interface FetchProbe {
  ok: boolean;
  latencyMs: number;
  httpStatus: number | null;
  error: string | null;
}

/** تست اتصال سبک: اول HEAD، اگر نشد GET با بدنه محدود. */
export async function probeUrl(url: string, timeoutMs = 15000): Promise<FetchProbe> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'ThailandGard-KnowledgeBot/1.0' },
    }).catch(() => null);
    if (!res || !res.ok) {
      res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'ThailandGard-KnowledgeBot/1.0' },
      });
      await res.arrayBuffer().catch(() => null);
    }
    const latencyMs = Date.now() - started;
    if (res.ok) return { ok: true, latencyMs, httpStatus: res.status, error: null };
    return {
      ok: false,
      latencyMs,
      httpStatus: res.status,
      error: `در دسترس نیست؛ کد ${res.status}.`,
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const msg = err instanceof Error && err.name === 'AbortError'
      ? 'پاسخی در ۱۵ ثانیه نیامد.'
      : 'به این نشانی نرسیدیم؛ دوباره تلاش کن.';
    return { ok: false, latencyMs, httpStatus: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** دریافت متن صفحه با سقف حجم. */
export async function fetchPageText(
  url: string,
  timeoutMs = 20000,
  maxBytes = 200_000,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'ThailandGard-KnowledgeBot/1.0' },
    });
    if (!res.ok) return { ok: false, error: `در دسترس نیست؛ کد ${res.status}.` };
    const buf = await res.arrayBuffer().catch(() => null);
    if (!buf) return { ok: false, error: 'بدنه صفحه خوانده نشد.' };
    const bytes = new Uint8Array(buf).slice(0, maxBytes);
    const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
    return { ok: true, text };
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError'
      ? 'پاسخی در ۲۰ ثانیه نیامد.'
      : 'به این نشانی نرسیدیم؛ دوباره تلاش کن.';
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
