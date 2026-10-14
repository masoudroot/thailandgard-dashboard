import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api';
import { sendTelegram } from '@/lib/notify';

/** اندپوینت تستی ارسال اطلاع‌رسانی. بدنه: { team, message } */
export async function POST(request: NextRequest) {
  let body: { team?: unknown; message?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail('درخواست نامعتبر است.', 400);
  }

  const team = typeof body.team === 'string' ? body.team.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';

  if (!team || !message) {
    return fail('team و message هر دو لازم‌اند.', 400);
  }

  await sendTelegram(team, message);
  return ok({ sent: true, team });
}
