import { NextRequest, NextResponse } from 'next/server';
import { getExpectedPasswordHash } from './lib/admin-auth';

export const SESSION_COOKIE = 'tg-admin';

const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/login', '/login', '/favicon.ico']);

/** مسیرهایی که کرون زمان‌بندی‌شده با هدر مخفی هم می‌تواند صدا بزند. */
const CRON_PATHS = new Set(['/api/rates/fetch']);

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  // احراز کرون: هدر مخفیِ ست‌شده در متغیر محیطی RATES_CRON_SECRET
  if (CRON_PATHS.has(pathname)) {
    const cronSecret = process.env.RATES_CRON_SECRET;
    const provided = request.headers.get('x-cron-secret');
    if (cronSecret && provided && provided.length === cronSecret.length && provided === cronSecret) {
      return NextResponse.next();
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
