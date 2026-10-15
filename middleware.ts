import { NextRequest, NextResponse } from 'next/server';
import { getExpectedPasswordHash } from './lib/admin-auth';

export const SESSION_COOKIE = 'tg-admin';

const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/login', '/login', '/favicon.ico']);

/** خواندن سکرت کرون نرخ‌ها از جدول settings (null اگر نباشد). */
async function readRatesCronSecret(): Promise<string | null> {
  try {
    const url = process.env.SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key) return null;
    const res = await fetch(
      `${url}/rest/v1/settings?key=eq.rates_cron_secret&select=value`,
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
    return typeof v === 'string' && v.length >= 16 ? v : null;
  } catch {
    return null;
  }
}

/** مسیرهایی که کرون زمان‌بندی‌شده با هدر مخفی هم می‌تواند صدا بزند. */
const CRON_PATHS = new Set(['/api/rates/fetch']);

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  // احراز کرون: هدر مخفیِ ست‌شده در متغیر محیطی RATES_CRON_SECRET
  // یا کلید rates_cron_secret در جدول settings
  if (CRON_PATHS.has(pathname)) {
    const provided = request.headers.get('x-cron-secret');
    if (provided) {
      const envSecret = process.env.RATES_CRON_SECRET;
      if (envSecret && provided.length === envSecret.length && provided === envSecret) {
        return NextResponse.next();
      }
      const storedSecret = await readRatesCronSecret();
      if (storedSecret && provided.length === storedSecret.length && provided === storedSecret) {
        return NextResponse.next();
      }
    }
  }

  const protectedApi = pathname.startsWith('/api/');
  const protectedDashboard = pathname.startsWith('/dashboard');

  if (protectedApi || protectedDashboard) {
    const session = request.cookies.get(SESSION_COOKIE)?.value;
    const expected = await getExpectedPasswordHash();
    const authed = !!session && session.length === expected.length && session === expected;

    if (authed) {
      return NextResponse.next();
    }
    if (protectedApi) {
      return NextResponse.json({ ok: false, error: 'احراز هویت لازم است.' }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/api/:path*', '/login'],
};
