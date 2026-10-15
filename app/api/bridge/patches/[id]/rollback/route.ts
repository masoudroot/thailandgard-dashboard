/**
 * POST /api/bridge/patches/[id]/rollback: رول‌بک پچ مرج‌شده‌ی پل اجرا.
 *
 * احراز: مدیر داشبورد (هدر Authorization: Bearer <token>).
 * بدنه: { reason: string }؛ دلیل رول‌بک اجباری است و در پیام کامیت revert ثبت می‌شود.
 *
 * فقط پچ‌های «merged» رول‌بک می‌شوند؛ بقیه‌ی وضعیت‌ها خطای فارسی می‌گیرند.
 * رول‌بک همیشه با یک کامیت revert تازه روی dev است؛ بدون force-push و بدون حذف تاریخچه.
 */

import { fail, ok } from '../../../../../../lib/api';
import { requireManagerAuth } from '../../../../../../lib/manager-auth';
import { rollbackPatch } from '../../../../../../lib/bridge/rollback';

export const dynamic = 'force-dynamic';

interface RollbackBody {
  reason?: unknown;
}

/** POST /api/bridge/patches/[id]/rollback */
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const auth = await requireManagerAuth(request);
  if (auth instanceof Response) return auth;

  let body: RollbackBody = {};
  try {
    body = (await request.json()) as RollbackBody;
  } catch {
    // بدنه‌ی خالی یا نامعتبر؛ پایین‌تر خطای دلیل می‌گیرد
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    return fail('دلیل رول‌بک لازم است؛ بدون دلیل، رول‌بک انجام نمی‌شود.', 400);
  }

  try {
    const { sha } = await rollbackPatch(params.id, { reason, decidedBy: auth.name });
    return ok({ id: params.id, status: 'rolledback', sha, reason });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'خطای نامشخص در رول‌بک پچ';
    if (message.includes('پیدا نشد')) return fail(message, 404);
    if (message.includes('فقط برای پچ‌های')) return fail(message, 409);
    return fail(message, 500);
  }
}
