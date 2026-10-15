import { fail, getSupabase, ok } from '../../../../lib/api';
import {
  cancelCycle,
  requestPause,
  resumeCycle,
} from '../../../../lib/orchestrator';

/** GET /api/cycles/[id]: جزئیات یک چرخه + همه‌ی team_runs آن. */
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


/**
 * PATCH /api/cycles/[id]: کنترل چرخه: توقف نرم، ادامه، لغو.
 * بدنه: { "action": "pause" | "resume" | "cancel" }
 *
 *  - pause: running -> pausing؛ حلقه‌ی اجرا بین موج‌ها این را می‌بیند،
 *    موج جاری را تا انتها می‌دوند و بعد paused می‌شود.
 *  - resume: paused -> running؛ از همان موجِ ناتمام ادامه می‌یابد
 *    (حتی اگر سرور ری‌استارت شده باشد).
 *  - cancel: فعال -> canceled؛ حلقه‌ی اجرا در اولین ایست‌بازرسی می‌ایستد.
 *
 * گذار نامعتبر => 409 با پیام فارسی.
 */
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    switch (body.action) {
      case 'pause':
        await requestPause(params.id);
        break;
      case 'resume':
        await resumeCycle(params.id);
        break;
      case 'cancel':
        await cancelCycle(params.id);
        break;
      default:
        return fail('عمل نامعتبر است؛ یکی از pause، resume یا cancel.', 400);
    }
    return ok({ action: body.action });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = /فقط چرخه|این چرخه|چرخه پیدا|برای ادامه/.test(message) ? 409 : 500;
    return fail(message, code);
  }
}
