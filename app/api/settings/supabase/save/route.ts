/**
 * POST /api/settings/supabase/save: ذخیره اتصال سوپابیس.
 *
 * ورودی: { url, anonKey, serviceKey }
 *
 * دو مسیر دارد:
 * ۱. اگر توکن ورسل روی سرور ست باشد (VERCEL_API_TOKEN)، متغیرهای محیطی
 *    را مستقیم در ورسل می‌نویسد و پاسخ { saved: 'vercel' } می‌دهد.
 * ۲. اگر توکن نباشد، پاسخ { needsManual: true, steps } می‌دهد تا رابط
 *    دکمه‌های «کپی» و راهنمای دستی نشان دهد.
 *
 * کلیدها هیچ‌وقت در پاسخ کامل برنمی‌گردند.
 */

import { fail, ok } from '../../../../../lib/api';

type SaveBody = {
  url?: unknown;
  anonKey?: unknown;
  serviceKey?: unknown;
};

function isNonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

const VAR_NAMES = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const;

/** ست کردن متغیرها در ورسل با API. */
async function saveToVercel(
  token: string,
  vars: Record<string, string>,
): Promise<{ ok: boolean; message: string }> {
  const projectId = process.env.VERCEL_PROJECT_ID || 'thailandgard-dashboard';
  const teamId = process.env.VERCEL_TEAM_ID || null;

  for (const [key, value] of Object.entries(vars)) {
    const qs = new URLSearchParams({ upsert: 'true' });
    if (teamId) qs.set('teamId', teamId);
    const res = await fetch(
      `https://api.vercel.com/v10/projects/${encodeURIComponent(projectId)}/env?${qs.toString()}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          key,
          value,
          type: 'encrypted',
          target: ['production', 'preview', 'development'],
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, message: `خطا در ذخیره ${key} در ورسل (${res.status}). ${text.slice(0, 120)}` };
    }
  }
  return { ok: true, message: 'متغیرها در ورسل ذخیره شدند. برای اعمال، یک دیپلوی تازه بگیرید.' };
}

/** POST /api/settings/supabase/save */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as SaveBody;
    if (!isNonEmpty(body.url) || !isNonEmpty(body.serviceKey)) {
      return fail('آدرس پروژه و کلید service_role لازم است.', 400);
    }

    const url = body.url.trim();
    const serviceKey = body.serviceKey.trim();
    const anonKey = isNonEmpty(body.anonKey) ? body.anonKey.trim() : '';

    try {
      new URL(url);
    } catch {
      return fail('آدرس پروژه معتبر نیست.', 400);
    }

    const token = process.env.VERCEL_API_TOKEN?.trim() || null;
    if (token) {
      const vars: Record<string, string> = {
        SUPABASE_URL: url,
        SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      };
      if (anonKey) vars['NEXT_PUBLIC_SUPABASE_ANON_KEY'] = anonKey;
      const result = await saveToVercel(token, vars);
      if (!result.ok) {
        return ok({ saved: false, needsManual: true, message: result.message, varNames: [...VAR_NAMES] });
      }
      return ok({ saved: true, savedVia: 'vercel', message: result.message });
    }

    // توکن ورسل نیست: راهنمای دستی برمی‌گردانیم (بدون خود مقادیر)
    return ok({
      saved: false,
      needsManual: true,
      varNames: [...VAR_NAMES],
      message: 'توکن ورسل روی سرور تنظیم نیست؛ مقادیر را دستی در ورسل وارد کنید.',
      steps: [
        'در داشبورد ورسل، پروژه و بخش Settings و سپس Environment Variables را باز کنید.',
        'سه متغیر را اضافه کنید و بعد یک دیپلوی تازه (Redeploy) بگیرید تا اعمال شود.',
      ],
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
