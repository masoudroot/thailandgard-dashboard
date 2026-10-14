import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from './lib/auth';

const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/login', '/login', '/favicon.ico']);

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  const protectedApi = pathname.startsWith('/api/');
  const protectedDashboard = pathname.startsWith('/dashboard');

  if (protectedApi || protectedDashboard) {
    if (isAuthenticated(request)) {
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
