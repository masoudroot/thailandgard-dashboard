/**
 * /api/settings/supabase/test: تست زنده اتصال پایگاه داده (هاب اتصال‌ها).
 *
 * دو حالت دارد:
 * ۱. بدون body: اتصال فعلی سرور را از متغیرهای محیطی تست می‌کند.
 * ۲. با body: { url, serviceKey }: مقادیر واردشده در فرم را تست می‌کند،
 *    بدون اینکه چیزی ذخیره شود یا در لاگ بیاید.
 *
 * پاسخ: { connected, latencyMs, message, source: 'env' | 'input' }
 * هیچ‌وقت کلید را در پاسخ برنمی‌گرداند.
 */

import { createClient } from '@supabase/supabase-js';
import { fail, ok, getSupabase } from '../../../../../lib/api';

type TestBody = {
  url?: unknown;
  serviceKey?: unknown;
};

function isNonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

async function probe(url: string, serviceKey: string) {
  const started = Date.now();
  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // کوئری سبک: فقط یک ردیف از settings می‌خوانیم
  const { error } = await client.from('settings').select('key').limit(1);
  const latencyMs = Date.now() - started;
  return { error, latencyMs };
}

/** POST /api/settings/supabase/test */
export async function POST(req: Request): Promise<Response> {
  try {
    let body: TestBody = {};
    try {
      body = (await req.json()) as TestBody;
    } catch {
      // body خالی یعنی تست اتصال فعلی سرور
    }

    if (isNonEmpty(body.url) && isNonEmpty(body.serviceKey)) {
      // تست با مقادیر واردشده در فرم (ذخیره نمی‌شود)
      const url = body.url.trim();
      const serviceKey = body.serviceKey.trim();
      try {
        new URL(url);
      } catch {
        return ok({
          connected: false,
          latencyMs: null,
          message: 'آدرس پروژه معتبر نیست.',
          source: 'input',
        });
      }
      const { error, latencyMs } = await probe(url, serviceKey);
      if (error) {
        return ok({
          connected: false,
          latencyMs,
          message: 'اتصال ناموفق بود. آدرس یا کلید را بررسی کنید.',
          source: 'input',
        });
      }
      return ok({
        connected: true,
        latencyMs,
        message: `اتصال با این مقادیر برقرار شد (${latencyMs} میلی‌ثانیه).`,
        source: 'input',
      });
    }

    // تست اتصال فعلی سرور (از env)
    const envUrl = process.env.SUPABASE_URL?.trim() || null;
    if (!envUrl) {
      return ok({
        connected: false,
        latencyMs: null,
        message: 'اتصال سرور تنظیم نشده است. مقادیر را در فرم وارد و تست کنید.',
        source: 'env',
      });
    }
    const started = Date.now();
    const { error } = await getSupabase().from('settings').select('key').limit(1);
    const latencyMs = Date.now() - started;
    if (error) {
      return ok({
        connected: false,
        latencyMs,
        message: 'اتصال سرور ناموفق بود.',
        source: 'env',
      });
    }
    return ok({
      connected: true,
      latencyMs,
      message: `پایگاه داده پاسخ داد (${latencyMs} میلی‌ثانیه).`,
      source: 'env',
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** GET: وضعیت خلاصه بدون تست (آیا اتصال سرور ست شده). */
export async function GET(): Promise<Response> {
  try {
    const hasUrl = !!(process.env.SUPABASE_URL?.trim());
    const hasKey = !!(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
    return ok({
      configured: hasUrl && hasKey,
      message: hasUrl && hasKey ? 'اتصال سرور تنظیم شده است.' : 'اتصال سرور تنظیم نشده است.',
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
