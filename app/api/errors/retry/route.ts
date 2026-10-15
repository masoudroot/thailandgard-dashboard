import { fail, ok } from '../../../../lib/api';
import { retryFailedTeamRun } from '../../../../lib/retry';

/**
 * POST /api/errors/retry: تلاش مجدد واقعی روی یک ران ناموفق.
 * بدنه: { "run_id": "<uuid>" }
 * ردیف قدیمی (failed) به‌عنوان تاریخچه می‌ماند؛ ردیف تازه‌ای ساخته و تیم
 * واقعاً دوباره اجرا می‌شود. 202 + شناسه‌ی ردیف تازه برمی‌گردد.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as { run_id?: unknown } | null;
    const runId = body?.run_id;
    if (typeof runId !== 'string' || runId.length === 0) {
      return fail('run_id is required', 400);
    }
    const result = await retryFailedTeamRun(runId);
    return ok(
      {
        new_run_id: result.newRunId,
        team: result.team,
        cycle_id: result.cycleId,
        message: 'تلاش مجدد در صف اجرا قرار گرفت',
      },
      202,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('only failed runs')) return fail(message, 400);
    if (message.startsWith('team run not found')) return fail(message, 404);
    return fail(message);
  }
}
