/**
 * GET /api/bridge/patches: فهرست پچ‌های پل اجرا.
 *
 * کوئری‌ها: status (یک یا چند وضعیت با کاما)، team.
 * اگر جدول bridge_patches هنوز ساخته نشده باشد، آرایهٔ خالی برمی‌گردد.
 * احراز: سشن ادمین داشبورد (middleware).
 */

import { fail, ok } from '../../../../lib/api';
import { listBridgePatches } from '../../../../lib/bridge';

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get('status') ?? undefined;
    const team = url.searchParams.get('team') ?? undefined;
    const patches = await listBridgePatches({ status, team });
    return ok(patches);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'خطای نامشخص');
  }
}
