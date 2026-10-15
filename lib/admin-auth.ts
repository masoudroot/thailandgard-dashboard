/**
 * lib/admin-auth.ts: احراز هویت ادمین پنل.
 *
 * رمز از جدول settings (کلید admin_password_hash، هش SHA-256) خوانده می‌شود؛
 * اگر تنظیم نشده باشد، از متغیر محیطی ADMIN_PASSWORD استفاده می‌شود.
 * با fetch مستقیم به REST سوپابیس کار می‌کند تا در Edge middleware هم قابل استفاده باشد.
 */

/** SHA-256 hex با Web Crypto (سازگار با Edge). */
export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** خواندن هش ذخیره‌شده در settings (null اگر نباشد یا در دسترس نباشد). */
async function readStoredHash(): Promise<string | null> {
  try {
    const url = process.env.SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key) return null;
    const res = await fetch(
      `${url}/rest/v1/settings?key=eq.admin_password_hash&select=value`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ value?: unknown }>;
    const v = rows?.[0]?.value;
    return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** هش موردانتظار رمز ادمین: اول settings، بعد env. */
export async function getExpectedPasswordHash(): Promise<string> {
  const stored = await readStoredHash();
  if (stored) return stored;
  return sha256Hex(process.env.ADMIN_PASSWORD ?? 'changeme');
}

/** آیا رمز از داشبورد (settings) تعیین شده یا از env می‌آید. */
export async function isPasswordFromSettings(): Promise<boolean> {
  return (await readStoredHash()) !== null;
}
