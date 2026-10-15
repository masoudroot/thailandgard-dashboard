/**
 * POST /api/rates/fetch: اجرای دستی فچ نرخ‌ها از نوسان.
 *
 * احراز هویت از میدل‌ویر می‌آید (مسیرهای /api محافظت‌شده‌اند).
 * کلید نوسان فقط سمت سرور از NAVASAN_API_KEY خوانده می‌شود.
 */

import { fail, ok } from '../../../../lib/api';
import { fetchNavasanRates } from '../../../../lib/rates';

export async function POST(): Promise<Response> {
  try {
    const result = await fetchNavasanRates();
    if (!result.ok) return fail(result.message, 502);
    return ok(result);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
