/**
 * GET /api/settings/market: خواندن پیکربندی منبع داده بازار.
 * POST /api/settings/market: ذخیره‌ی پیکربندی (enabled / url / timeoutSec).
 *
 * احراز هویت از میدل‌ویر می‌آید (مسیرهای /api محافظت‌شده‌اند).
 */

import { fail, ok } from '../../../../lib/api';
import {
  getMarketConfig,
  saveMarketConfig,
  type MarketConfig,
} from '../../../../lib/market';

export async function GET(): Promise<Response> {
  try {
    const cfg = await getMarketConfig();
    const { lastGood, ...rest } = cfg;
    return ok({ ...rest, hasCache: !!lastGood?.data });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => ({}));
    const b = (body ?? {}) as Record<string, unknown>;
    const patch: Partial<MarketConfig> = {};

    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
    if (typeof b.url === 'string') patch.url = b.url;
    if (b.timeoutSec !== undefined) {
      const t = Number(b.timeoutSec);
      if (!Number.isFinite(t) || t < 5 || t > 300) {
        return fail('تایم‌اوت باید بین ۵ تا ۳۰۰ ثانیه باشد.', 400);
      }
      patch.timeoutSec = Math.round(t);
    }

    const cfg = await saveMarketConfig(patch);
    const { lastGood, ...rest } = cfg;
    return ok({ ...rest, hasCache: !!lastGood?.data });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
