import { fail, getSupabase, ok } from '../../../lib/api';
import {
  beginCycle,
  CycleLockedError,
  runAllWaves,
} from '../../../lib/orchestrator';

/** GET /api/cycles — فهرست چرخه‌ها (جدیدترین اول). */
export async function GET(): Promise<Response> {
  try {
    const { data, error } = await getSupabase()
      .from('cycles')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(50);
    if (error) return fail(`failed to list cycles: ${error.message}`);
    return ok(data ?? []);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * POST /api/cycles — شروع چرخه‌ی جدید.
 * قفل و ردیف cycles هم‌زمان ساخته می‌شود و run_id برمی‌گردد (202)؛
 * اجرای موج‌ها در پس‌زمینه ادامه می‌یابد تا درخواست HTTP بلوکه نماند.
 * اگر چرخه‌ای در حال اجراست (قفل running و تازه)، 409 برمی‌گردد.
 */
export async function POST(): Promise<Response> {
  try {
    const { cycleId, runId } = await beginCycle();
    // fire-and-forget: موج‌ها در پس‌زمینه اجرا می‌شوند؛ خطا در لاگ می‌ماند
    // و finishCycle وضعیت cycles را به‌روز می‌کند.
    void runAllWaves(cycleId, runId).catch((err) => {
      console.error(`[api/cycles] background cycle ${runId} crashed:`, err);
    });
    return ok({ run_id: runId, cycle_id: cycleId }, 202);
  } catch (err) {
    if (err instanceof CycleLockedError) return fail(err.message, 409);
    return fail(err instanceof Error ? err.message : String(err));
  }
}
