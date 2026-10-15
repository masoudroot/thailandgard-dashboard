import { fail, ok } from '../../../../lib/api';
import { getErrorAlerts } from '../../../../lib/errors';

/** GET /api/errors/alerts: هشدارها: شکست‌های پشت سر هم و ران‌های گیرکرده (timeout). */
export async function GET(): Promise<Response> {
  try {
    const alerts = await getErrorAlerts();
    return ok(alerts);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
