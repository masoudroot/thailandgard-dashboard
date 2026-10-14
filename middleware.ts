import { NextRequest, NextResponse } from 'next/server';

export const SESSION_COOKIE = 'tg-admin';

/** SHA-256 hex digest using Web Crypto (Edge-compatible). */
async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/login', '/login', '/favicon.ico']);

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  const protectedApi = pathname.startsWith('/api/');
  const protectedDashboard = pathname.startsWith('/dashboard');

  if (protectedApi || protectedDashboard) {
    const session = request.cookies.get(SESSION_COOKIE)?.value;
    const expected = await sha256Hex(process.env.ADMIN_PASSWORD ?? 'changeme');
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
