import { NextRequest } from 'next/server';
import { ok, fail, getSupabase } from '../../../lib/api';
import { generateGoals, buildPhases } from '../../../lib/planning';
import type { TeamResult, TeamRun } from '../../../lib/types';

/** Normalizes a team_runs row into the domain TeamResult shape. */
function toTeamResult(row: TeamRun): TeamResult {
  let tasks: TeamResult['tasks'] = [];
  if (row.output_summary) {
    try {
      const parsed = JSON.parse(row.output_summary) as { tasks?: unknown };
      if (Array.isArray(parsed?.tasks)) {
        tasks = parsed.tasks.filter(
          (t): t is TeamResult['tasks'][number] =>
            typeof t === 'object' &&
            t !== null &&
            typeof (t as { title?: unknown }).title === 'string',
        );
      }
    } catch {
      // output_summary is plain text; tasks stay empty.
    }
  }
  return {
    team: row.team,
    summary: row.output_summary ?? '',
    blockers: row.error ? [row.error] : [],
    tasks,
    approved: row.status === 'success',
  };
}

/**
 * POST /api/planning (generates goals and phases for a cycle and enqueues
 * the phase tasks into `build_queue` with status=pending.
 * Body: { cycleId: string }
 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as { cycleId?: unknown } | null;
    const cycleId = body?.cycleId;
    if (!cycleId || typeof cycleId !== 'string') {
      return fail('Field "cycleId" is required.', 400);
    }

    const db = getSupabase();

    const { data: cycle, error: cycleError } = await db
      .from('cycles')
      .select('id')
      .eq('id', cycleId)
      .maybeSingle();

    if (cycleError) throw new Error(`Failed to load cycle: ${cycleError.message}`);
    if (!cycle) return fail(`Cycle not found: ${cycleId}`, 404);

    const { data: runs, error: runsError } = await db
      .from('team_runs')
      .select('*')
      .eq('cycle_id', cycleId);

    if (runsError) throw new Error(`Failed to load team runs: ${runsError.message}`);

    const teamResults = ((runs ?? []) as TeamRun[]).map(toTeamResult);

    const goals = await generateGoals(teamResults);
    const phases = await buildPhases(goals, teamResults);

    let inserted = 0;
    for (const phase of phases) {
      for (let i = 0; i < phase.tasks.length; i += 1) {
        const task = phase.tasks[i];
        const { error } = await db.from('build_queue').insert({
          team: 'planner',
          run_id: cycleId,
          title: task.title,
          description: task.description,
          files_hint: task.files_hint ? [task.files_hint] : [],
          priority: task.priority,
          status: 'pending',
          phase: phase.title,
          phase_order: i,
        });
        if (error) throw new Error(`Failed to enqueue task: ${error.message}`);
        inserted += 1;
      }
    }

    return ok({ cycleId, goals, phases, inserted }, 201);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Unknown error', 500);
  }
}
