/**
 * POST /api/manager/cycle/start: شروع چرخه‌ی جدید از طریق API مدیر.
 * احراز: Bearer token مدیر. منطق دقیقاً همان /api/cycles است.
 */
import { fail, ok } from '../../../../../lib/api';
import { requireManagerAuth } from '../../../../../lib/manager-auth';
import {
  beginCycle,
  CycleLockedError,
  findActiveCycle,
  runAllWaves,
} from '../../../../../lib/orchestrator';

export async function POST(request: Request): Promise<Response> {
  const auth = await requireManagerAuth(request);
  if (auth instanceof Response) return auth;
  try {
    const active = await findActiveCycle();
    if (active) {
      return fail(
        `چرخهٔ فعالی در حال اجراست (وضعیت: ${active.status})؛ اول آن را لغو کنید یا ادامه دهید.`,
        409,
      );
    }
    const { cycleId, runId } = await beginCycle();
    void runAllWaves(cycleId, runId).catch((err) => {
      console.error(`[api/manager/cycle/start] background cycle ${runId} crashed:`, err);
    });
    return ok({ run_id: runId, cycle_id: cycleId }, 202);
  } catch (err) {
    if (err instanceof CycleLockedError) return fail(err.message, 409);
    return fail(err instanceof Error ? err.message : String(err));
  }
}
