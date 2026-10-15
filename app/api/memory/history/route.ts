import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api';
import { readMemoryHistory } from '@/lib/memory';

/**
 * GET /api/memory/history?team=<team>&key=<key> : تاریخچه‌ی کامل یک رکورد
 * (جدیدترین اول، حداکثر ۵۰ نسخه).
 */
export async function GET(request: NextRequest) {
  const team = request.nextUrl.searchParams.get('team')?.trim() ?? '';
  const key = request.nextUrl.searchParams.get('key')?.trim() ?? '';

  if (!team || !key) {
    return fail('پارامترهای team و key لازم‌اند.', 400);
  }

  try {
    return ok(await readMemoryHistory(team, key));
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'خطای خواندن تاریخچه.');
  }
}
