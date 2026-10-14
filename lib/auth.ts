import { createHash, timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';

export const SESSION_COOKIE = 'tg-admin';

/** SHA-256 hex digest of a value. */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Compare the `tg-admin` session cookie against the SHA-256 of ADMIN_PASSWORD.
 * Uses timing-safe comparison on equal-length hex digests.
 */
export function isAuthenticated(request: NextRequest): boolean {
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  if (!session) return false;
  const expected = sha256(process.env.ADMIN_PASSWORD ?? 'changeme');
  if (session.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(session, 'utf8'), Buffer.from(expected, 'utf8'));
}

/** Cookie options shared by login (set) and logout (clear). */
export function sessionCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7, // 7 days
  };
}
