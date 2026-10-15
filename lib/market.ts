/**
 * lib/market.ts - سرویس «منابع داده بیرونی بازار» برای تیم intel.
 *
 * تیم intel پیش از اجرای خط لوله‌ی LLM، از این سرویس داده‌ی بازار می‌گیرد.
 * قرارداد اصلی: کاملاً graceful است. هیچ‌وقت throw نمی‌کند؛ همیشه یک
 * MarketResult برمی‌گرداند و شکست یک منبع، بقیه را متوقف نمی‌کند.
 *
 * برای هر منبع فعال، زنجیره‌ی فالبک:
 *  ۱. منبع زنده (HTTP با تایم‌اوت + ۳ تلاش با backoff)
 *  ۲. کشِ آخرین داده‌ی موفق همان منبع
 *  ۳. ادامه بدون داده‌ی آن منبع (بقیه منابع همچنان خوانده می‌شوند)
 *
 * پیکربندی در جدول `settings` با کلید `market_source` نگه‌داری می‌شود و
 * از کارت «منابع داده بازار» در صفحه‌ی تنظیمات داشبورد قابل ویرایش است.
 *
 * سازگاری عقب‌رو: تنظیمات قدیمی تک‌URL به‌صورت خودکار به آرایه تک‌عضوی
 * تبدیل می‌شود.
 */

import { getSetting, setSetting } from './settings';

/** خط تیره‌ی بلند (U+2014) در هیچ خروجی نباید باشد. */
function sanitize(input: string): string {
  return input.replace(/\u2014/g, '-');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** یک منبع داده بازار. */
export interface MarketSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

/** نتیجه‌ی آخرین بررسی اتصال یک منبع (برای نمایش در تنظیمات). */
export interface MarketLastCheck {
  ok: boolean;
  at: string;
  message: string;
  latencyMs: number | null;
}

/** کش آخرین داده‌ی موفق یک منبع. */
export interface MarketCacheEntry {
  at: string;
  data: string;
}

/** پیکربندی منابع داده بازار (یک ردیف در settings با کلید market_source). */
export interface MarketConfig {
  sources: MarketSource[];
  /** تایم‌اوت مشترک همه منابع (ثانیه). */
  timeoutSec: number;
  /** کش جداگانه هر منبع: sourceId -> entry */
  caches: Record<string, MarketCacheEntry>;
  /** آخرین بررسی هر منبع: sourceId -> check */
  lastChecks: Record<string, MarketLastCheck>;
}

/** وضعیت یک منبع در یک فراخوانی. */
export interface MarketSourceStatus {
  id: string;
  name: string;
  ok: boolean;
  source: 'live' | 'cache' | 'off' | 'failed';
  latencyMs: number | null;
}

/** خروجی هر فراخوانی داده‌ی بازار. */
export interface MarketResult {
  /** آیا دست‌کم یک داده‌ی قابل استفاده داریم؟ */
  ok: boolean;
  /** متن ترکیبی همه منابع: «[نام منبع]\n<داده>» */
  data: string;
  /** منبع داده‌ی برگشتی (سازگار با مصرف‌کننده قدیمی). */
  source: 'live' | 'cache' | 'off';
  /** توضیح فارسی برای نمایش (هشدار یا خطا)؛ null یعنی همه‌چیز عادی. */
  note: string | null;
  latencyMs: number | null;
  /** جزئیات هر منبع. */
  perSource: MarketSourceStatus[];
}

/** نتیجه‌ی دکمه‌ی «تست اتصال». */
export interface MarketTestResult {
  ok: boolean;
  message: string;
  latencyMs: number | null;
}

export const MARKET_SETTINGS_KEY = 'market_source';

export const DEFAULT_MARKET_CONFIG: MarketConfig = {
  sources: [],
  timeoutSec: 30,
  caches: {},
  lastChecks: {},
};

const MAX_DATA_CHARS = 8000;
const RETRIES = 3;

function newSourceId(): string {
  try {
    return `src_${crypto.randomUUID().slice(0, 8)}`;
  } catch {
    return `src_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  }
}

function cleanSource(raw: unknown): MarketSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const url = typeof r.url === 'string' ? r.url.trim() : '';
  if (!url) return null;
  return {
    id: typeof r.id === 'string' && r.id.trim() ? r.id.trim() : newSourceId(),
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : 'منبع بازار',
    url,
    enabled: r.enabled !== false,
  };
}

function clampTimeout(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(300, Math.max(5, Math.round(v)))
    : DEFAULT_MARKET_CONFIG.timeoutSec;
}

/** خواندن پیکربندی از settings + ادغام با پیش‌فرض‌ها + مهاجرت قالب قدیمی. */
export async function getMarketConfig(): Promise<MarketConfig> {
  const stored = await getSetting<Record<string, unknown>>(MARKET_SETTINGS_KEY, {});

  let sources: MarketSource[] = [];
  if (Array.isArray(stored.sources)) {
    sources = stored.sources.map(cleanSource).filter((s): s is MarketSource => s !== null);
  } else if (typeof stored.url === 'string' && stored.url.trim()) {
    // مهاجرت از قالب قدیمی تک‌URL
    sources = [
      {
        id: 'legacy',
        name: 'منبع بازار',
        url: stored.url.trim(),
        enabled: stored.enabled === true,
      },
    ];
  }

  const caches: Record<string, MarketCacheEntry> = {};
  if (stored.caches && typeof stored.caches === 'object') {
    for (const [k, v] of Object.entries(stored.caches as Record<string, unknown>)) {
      if (v && typeof v === 'object') {
        const e = v as Record<string, unknown>;
        if (typeof e.data === 'string' && typeof e.at === 'string') {
          caches[k] = { at: e.at, data: e.data };
        }
      }
    }
  } else if (
    stored.lastGood &&
    typeof stored.lastGood === 'object' &&
    typeof (stored.lastGood as Record<string, unknown>).data === 'string'
  ) {
    // مهاجرت کش قدیمی به منبع legacy
    const lg = stored.lastGood as Record<string, unknown>;
    caches['legacy'] = { at: String(lg.at ?? ''), data: String(lg.data) };
  }

  const lastChecks: Record<string, MarketLastCheck> = {};
  if (stored.lastChecks && typeof stored.lastChecks === 'object') {
    for (const [k, v] of Object.entries(stored.lastChecks as Record<string, unknown>)) {
      if (v && typeof v === 'object') {
        const c = v as Record<string, unknown>;
        if (typeof c.ok === 'boolean' && typeof c.at === 'string') {
          lastChecks[k] = {
            ok: c.ok,
            at: c.at,
            message: typeof c.message === 'string' ? c.message : '',
            latencyMs: typeof c.latencyMs === 'number' ? c.latencyMs : null,
          };
        }
      }
    }
  } else if (stored.lastCheck && typeof stored.lastCheck === 'object') {
    const c = stored.lastCheck as Record<string, unknown>;
    if (typeof c.ok === 'boolean' && typeof c.at === 'string') {
      lastChecks['legacy'] = {
        ok: c.ok,
        at: c.at,
        message: typeof c.message === 'string' ? c.message : '',
        latencyMs: typeof c.latencyMs === 'number' ? c.latencyMs : null,
      };
    }
  }

  return {
    sources,
    timeoutSec: clampTimeout(stored.timeoutSec),
    caches,
    lastChecks,
  };
}

/** ذخیره‌ی کامل پیکربندی (منابع + تایم‌اوت). */
export async function saveMarketSources(
  sources: unknown,
  timeoutSec?: unknown,
): Promise<MarketConfig> {
  const current = await getMarketConfig();
  const cleaned = Array.isArray(sources)
    ? sources.map(cleanSource).filter((s): s is MarketSource => s !== null)
    : current.sources;

  // کش و بررسی منابع حذف‌شده را پاک کن تا بیات نماند
  const ids = new Set(cleaned.map((s) => s.id));
  const caches: Record<string, MarketCacheEntry> = {};
  const lastChecks: Record<string, MarketLastCheck> = {};
  for (const [k, v] of Object.entries(current.caches)) if (ids.has(k)) caches[k] = v;
  for (const [k, v] of Object.entries(current.lastChecks)) if (ids.has(k)) lastChecks[k] = v;

  const next: MarketConfig = {
    sources: cleaned,
    timeoutSec: timeoutSec !== undefined ? clampTimeout(timeoutSec) : current.timeoutSec,
    caches,
    lastChecks,
  };
  await setSetting(MARKET_SETTINGS_KEY, next);
  return next;
}

/** ثبت نتیجه‌ی آخرین بررسی یک منبع. */
async function recordCheck(sourceId: string, check: MarketLastCheck): Promise<void> {
  try {
    const current = await getMarketConfig();
    await setSetting(MARKET_SETTINGS_KEY, {
      ...current,
      lastChecks: { ...current.lastChecks, [sourceId]: check },
    });
  } catch {
    // ثبت وضعیت نباید خودش خطا بدهد؛ بی‌صدا رد می‌شود.
  }
}

/** ذخیره‌ی کش یک منبع. */
async function recordCache(sourceId: string, entry: MarketCacheEntry): Promise<void> {
  try {
    const current = await getMarketConfig();
    await setSetting(MARKET_SETTINGS_KEY, {
      ...current,
      caches: { ...current.caches, [sourceId]: entry },
    });
  } catch {
    // ذخیره‌ی کش نباید جلوی تحویل داده را بگیرد.
  }
}

/** فراخوانی HTTP با تایم‌اوت واقعی (AbortController). */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<{ text: string; latencyMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'thailandgard-dashboard/1.0' },
    });
    if (!res.ok) throw new Error(`منبع پاسخ ${res.status} برگرداند.`);
    const text = await res.text();
    return { text: text.slice(0, MAX_DATA_CHARS), latencyMs: Date.now() - started };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `اتصال به منبع داده قطع شد (timeout پس از ${Math.round(timeoutMs / 1000)} ثانیه).`,
      );
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * تست فوری اتصال به یک منبع (دکمه‌ی «تست» در تنظیمات).
 * نتیجه در lastChecks همان منبع ذخیره می‌شود.
 */
export async function testMarketConnection(
  sourceId: string,
  url: string,
  timeoutSec: number,
): Promise<MarketTestResult> {
  const cleanUrl = url.trim();
  const timeoutMs = clampTimeout(timeoutSec) * 1000;
  if (!cleanUrl) {
    return { ok: false, message: 'آدرس منبع داده خالی است.', latencyMs: null };
  }
  try {
    const { latencyMs } = await fetchWithTimeout(cleanUrl, timeoutMs);
    const check: MarketLastCheck = {
      ok: true,
      at: new Date().toISOString(),
      message: 'اتصال سالم است.',
      latencyMs,
    };
    await recordCheck(sourceId, check);
    return { ok: true, message: check.message, latencyMs };
  } catch (err) {
    const message = sanitize(err instanceof Error ? err.message : String(err));
    await recordCheck(sourceId, { ok: false, at: new Date().toISOString(), message, latencyMs: null });
    return { ok: false, message, latencyMs: null };
  }
}

/** خواندن یک منبع با فالبک کش خودش. هرگز throw نمی‌کند. */
async function fetchOneSource(
  source: MarketSource,
  timeoutMs: number,
  caches: Record<string, MarketCacheEntry>,
): Promise<{ status: MarketSourceStatus; text: string | null; cacheSaved: boolean }> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (attempt > 0) await sleep(2000 * attempt); // backoff: ۲ ثانیه، ۴ ثانیه
    try {
      const { text, latencyMs } = await fetchWithTimeout(source.url, timeoutMs);
      const at = new Date().toISOString();
      await recordCheck(source.id, { ok: true, at, message: 'اتصال سالم است.', latencyMs });
      await recordCache(source.id, { at, data: text });
      return {
        status: { id: source.id, name: source.name, ok: true, source: 'live', latencyMs },
        text,
        cacheSaved: true,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  const message = sanitize(lastError?.message ?? 'خطای نامشخص در اتصال به منبع داده.');
  await recordCheck(source.id, { ok: false, at: new Date().toISOString(), message, latencyMs: null });

  const cached = caches[source.id]?.data;
  if (cached) {
    return {
      status: { id: source.id, name: source.name, ok: true, source: 'cache', latencyMs: null },
      text: cached,
      cacheSaved: false,
    };
  }
  return {
    status: { id: source.id, name: source.name, ok: false, source: 'failed', latencyMs: null },
    text: null,
    cacheSaved: false,
  };
}

/**
 * نقطه‌ی ورود اصلی تیم intel: گرفتن داده‌ی بازار از همه منابع فعال.
 * شکست یک منبع، بقیه را متوقف نمی‌کند. هرگز throw نمی‌کند.
 */
export async function fetchMarketData(): Promise<MarketResult> {
  const cfg = await getMarketConfig();
  const active = cfg.sources.filter((s) => s.enabled && s.url);

  if (active.length === 0) {
    return { ok: true, data: '', source: 'off', note: null, latencyMs: null, perSource: [] };
  }

  const timeoutMs = cfg.timeoutSec * 1000;
  const results = await Promise.all(
    active.map((s) => fetchOneSource(s, timeoutMs, cfg.caches)),
  );

  const parts: string[] = [];
  const perSource: MarketSourceStatus[] = [];
  const failedNames: string[] = [];
  const cachedNames: string[] = [];
  let maxLatency: number | null = null;

  for (const r of results) {
    perSource.push(r.status);
    if (r.status.latencyMs != null) {
      maxLatency = maxLatency == null ? r.status.latencyMs : Math.max(maxLatency, r.status.latencyMs);
    }
    if (r.text != null) {
      parts.push(`[${r.status.name}]\n${r.text}`);
      if (r.status.source === 'cache') cachedNames.push(r.status.name);
    } else {
      failedNames.push(r.status.name);
    }
  }

  const anyLive = perSource.some((p) => p.source === 'live');
  const anyData = parts.length > 0;

  let note: string | null = null;
  if (cachedNames.length > 0 || failedNames.length > 0) {
    const bits: string[] = [];
    if (cachedNames.length > 0) bits.push(`از کش استفاده شد: ${cachedNames.join('، ')}`);
    if (failedNames.length > 0) bits.push(`در دسترس نبود: ${failedNames.join('، ')}`);
    note = bits.join('؛ ');
  }

  return {
    ok: anyData,
    data: parts.join('\n\n'),
    source: anyLive ? 'live' : 'cache',
    note,
    latencyMs: maxLatency,
    perSource,
  };
}

/** سازگاری با کد قدیمی: گرفتن داده به شکل قبلی (اولین منبع فعال). */
export async function fetchMarketDataLegacy(): Promise<MarketResult> {
  return fetchMarketData();
}
