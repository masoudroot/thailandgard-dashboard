import { fail, getSupabase, ok } from '../../../lib/api';
import { ACTIVE_CYCLE_STATUSES } from '../../../lib/types';
import { fetchSubagents, fetchTeamRuns, toQueryResult } from '../../../lib/live-data';

/**
 * GET /api/live : تصویر زنده‌ی چرخه‌ی فعال برای صفحه‌ی «فعالیت زنده».
 *
 * برمی‌گرداند:
 *   cycle:          جدیدترین چرخه‌ی فعال (running/pausing/paused) یا null
 *   runs:           ردیف‌های team_runs همان چرخه (با progress/current_task/updated_at)
 *   subagents:      ساب‌ایجنت‌های (مرحله‌های) همان چرخه برای کنترل زنده
 *   liveColumns:    آیا ستون‌های زنده‌ی team_runs واقعاً خوانده شدند
 *   subagentsReady: آیا جدول subagents وجود دارد
 *
 * اگر مایگریشن‌های زنده هنوز اجرا نشده باشند، به‌جای خطا، داده‌ی پایه
 * با پرچم‌های false برمی‌گردد تا رابط «هنوز فعال نیست» صادقانه نشان بدهد.
 * اگر چرخه‌ی فعالی نباشد: { cycle: null, runs: [], subagents: [], ... }.
 * اگر سوپابیس در دسترس نباشد: ۵۰۳ با پیام فارسی تا صفحه «متصل نیست» نشان بدهد.
 */
export async function GET(): Promise<Response> {
  let sb;
  try {
    sb = getSupabase();
  } catch {
    return fail('اتصال به دیتابیس برقرار نیست. متغیرهای SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY را بررسی کنید.', 503);
  }

  try {
    const { data: cycle, error: cycleErr } = await sb
      .from('cycles')
      .select('id, run_id, status, started_at')
      .in('status', ACTIVE_CYCLE_STATUSES)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (cycleErr) return fail(`خطا در خواندن چرخه: ${cycleErr.message}`);

    if (!cycle) {
      return ok({ cycle: null, runs: [], subagents: [], liveColumns: true, subagentsReady: true });
    }

    const cycleId = (cycle as { id: string }).id;
    const { data: runs, liveColumns } = await fetchTeamRuns(sb, async (cols) =>
      toQueryResult(
        await sb
          .from('team_runs')
          .select(cols)
          .eq('cycle_id', cycleId)
          .order('wave', { ascending: true })
          .order('started_at', { ascending: true }),
      ),
    );

    const runIds = runs.map((r) => r.id as string);
    const { data: subagents, tableReady: subagentsReady } = await fetchSubagents(sb, runIds);

    return ok({ cycle, runs, subagents, liveColumns, subagentsReady });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'خطای ناشناخته در خواندن وضعیت زنده.');
  }
}
