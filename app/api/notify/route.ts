import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api';
import { notifyTeamReport } from '@/lib/notify';

/** اندپوینت ارسال اطلاع‌رسانی دوگانه (پنل + تلگرام). بدنه: { team, message, cycle_id? } */
export async function POST(request: NextRequest) {
  let body: { team?: unknown; message?: unknown; cycle_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail('درخواست نامعتبر است.', 400);
  }

  const team = typeof body.team === 'string' ? body.team.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const cycleId = typeof body.cycle_id === 'string' ? body.cycle_id : undefined;

  if (!team || !message) {
    return fail('team و message هر دو لازم‌اند.', 400);
  }

  const result = await notifyTeamReport({ team, message, cycleId });
  return ok({ sent: true, team, panel_id: result.panelId, telegram_message_id: result.telegramMessageId });
}
