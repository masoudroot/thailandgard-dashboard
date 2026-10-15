/**
 * /api/manager/keys: مدیریت کلیدهای API مدیر داشبورد.
 *
 * این روت‌ها با سشن ادمین (کوکی) محافظت می‌شوند، نه با توکن مدیریتی؛
 * از همین پنل تنظیمات صدا زده می‌شوند.
 *
 * GET: فهرست کلیدها (نام، تاریخ ساخت، آخرین استفاده، وضعیت لغو)
 * POST { name }: ساخت کلید تازه؛ توکن خام فقط در همین پاسخ برمی‌گردد
 */

import { fail, getSupabase, ok } from '../../../../lib/api';
import { sha256Hex } from '../../../../lib/admin-auth';
import { generateManagerToken, type ManagerKey } from '../../../../lib/manager-auth';

/** GET /api/manager/keys: فهرست کلیدها */
export async function GET(): Promise<Response> {
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('manager_api_keys')
      .select('id, name, created_at, last_used_at, revoked')
      .order('created_at', { ascending: false });
    if (error) return fail(`خواندن کلیدها ناموفق بود: ${error.message}`);
    return ok((data ?? []) as ManagerKey[]);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'خطای نامشخص');
  }
}

interface CreateBody {
  name?: unknown;
}

/** POST /api/manager/keys: ساخت کلید تازه */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => ({}))) as CreateBody;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return fail('نام کلید را وارد کنید.', 400);
    if (name.length > 80) return fail('نام کلید خیلی طولانی است.', 400);

    const token = generateManagerToken();
    const tokenHash = await sha256Hex(token);
    const sb = getSupabase();
    const { data, error } = await sb
      .from('manager_api_keys')
      .insert({ name, token_hash: tokenHash })
      .select('id, name, created_at')
      .single();
    if (error) return fail(`ساخت کلید ناموفق بود: ${error.message}`);

    // توکن خام فقط همین یک بار دیده می‌شود؛ هیچ‌جا ذخیره نمی‌شود.
    return ok({ key: data, token });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'خطای نامشخص');
  }
}
