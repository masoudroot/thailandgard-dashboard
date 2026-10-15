/**
 * /api/settings/admin-password: تغییر رمز ادمین پنل (هاب اتصال‌ها).
 *
 * POST { currentPassword, newPassword }: رمز فعلی بررسی می‌شود، هش SHA-256
 * رمز تازه در جدول settings (کلید admin_password_hash) ذخیره می‌شود.
 * از این پس ورود با رمز تازه انجام می‌شود؛ نشست‌های قبلی باطل می‌شوند.
 */

import { fail, ok } from '../../../../lib/api';
import { setSetting } from '../../../../lib/settings';
import { getExpectedPasswordHash, sha256Hex } from '../../../../lib/admin-auth';
import { SESSION_COOKIE, sessionCookieOptions } from '../../../../lib/auth';

/** POST /api/settings/admin-password */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

    if (!currentPassword) return fail('رمز فعلی را وارد کنید.', 400);
    if (newPassword.length < 8) return fail('رمز تازه باید حداقل ۸ کاراکتر باشد.', 400);
    if (newPassword === currentPassword) return fail('رمز تازه با رمز فعلی یکی است.', 400);

    const expected = await getExpectedPasswordHash();
    const provided = await sha256Hex(currentPassword);
    if (provided !== expected) {
      await new Promise((r) => setTimeout(r, 500));
      return fail('رمز فعلی اشتباه است.', 401);
    }

    const newHash = await sha256Hex(newPassword);
    await setSetting('admin_password_hash', newHash);

    // نشست جاری با هش تازه به‌روز می‌شود تا کاربر بیرون نیفتد
    const res = ok({ message: 'رمز ادمین تغییر کرد. از این پس با رمز تازه وارد شوید.' });
    res.cookies.set(SESSION_COOKIE, newHash, sessionCookieOptions());
    return res;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
