import { fail, ok } from '../../../../lib/api';
import { getLatestRunsByTeam } from '../../../../lib/errors';
import { TEAMS, type TeamName, type TeamRun } from '../../../../lib/types';

/**
 * GET /api/teams/status : جدیدترین ران هر ۱۵ تیم از داده‌ی واقعی team_runs.
 * تیمی که هنوز هیچ رانی ندارد با وضعیت pending و فیلدهای خالی برمی‌گردد
 * (صادقانه، نه داده‌ی نمایشی).
 */
export async function GET(): Promise<Response> {
  try {
    const byTeam = await getLatestRunsByTeam();
    const runs: TeamRun[] = TEAMS.map((team: TeamName) => {
      const row = byTeam.get(team);
      if (row) {
        const { cycles, ...run } = row as TeamRun & { cycles?: unknown };
        return run;
      }
      return {
        id: `pending-${team}`,
        cycle_id: '',
        team,
        wave: 0,
        status: 'pending',
        started_at: null,
        finished_at: null,
        output_summary: null,
        llm_calls: 0,
        error: null,
        progress: 0,
        current_task: null,
        updated_at: null,
      } satisfies TeamRun;
    });
    return ok(runs);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
