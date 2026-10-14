/**
 * POST /api/settings/market/test: تست فوری اتصال به منبع داده بازار.
 *
 * ورودی: { url: string, timeoutSec: number }
 * خروجی: { ok, data: { ok, message, latencyMs } }
 * نتیجه در lastCheck تنظیمات ذخیره می‌شود تا کارت تنظیمات آن را نشان بدهد.
 */

import { fail, ok } from '../../../../../lib/api';
import { testMarketConnection } from '../../../../../lib/market';

export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => ({}));
    const b = (body ?? {}) as Record<string, unknown>;
    const url = typeof b.url === 'string' ? b.url.trim() : '';
    const timeoutSec = Number(b.timeoutSec);

    if (!url) return fail('آدرس منبع داده را وارد کنید.', 400);
    if (!Number.isFinite(timeoutSec) || timeoutSec < 5 || timeoutSec > 300) {
      return fail('تایم‌اوت باید بین ۵ تا ۳۰۰ ثانیه باشد.', 400);
    }

    const result = await testMarketConnection(url, Math.round(timeoutSec));
    return ok(result);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
