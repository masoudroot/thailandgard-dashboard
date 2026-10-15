/**
 * GET /api/settings/backup: خروجی JSON از همه تنظیمات (برای بک‌آپ).
 * POST /api/settings/backup: بازگردانی تنظیمات از فایل آپلودشده.
 *
 * کلیدهای حساس (توکن‌ها، کلیدهای API، هش رمز) به‌صورت پیش‌فرض صادر نمی‌شوند؛
 * با پارامتر includeSecrets=true صادر می‌شوند.
 */

import { fail, ok, getSupabase } from '../../../../lib/api';
import { setSetting } from '../../../../lib/settings';

/** کلیدهایی که مقدار حساس دارند */
const SECRET_KEYS = new Set([
  'llm_endpoints', // شامل کلیدهای API درگاه‌ها
  'telegram',
  'telegram_bot',
  'github',
  'github_token',
  'admin_password',
  'admin_password_hash',
]);

const BACKUP_VERSION = 1;

export async function GET(request: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const includeSecrets = searchParams.get('includeSecrets') === 'true';
    const { data, error } = await getSupabase().from('settings').select('key, value');
    if (error) return fail(`خواندن تنظیمات ناموفق بود: ${error.message}`);
    const settings: Record<string, unknown> = {};
    for (const row of data ?? []) {
      const key = row.key as string;
      if (!includeSecrets && SECRET_KEYS.has(key)) continue;
      settings[key] = row.value;
    }
    return ok({
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      includeSecrets,
      settings,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => ({}));
    const b = (body ?? {}) as Record<string, unknown>;
    const settings = b.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return fail('فایل بک‌آپ معتبر نیست.', 400);
    }
    const entries = Object.entries(settings as Record<string, unknown>);
    if (entries.length === 0) return fail('فایل بک‌آپ خالی است.', 400);
    if (entries.length > 100) return fail('فایل بک‌آپ بیش از حد بزرگ است.', 400);
    let restored = 0;
    for (const [key, value] of entries) {
      if (typeof key !== 'string' || key.length === 0 || key.length > 100) continue;
      if (!/^[a-zA-Z0-9_:.-]+$/.test(key)) continue;
      await setSetting(key, value);
      restored++;
    }
    return ok({ restored });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
