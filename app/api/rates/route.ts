/**
 * GET /api/rates: آخرین نرخ‌ها + نرخ قبلی + تاریخچه ۷ روزه + زمان‌بندی.
 *
 * احراز هویت از میدل‌ویر می‌آید (مسیرهای /api محافظت‌شده‌اند).
 */

import { fail, ok } from '../../../lib/api';
import {
  getLatestRates,
  getPreviousRates,
  getRatesHistory,
  getRatesSchedule,
} from '../../../lib/rates';

export async function GET(): Promise<Response> {
  try {
    const [latest, previous, history, schedule] = await Promise.all([
      getLatestRates(),
      getPreviousRates(),
      getRatesHistory(7),
      getRatesSchedule(),
    ]);
    return ok({ latest, previous, history, schedule });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
