/**
 * lib/settings.ts - خواندن/نوشتن تنظیمات داشبورد در جدول `settings` سوپابیس.
 *
 * جدول settings یک key/value ساده است: key (text, primary) و value (jsonb).
 * همه‌ی توابع graceful هستند: اگر دیتابیس در دسترس نبود، مقدار پیش‌فرض برمی‌گردد
 * و ذخیره‌سازی خطا می‌دهد تا صداکننده تصمیم بگیرد.
 */

import { getSupabase } from './api';

/** خواندن یک کلید تنظیمات؛ در صورت نبود یا خطا، fallback برمی‌گردد. */
export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  try {
    const { data, error } = await getSupabase()
      .from('settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error || !data || data.value === undefined || data.value === null) return fallback;
    return data.value as T;
  } catch {
    return fallback;
  }
}

/** ذخیره‌سازی (upsert) یک کلید تنظیمات. */
export async function setSetting(key: string, value: unknown): Promise<void> {
  const { error } = await getSupabase()
    .from('settings')
    .upsert(
      { key, value, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  if (error) throw new Error(`ذخیره تنظیم «${key}» ناموفق بود: ${error.message}`);
}
