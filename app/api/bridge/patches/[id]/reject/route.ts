/**
 * POST /api/bridge/patches/[id]/reject: رد پچ با دلیل ثبت‌شده.
 *
 * احراز: فقط کلید مدیریتی (lib/manager-auth)؛ هدر Authorization: Bearer <token>.
 * رد کردن هم تصمیم مدیر است (قانون بخش ۳ docs/execution-bridge.md) و پچ ردشده
 * دیگر به چرخه برنمی‌گردد.
 *
 * ورودی: { reason } ــ دلیل رد الزامی است و در ستون rejection_reason ثبت می‌شود.
 * پس از رد، شاخهٔ پل در بهترین تلاش حذف می‌شود (خطایش مسیر را نمی‌شکند).
 */

import { fail, ok } from '../../../../../../lib/api';
import { requireManagerAuth } from '../../../../../../lib/manager-auth';
import {
  BridgeDbError,
  getBridgePatch,
  isMissingColumnError,
  updateBridgePatch,
} from '../../../../../../lib/bridge';
import { deleteBranchBestEffort } from '../../../../../../lib/bridge/merge';

function validId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

const TERMINAL = new Set(['rejected', 'merged', 'rolledback']);

interface RejectBody {
  reason?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const auth = await requireManagerAuth(request);
  if (auth instanceof Response) return auth;

  try {
    const id = params.id ?? '';
    if (!validId(id)) return fail('شناسهٔ پچ نامعتبر است.', 400);

    const body = (await request.json().catch(() => ({}))) as RejectBody;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) return fail('دلیل رد را بنویسید؛ رد بدون دلیل ثبت نمی‌شود.', 400);
    if (reason.length > 1000) return fail('دلیل رد خیلی طولانی است.', 400);

    const patch = await getBridgePatch(id);
    if (!patch) return fail('پچی با این شناسه پیدا نشد.', 404);
    if (TERMINAL.has(patch.status)) {
      return fail('این پچ قبلاً به وضعیت پایانی رسیده و قابل رد نیست.', 409);
    }

    const now = new Date().toISOString();
    let updated;
    try {
      updated = await updateBridgePatch(id, {
        status: 'rejected',
        decided_by: auth.id,
        decided_at: now,
        rejection_reason: reason,
      });
    } catch (err) {
      if (err instanceof BridgeDbError && isMissingColumnError(err)) {
        return fail(
          'ستون دلیل رد در دیتابیس نیست؛ اول مایگریشن 20261015201000_bridge_patches_rejection_reason را اعمال کنید.',
          500,
        );
      }
      throw err;
    }

    // حذف شاخهٔ پل؛ بهترین تلاش
    let branch_deleted = false;
    if (patch.branch) {
      branch_deleted = await deleteBranchBestEffort(patch.branch);
    }
    return ok({ patch: updated, branch_deleted });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'خطای نامشخص');
  }
}
