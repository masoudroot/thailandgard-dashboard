/**
 * GET /api/rates/schedule: خواندن زمان‌بندی ربات نرخ ارز.
 * POST /api/rates/schedule: ذخیره‌ی زمان‌بندی { enabled, times: ["HH:MM", ...] }.
 *
 * احراز هویت از میدل‌ویر می‌آید (مسیرهای /api محافظت‌شده‌اند).
 */

import { fail, ok } from '../../../../lib/api';
import { getRatesSchedule, saveRatesSchedule } from '../../../../lib/rates';

export async function GET(): Promise<Response> {
  try {
    return ok(await getRatesSchedule());
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => ({}));
    const b = (body ?? {}) as Record<string, unknown>;
    const patch: { enabled?: boolean; times?: string[] } = {};
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
    if (Array.isArray(b.times)) {
      patch.times = b.times.filter(
        (t): t is string => typeof t === 'string' && /^\d{2}:\d{2}$/.test(t),
      );
    }
    return ok(await saveRatesSchedule(patch));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
