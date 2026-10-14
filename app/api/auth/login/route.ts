import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, sessionCookieOptions, sha256 } from '@/lib/auth';

export async function POST(request: NextRequest) {
  let body: { password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'درخواست نامعتبر است.' }, { status: 400 });
  }

  const password = typeof body.password === 'string' ? body.password : '';
  if (!password) {
    return NextResponse.json({ ok: false, error: 'رمز عبور را وارد کنید.' }, { status: 400 });
  }

  const expected = sha256(process.env.ADMIN_PASSWORD ?? 'changeme');
  const provided = sha256(password);

  if (provided !== expected) {
    // Small delay to blunt rapid brute-force retries.
    await new Promise((r) => setTimeout(r, 500));
    return NextResponse.json({ ok: false, error: 'رمز عبور اشتباه است.' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, expected, sessionCookieOptions());
  return res;
}
