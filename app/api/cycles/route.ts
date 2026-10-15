import { fail, getSupabase, ok } from '../../../lib/api';
import {
  beginCycle,
  CycleLockedError,
  findActiveCycle,
  runAllWaves,
} from '../../../lib/orchestrator';

/** GET /api/cycles: فهرست چرخه‌ها (جدیدترین اول). */
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
 * POST /api/cycles: شروع چرخه‌ی جدید.
 * اگر چرخهٔ فعالی (در حال اجرا، در آستانهٔ توقف، یا متوقف‌شده) هست، 409 برمی‌گردد؛
 * اول باید همان چرخه لغو شود یا ادامه یابد. قفل ارکستراتور هم همین را تضمین می‌کند.
 * قفل و ردیف cycles هم‌زمان ساخته می‌شود و run_id برمی‌گردد (202)؛
 * اجرای موج‌ها در پس‌زمینه ادامه می‌یابد تا درخواست HTTP بلوکه نماند.
 */
export async function POST(): Promise<Response> {
  try {
    const active = await findActiveCycle();
    if (active) {
      return fail(
        `چرخهٔ فعالی در حال اجراست (وضعیت: ${active.status})؛ اول آن را لغو کنید یا ادامه دهید.`,
        409,
      );
    }
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
