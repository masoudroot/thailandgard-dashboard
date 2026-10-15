/**
 * GET /api/manager/logs: خطاها و فعالیت‌های اخیر برای «مدیر داشبورد».
 *
 * احراز: هدر Authorization: Bearer <token>
 * خروجی: خطاهای جاری تیم‌ها + تاریخچه خطاهای اخیر.
 */

import { fail, ok } from '../../../../lib/api';
import { requireManagerAuth } from '../../../../lib/manager-auth';
import { getCurrentErrors, getErrorAlerts } from '../../../../lib/errors';

export const dynamic = 'force-dynamic';

/** GET /api/manager/logs */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireManagerAuth(request);
  if (auth instanceof Response) return auth;

  try {
    const [current, alerts] = await Promise.all([
      getCurrentErrors().catch(() => []),
      getErrorAlerts().catch(() => []),
    ]);
    return ok({ at: new Date().toISOString(), current, alerts });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'خطای نامشخص');
  }
}
