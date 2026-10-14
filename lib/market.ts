/**
 * lib/market.ts - سرویس «منبع داده بیرونی بازار» برای تیم intel.
 *
 * تیم intel پیش از اجرای خط لوله‌ی LLM، از این سرویس داده‌ی بازار می‌گیرد.
 * قرارداد اصلی: کاملاً graceful است. هیچ‌وقت throw نمی‌کند؛ همیشه یک
 * MarketResult برمی‌گرداند و شکست منبع، چرخه را متوقف نمی‌کند.
 *
 * زنجیره‌ی فالبک:
 *  ۱. منبع زنده (HTTP با تایم‌اوت + ۳ تلاش با backoff)
 *  ۲. کشِ آخرین داده‌ی موفق (در جدول settings ذخیره می‌شود)
 *  ۳. ادامه بدون داده (ok=false با پیام فارسی واضح)
 *
 * پیکربندی در جدول `settings` با کلید `market_source` نگه‌داری می‌شود و
 * از کارت «منبع داده بازار» در صفحه‌ی تنظیمات داشبورد قابل ویرایش است.
 */

import { getSetting, setSetting } from './settings';

/** خط تیره‌ی بلند (U+2014) در هیچ خروجی نباید باشد. */
function sanitize(input: string): string {
  return input.replace(/—/g, '-');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** نتیجه‌ی آخرین بررسی اتصال (برای نمایش در تنظیمات). */
export interface MarketLastCheck {
  ok: boolean;
  at: string;
  message: string;
  latencyMs: number | null;
}

/** پیکربندی منبع داده بازار (یک ردیف در settings با کلید market_source). */
export interface MarketConfig {
  enabled: boolean;
  url: string;
  timeoutSec: number;
  lastCheck: MarketLastCheck | null;
  lastGood: { at: string; data: string } | null;
}

/** خروجی هر فراخوانی داده‌ی بازار. */
export interface MarketResult {
  /** آیا داده‌ی قابل استفاده داریم؟ (زنده یا کش) */
  ok: boolean;
  /** متن داده؛ در صورت خاموش‌بودن یا شکست کامل، رشته‌ی خالی. */
  data: string;
  /** منبع داده‌ی برگشتی. */
  source: 'live' | 'cache' | 'off';
  /** توضیح فارسی برای نمایش (هشدار یا خطا)؛ null یعنی همه‌چیز عادی. */
  note: string | null;
  latencyMs: number | null;
}

/** نتیجه‌ی دکمه‌ی «تست اتصال». */
export interface MarketTestResult {
  ok: boolean;
  message: string;
  latencyMs: number | null;
}

export const MARKET_SETTINGS_KEY = 'market_source';

export const DEFAULT_MARKET_CONFIG: MarketConfig = {
  enabled: false,
  url: '',
  timeoutSec: 30,
  lastCheck: null,
  lastGood: null,
};

const MAX_DATA_CHARS = 8000;
const RETRIES = 3;

/** خواندن پیکربندی از settings + ادغام با پیش‌فرض‌ها. */
export async function getMarketConfig(): Promise<MarketConfig> {
  const stored = await getSetting<Partial<MarketConfig>>(MARKET_SETTINGS_KEY, {});
  return {
    enabled: stored.enabled === true,
    url: typeof stored.url === 'string' ? stored.url : DEFAULT_MARKET_CONFIG.url,
    timeoutSec:
      typeof stored.timeoutSec === 'number' && Number.isFinite(stored.timeoutSec)
        ? Math.min(300, Math.max(5, Math.round(stored.timeoutSec)))
        : DEFAULT_MARKET_CONFIG.timeoutSec,
    lastCheck: stored.lastCheck ?? null,
    lastGood: stored.lastGood ?? null,
  };
}

/** ذخیره‌ی جزئی پیکربندی؛ کل آبجکت به‌روزشده برمی‌گردد. */
export async function saveMarketConfig(patch: Partial<MarketConfig>): Promise<MarketConfig> {
  const current = await getMarketConfig();
  const next: MarketConfig = {
    ...current,
    ...patch,
    url: typeof patch.url === 'string' ? patch.url.trim() : current.url,
    timeoutSec:
      typeof patch.timeoutSec === 'number' && Number.isFinite(patch.timeoutSec)
        ? Math.min(300, Math.max(5, Math.round(patch.timeoutSec)))
        : current.timeoutSec,
  };
  await setSetting(MARKET_SETTINGS_KEY, next);
  return next;
}

/** ثبت نتیجه‌ی آخرین بررسی اتصال (بدون دست‌کاری بقیه‌ی تنظیمات). */
async function recordCheck(check: MarketLastCheck): Promise<void> {
  try {
    await saveMarketConfig({ lastCheck: check });
  } catch {
    // ثبت وضعیت نباید خودش خطا بدهد؛ بی‌صدا رد می‌شود.
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
        `اتصال به منبع داده بیرونی قطع شد (timeout پس از ${Math.round(timeoutMs / 1000)} ثانیه).`,
      );
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * تست فوری اتصال به یک آدرس (دکمه‌ی «تست اتصال» در تنظیمات).
 * نتیجه در lastCheck ذخیره می‌شود تا در کارت تنظیمات نمایش داده شود.
 */
export async function testMarketConnection(
  url: string,
  timeoutSec: number,
): Promise<MarketTestResult> {
  const cleanUrl = url.trim();
  const timeoutMs = Math.min(300, Math.max(5, Math.round(timeoutSec))) * 1000;
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
    await recordCheck(check);
    return { ok: true, message: check.message, latencyMs };
  } catch (err) {
    const message = sanitize(err instanceof Error ? err.message : String(err));
    await recordCheck({ ok: false, at: new Date().toISOString(), message, latencyMs: null });
    return { ok: false, message, latencyMs: null };
  }
}

/**
 * نقطه‌ی ورود اصلی تیم intel: گرفتن داده‌ی بازار با فالبک کامل.
 * هرگز throw نمی‌کند.
 */
export async function fetchMarketData(): Promise<MarketResult> {
  const cfg = await getMarketConfig();

  if (!cfg.enabled || !cfg.url) {
    return { ok: true, data: '', source: 'off', note: null, latencyMs: null };
  }

  const timeoutMs = cfg.timeoutSec * 1000;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (attempt > 0) await sleep(2000 * attempt); // backoff: ۲ ثانیه، ۴ ثانیه
    try {
      const { text, latencyMs } = await fetchWithTimeout(cfg.url, timeoutMs);
      const at = new Date().toISOString();
      try {
        await saveMarketConfig({
          lastCheck: { ok: true, at, message: 'اتصال سالم است.', latencyMs },
          lastGood: { at, data: text },
        });
      } catch {
        // ذخیره‌ی کش نباید جلوی تحویل داده را بگیرد.
      }
      return { ok: true, data: text, source: 'live', note: null, latencyMs };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  const message = sanitize(lastError?.message ?? 'خطای نامشخص در اتصال به منبع داده.');
  await recordCheck({ ok: false, at: new Date().toISOString(), message, latencyMs: null });

  // فالبک ۱: کشِ آخرین داده‌ی موفق
  if (cfg.lastGood?.data) {
    return {
      ok: true,
      data: cfg.lastGood.data,
      source: 'cache',
      note: `منبع زنده در دسترس نبود؛ از کش استفاده شد. ${message}`,
      latencyMs: null,
    };
  }

  // فالبک ۲: ادامه بدون داده؛ چرخه متوقف نمی‌شود.
  return { ok: false, data: '', source: 'cache', note: message, latencyMs: null };
}
