import { fail, getSupabase, ok } from '@/lib/api';
import { TEAMS, WAVES, type TeamName } from '@/lib/types';
import { TEAM_META } from '@/lib/team-meta';
import { fetchTeamRuns, toQueryResult } from '@/lib/live-data';

/**
 * GET /api/teams/[team] : جزئیات یک تیم: فراداده، ۲۰ اجرای اخیر (گزارش‌ها)
 * و ۱۰ اطلاع‌رسانی دوگانه‌ی اخیر (ثبت پنل).
 * همه از داده‌ی واقعی team_runs و notifications.
 */
export async function GET(
  _request: Request,
  { params }: { params: { team: string } },
): Promise<Response> {
  const team = params.team as TeamName;
  if (!TEAMS.includes(team)) {
    return fail('تیم نامعتبر است.', 400);
  }

  let sb;
  try {
    sb = getSupabase();
  } catch {
    return fail('اتصال به دیتابیس برقرار نیست.', 503);
  }

  try {
    const wave = WAVES.find((w) => w.teams.includes(team))?.wave ?? null;

    const { data: runs, liveColumns } = await fetchTeamRuns(sb, async (cols) =>
      toQueryResult(
        await sb
          .from('team_runs')
          .select(cols)
          .eq('team', team)
          .order('started_at', { ascending: false })
          .limit(20),
      ),
    );

    const { data: notices, error: noticesErr } = await sb
      .from('notifications')
      .select('id, cycle_id, team, message, channel, sent_at, telegram_message_id, status')
      .eq('team', team)
      .order('sent_at', { ascending: false })
      .limit(10);
    if (noticesErr) return fail(`خطا در خواندن اطلاع‌رسانی‌ها: ${noticesErr.message}`);

    return ok({
      team,
      faName: TEAM_META[team].faName,
      mission: TEAM_META[team].mission,
      wave,
      runs,
      notifications: notices ?? [],
      liveColumns,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'خطای ناشناخته.');
  }
}
