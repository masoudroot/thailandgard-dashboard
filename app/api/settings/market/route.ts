/**
 * GET /api/settings/market: خواندن پیکربندی منابع داده بازار.
 * POST /api/settings/market: ذخیره‌ی فهرست منابع (name/url/enabled) و timeoutSec.
 *
 * احراز هویت از میدل‌ویر می‌آید (مسیرهای /api محافظت‌شده‌اند).
 */

import { fail, ok } from '../../../../lib/api';
import { getMarketConfig, saveMarketSources } from '../../../../lib/market';

export async function GET(): Promise<Response> {
  try {
    const cfg = await getMarketConfig();
    const sources = cfg.sources.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      enabled: s.enabled,
      hasCache: !!cfg.caches[s.id]?.data,
      lastCheck: cfg.lastChecks[s.id] ?? null,
    }));
    return ok({ sources, timeoutSec: cfg.timeoutSec });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => ({}));
    const b = (body ?? {}) as Record<string, unknown>;

    if (!Array.isArray(b.sources)) {
      return fail('فهرست منابع را بفرستید.', 400);
    }
    if (b.sources.length > 20) {
      return fail('حداکثر ۲۰ منبع می‌توانید ثبت کنید.', 400);
    }
    for (const s of b.sources) {
      if (!s || typeof s !== 'object') return fail('قالب یک منبع درست نیست.', 400);
      const r = s as Record<string, unknown>;
      if (typeof r.url !== 'string' || !r.url.trim()) {
        return fail('آدرس همه منابع باید پر باشد.', 400);
      }
      if (typeof r.name === 'string' && r.name.length > 80) {
        return fail('نام منبع خیلی طولانی است.', 400);
      }
    }
    if (b.timeoutSec !== undefined) {
      const t = Number(b.timeoutSec);
      if (!Number.isFinite(t) || t < 5 || t > 300) {
        return fail('تایم‌اوت باید بین ۵ تا ۳۰۰ ثانیه باشد.', 400);
      }
    }

    const cfg = await saveMarketSources(b.sources, b.timeoutSec);
    const sources = cfg.sources.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      enabled: s.enabled,
      hasCache: !!cfg.caches[s.id]?.data,
      lastCheck: cfg.lastChecks[s.id] ?? null,
    }));
    return ok({ sources, timeoutSec: cfg.timeoutSec });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
