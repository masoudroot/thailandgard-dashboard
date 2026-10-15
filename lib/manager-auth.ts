/**
 * lib/manager-auth.ts: احراز هویت API مدیریتی («مدیر داشبورد»).
 *
 * کلیدها در جدول manager_api_keys فقط به‌صورت هش SHA-256 ذخیره می‌شوند؛
 * توکن خام هیچ‌جا ذخیره نمی‌شود. هر درخواست باید هدر زیر را داشته باشد:
 *   Authorization: Bearer <token>
 *
 * توکن نامعتبر یا لغوشده → خطای ۴۰۱ فارسی.
 * در هر احراز موفق، last_used_at به‌روز می‌شود.
 */

import { getSupabase } from './api';
import { sha256Hex } from './admin-auth';
import { fail } from './api';

export interface ManagerKey {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  revoked: boolean;
}

/** استخراج توکن از هدر Authorization. */
export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim() ?? '';
  return token.length >= 16 ? token : null;
}

/**
 * بررسی توکن مدیریتی. در صورت معتبر بودن، اطلاعات کلید را برمی‌گرداند
 * و last_used_at را به‌روز می‌کند. در غیر این صورت null.
 */
export async function verifyManagerToken(token: string): Promise<ManagerKey | null> {
  try {
    const tokenHash = await sha256Hex(token);
    const sb = getSupabase();
    const { data, error } = await sb
      .from('manager_api_keys')
      .select('id, name, created_at, last_used_at, revoked')
      .eq('token_hash', tokenHash)
      .eq('revoked', false)
      .maybeSingle();
    if (error || !data) return null;
    // به‌روزرسانی آخرین استفاده (خطایش مهم نیست)
    try {
      await sb
        .from('manager_api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', (data as ManagerKey).id);
    } catch {
      /* نادیده */
    }
    return data as ManagerKey;
  } catch {
    return null;
  }
}

/**
 * گارد احراز برای روت‌های /api/manager/*.
 * در صورت نامعتبر بودن توکن، پاسخ ۴۰۱ فارسی برمی‌گرداند.
 * استفاده:
 *   const key = await requireManagerAuth(request);
 *   if (key instanceof Response) return key;
 */
export async function requireManagerAuth(request: Request): Promise<ManagerKey | Response> {
  const token = extractBearerToken(request);
  if (!token) {
    return fail('کلید API مدیریتی لازم است. هدر Authorization: Bearer <token> را بفرستید.', 401);
  }
  const key = await verifyManagerToken(token);
  if (!key) {
    return fail('کلید API نامعتبر است یا لغو شده.', 401);
  }
  return key;
}

/** تولید توکن امن ۴۸ کاراکتری (فقط حروف و اعداد). */
export function generateManagerToken(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
