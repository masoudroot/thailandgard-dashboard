/**
 * POST /api/settings/market/test: تست فوری اتصال به یک منبع داده بازار.
 *
 * ورودی: { id: string } - شناسه منبع ذخیره‌شده، یا
 *         { url: string, timeoutSec?: number } - تست آدرسِ هنوز ذخیره‌نشده
 * خروجی: { ok, data: { ok, message, latencyMs } }
 * نتیجه در lastChecks همان منبع ذخیره می‌شود تا کارت تنظیمات آن را نشان بدهد.
 */

import { fail, ok } from '../../../../../lib/api';
import { getMarketConfig, testMarketConnection } from '../../../../../lib/market';

export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => ({}));
    const b = (body ?? {}) as Record<string, unknown>;
    const cfg = await getMarketConfig();

    let sourceId = '';
    let url = '';
    if (typeof b.id === 'string' && b.id) {
      const found = cfg.sources.find((s) => s.id === b.id);
      if (!found) return fail('این منبع پیدا نشد.', 404);
      sourceId = found.id;
      url = found.url;
    } else if (typeof b.url === 'string' && b.url.trim()) {
      sourceId = `adhoc_${Date.now().toString(36)}`;
      url = b.url.trim();
    } else {
      return fail('شناسه منبع یا آدرس را بفرستید.', 400);
    }

    const timeoutSec =
      b.timeoutSec !== undefined ? Number(b.timeoutSec) : cfg.timeoutSec;
    if (!Number.isFinite(timeoutSec) || timeoutSec < 5 || timeoutSec > 300) {
      return fail('تایم‌اوت باید بین ۵ تا ۳۰۰ ثانیه باشد.', 400);
    }

    const result = await testMarketConnection(sourceId, url, Math.round(timeoutSec));
    return ok(result);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
