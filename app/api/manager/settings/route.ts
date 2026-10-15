/**
 * /api/manager/settings: خواندن و به‌روزرسانی تنظیمات برای «مدیر داشبورد».
 *
 * احراز: هدر Authorization: Bearer <token>
 *
 * GET: همه تنظیمات؛ مقادیر حساس (کلیدها/توکن‌ها) ماسک‌شده برمی‌گردند.
 * PATCH { key, value }: به‌روزرسانی یک تنظیم با همان اعتبارسنجی API عادی.
 *   کلیدهای حساس فقط از طریق همین روت قابل خواندن ماسک‌شده‌اند؛
 *   مقدار خام هیچ‌وقت در پاسخ برنمی‌گردد.
 */

import { fail, getSupabase, ok } from '../../../../lib/api';
import { requireManagerAuth } from '../../../../lib/manager-auth';
import { getSetting, setSetting } from '../../../../lib/settings';

/** کلیدهایی که مقدارشان حساس است و باید ماسک شوند. */
const SENSITIVE_KEYS = new Set([
  'telegram_bot_token',
  'github_token',
  'admin_password_hash',
  'navasan_api_key',
]);

function maskValue(key: string, value: unknown): unknown {
  if (!SENSITIVE_KEYS.has(key)) return value;
  if (typeof value !== 'string' || !value) return value;
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

/** GET /api/manager/settings: همه تنظیمات (حساس‌ها ماسک‌شده) */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireManagerAuth(request);
  if (auth instanceof Response) return auth;

  try {
    const sb = getSupabase();
    const { data, error } = await sb.from('settings').select('key, value, updated_at');
    if (error) return fail(`خواندن تنظیمات ناموفق بود: ${error.message}`);
    const masked = (data ?? []).map((row: { key: string; value: unknown; updated_at: string }) => ({
      key: row.key,
      value: maskValue(row.key, row.value),
      updated_at: row.updated_at,
    }));
    return ok(masked);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'خطای نامشخص');
  }
}

interface PatchBody {
  key?: unknown;
  value?: unknown;
}

/**
 * PATCH /api/manager/settings: به‌روزرسانی یک تنظیم.
 * کلیدهای مدیریتی خود API (manager_*) از این مسیر قابل تغییر نیستند.
 */
export async function PATCH(request: Request): Promise<Response> {
  const auth = await requireManagerAuth(request);
  if (auth instanceof Response) return auth;

  try {
    const body = (await request.json().catch(() => ({}))) as PatchBody;
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!key) return fail('کلید تنظیم لازم است.', 400);
    if (key.startsWith('manager_')) {
      return fail('تنظیمات مدیریتی از این مسیر قابل تغییر نیست.', 403);
    }
    await setSetting(key, body.value ?? null);
    return ok({ key, updated: true });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'خطای نامشخص');
  }
}
