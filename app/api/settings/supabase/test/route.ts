/**
 * /api/settings/supabase/test: تست زنده اتصال پایگاه داده (هاب اتصال‌ها).
 *
 * اتصال سوپابیس از متغیرهای محیطی (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)
 * خوانده می‌شود؛ این مسیر فقط وضعیت فعلی را تست می‌کند و چیزی ذخیره نمی‌کند.
 * پاسخ: { connected, latencyMs, message }
 */

import { fail, ok, getSupabase } from '../../../../../lib/api';

/** POST /api/settings/supabase/test */
export async function POST(): Promise<Response> {
  const started = Date.now();
  try {
    const url = process.env.SUPABASE_URL?.trim() || null;
    if (!url) {
      return ok({
        connected: false,
        latencyMs: null,
        message: 'متغیر SUPABASE_URL تنظیم نشده است.',
      });
    }
    // کوئری سبک: فقط یک ردیف از settings می‌خوانیم
    const { error } = await getSupabase().from('settings').select('key').limit(1);
    const latencyMs = Date.now() - started;
    if (error) {
      return ok({
        connected: false,
        latencyMs,
        message: `اتصال ناموفق بود: ${error.message}`,
      });
    }
    return ok({
      connected: true,
      latencyMs,
      message: `پایگاه داده پاسخ داد (${latencyMs} میلی‌ثانیه).`,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** GET: وضعیت خلاصه بدون تست (آیا env ست شده). */
export async function GET(): Promise<Response> {
  try {
    const hasUrl = !!(process.env.SUPABASE_URL?.trim());
    const hasKey = !!(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
    return ok({
      configured: hasUrl && hasKey,
      message:
        hasUrl && hasKey
          ? 'متغیرهای اتصال تنظیم شده‌اند.'
          : 'متغیرهای اتصال (SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY) تنظیم نشده‌اند.',
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
