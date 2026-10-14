import { fail, getSupabase, ok } from '../../../../lib/api';

/** GET /api/cycles/[id] — جزئیات یک چرخه + همه‌ی team_runs آن. */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  try {
    const sb = getSupabase();
    const { data: cycle, error: cycleErr } = await sb
      .from('cycles')
      .select('*')
      .eq('id', params.id)
      .maybeSingle();
    if (cycleErr) return fail(`failed to load cycle: ${cycleErr.message}`);
    if (!cycle) return fail('cycle not found', 404);

    const { data: teamRuns, error: runsErr } = await sb
      .from('team_runs')
      .select('*')
      .eq('cycle_id', params.id)
      .order('wave', { ascending: true })
      .order('team', { ascending: true });
    if (runsErr) return fail(`failed to load team runs: ${runsErr.message}`);

    return ok({ cycle, team_runs: teamRuns ?? [] });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
