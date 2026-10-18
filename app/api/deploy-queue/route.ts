import { ok, fail } from '@/lib/api';
import {
  getDeployQueue,
  getDeployStats,
  processDeployQueue,
} from '@/lib/bridge/deploy-queue';

export const dynamic = 'force-dynamic';

/**
 * GET /api/deploy-queue: وضعیت صف دیپلوی + آمار روزانه.
 * پاسخ: { stats, items }
 */
export async function GET(): Promise<Response> {
  try {
    const [stats, items] = await Promise.all([getDeployStats(), getDeployQueue(100)]);
    return ok({ stats, items });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'failed to read deploy queue');
  }
}

/**
 * POST /api/deploy-queue: اجرای دستی پردازشگر (برای تست/عملیات).
 */
export async function POST(): Promise<Response> {
  try {
    const result = await processDeployQueue();
    return ok(result);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'failed to process deploy queue');
  }
}
