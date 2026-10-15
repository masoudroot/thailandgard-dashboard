import { fail, getSupabase, ok } from '../../../../lib/api';

/**
 * GET /api/cycles/latest: جدیدترین چرخه به‌همراه ران‌های تیم‌هایش،
 * مستقیم از team_runs (داده‌ی واقعی؛ بدون چرخه = آرایه‌ی خالی).
 */
export async function GET(): Promise<Response> {
  try {
    const sb = getSupabase();
    const { data: cycle, error: cycleErr } = await sb
      .from('cycles')
      .select('id')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (cycleErr) return fail(`failed to read latest cycle: ${cycleErr.message}`);
    if (!cycle) return ok([]);
    const { data: runs, error: runsErr } = await sb
      .from('team_runs')
      .select('*')
      .eq('cycle_id', (cycle as { id: string }).id)
      .order('wave', { ascending: true });
    if (runsErr) return fail(`failed to read cycle runs: ${runsErr.message}`);
    return ok(runs ?? []);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
