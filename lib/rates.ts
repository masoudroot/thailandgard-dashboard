/**
 * lib/rates.ts - ربات نرخ ارز (بدون AI).
 *
 * ۴ بار در روز از وب‌سرویس نوسان نرخ‌ها را می‌گیرد و در جدول
 * `exchange_rates` ذخیره می‌کند. تیم‌ها با getLatestRates() آخرین
 * نرخ‌ها را برای حساب‌وکتاب می‌خوانند.
 *
 * کلید نوسان فقط از متغیر محیطی NAVASAN_API_KEY خوانده می‌شود و
 * هیچ‌وقت در لاگ یا خروجی نوشته نمی‌شود.
 *
 * اگر API در دسترس نبود، خطای فارسی برمی‌گردد؛ هیچ عدد ساختگی تولید نمی‌شود.
 */

import { getSupabase } from './api';
import { getSetting, setSetting } from './settings';

/** یک قلم نرخ از خروجی نوسان */
export interface NavasanItem {
  value: string | number;
  change: string | number;
  timestamp: number;
  date: string;
}

/** نتیجه‌ی یک فچ */
export interface RatesFetchResult {
  ok: boolean;
  message: string;
  fetchedAt: string | null;
  count: number;
}

/** ارزهای مهم برای داشبورد: نماد نوسان ← نام فارسی */
export const KEY_CURRENCIES: Array<{ symbol: string; faName: string }> = [
  { symbol: 'usd_sell', faName: 'دلار تهران (فروش)' },
  { symbol: 'harat_naghdi_sell', faName: 'دلار هرات (فروش)' },
  { symbol: 'aed_sell', faName: 'درهم امارات (فروش)' },
  { symbol: 'eur', faName: 'یورو' },
  { symbol: 'thb', faName: 'بات تایلند' },
];

/** تنظیمات زمان‌بندی ربات */
export interface RatesSchedule {
  enabled: boolean;
  /** ساعت‌های تهران به شکل HH:MM */
  times: string[];
}

export const RATES_SCHEDULE_KEY = 'rates_schedule';

export const DEFAULT_RATES_SCHEDULE: RatesSchedule = {
  enabled: true,
  times: ['10:30', '13:00', '16:30', '20:00'],
};

export async function getRatesSchedule(): Promise<RatesSchedule> {
  const stored = await getSetting<Partial<RatesSchedule>>(RATES_SCHEDULE_KEY, {});
  const times = Array.isArray(stored.times)
    ? stored.times.filter((t) => typeof t === 'string' && /^\d{2}:\d{2}$/.test(t)).slice(0, 8)
    : DEFAULT_RATES_SCHEDULE.times;
  return {
    enabled: stored.enabled !== false,
    times: times.length > 0 ? times : DEFAULT_RATES_SCHEDULE.times,
  };
}

export async function saveRatesSchedule(patch: Partial<RatesSchedule>): Promise<RatesSchedule> {
  const current = await getRatesSchedule();
  const next: RatesSchedule = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    times: Array.isArray(patch.times)
      ? patch.times.filter((t) => typeof t === 'string' && /^\d{2}:\d{2}$/.test(t)).slice(0, 8)
      : current.times,
  };
  if (next.times.length === 0) next.times = DEFAULT_RATES_SCHEDULE.times;
  await setSetting(RATES_SCHEDULE_KEY, next);
  return next;
}

const FETCH_TIMEOUT_MS = 30000;

/** گرفتن نرخ‌ها از نوسان و ذخیره در دیتابیس. هرگز عدد ساختگی تولید نمی‌کند. */
export async function fetchNavasanRates(): Promise<RatesFetchResult> {
  const apiKey = process.env.NAVASAN_API_KEY;
  if (!apiKey) {
    return { ok: false, message: 'کلید نوسان تنظیم نشده است (NAVASAN_API_KEY).', fetchedAt: null, count: 0 };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `http://api.navasan.tech/latest/?api_key=${encodeURIComponent(apiKey)}`,
      { signal: controller.signal, headers: { 'User-Agent': 'thailandgard-dashboard/1.0' } },
    );
    if (!res.ok) throw new Error(`نوسان پاسخ ${res.status} برگرداند.`);
    const data: unknown = await res.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('پاسخ نوسان معتبر نیست.');
    }
    const rates = data as Record<string, NavasanItem>;
    const count = Object.keys(rates).length;
    if (count === 0) throw new Error('نوسان هیچ نرخی برنگرداند.');

    const fetchedAt = new Date().toISOString();
    const { error } = await getSupabase()
      .from('exchange_rates')
      .insert({ fetched_at: fetchedAt, rates, source: 'navasan' });
    if (error) throw new Error(`ذخیره نرخ‌ها ناموفق بود: ${error.message}`);

    return { ok: true, message: 'نرخ‌ها به‌روز شد.', fetchedAt, count };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, message: 'اتصال به نوسان قطع شد (تایم‌اوت).', fetchedAt: null, count: 0 };
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err), fetchedAt: null, count: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** آخرین نرخ‌های ذخیره‌شده؛ null یعنی هنوز هیچ فچی موفق نبوده. */
export async function getLatestRates(): Promise<{
  fetchedAt: string | null;
  rates: Record<string, NavasanItem>;
} | null> {
  try {
    const { data, error } = await getSupabase()
      .from('exchange_rates')
      .select('fetched_at, rates')
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return { fetchedAt: data.fetched_at as string, rates: (data.rates ?? {}) as Record<string, NavasanItem> };
  } catch {
    return null;
  }
}

/** نرخ قبلی برای مقایسه تغییر (دفعه‌ی قبل از آخرین فچ). */
export async function getPreviousRates(): Promise<Record<string, NavasanItem> | null> {
  try {
    const { data, error } = await getSupabase()
      .from('exchange_rates')
      .select('rates')
      .order('fetched_at', { ascending: false })
      .limit(2);
    if (error || !data || data.length < 2) return null;
    return (data[1].rates ?? {}) as Record<string, NavasanItem>;
  } catch {
    return null;
  }
}

/** تاریخچه‌ی فچ‌ها برای نمودار (پیش‌فرض ۷ روز). */
export async function getRatesHistory(days = 7): Promise<
  Array<{ fetchedAt: string; rates: Record<string, NavasanItem> }>
> {
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await getSupabase()
      .from('exchange_rates')
      .select('fetched_at, rates')
      .gte('fetched_at', since)
      .order('fetched_at', { ascending: true });
    if (error || !data) return [];
    return data.map((r) => ({
      fetchedAt: r.fetched_at as string,
      rates: (r.rates ?? {}) as Record<string, NavasanItem>,
    }));
  } catch {
    return [];
  }
}
