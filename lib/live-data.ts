import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * خوانش مقاوم team_runs برای صفحه‌های زنده.
 *
 * ستون‌های زنده (progress/current_task/updated_at) با مایگریشن
 * 20261015074440_team_runs_live.sql اضافه می‌شوند. اگر آن مایگریشن هنوز
 * روی دیتابیس اجرا نشده باشد، PostgREST خطای «ستون وجود ندارد» می‌دهد؛
 * این توابع در آن حالت به‌جای ۵۰۰، صادقانه با ستون‌های پایه برمی‌گردند
 * و پرچم liveColumns=false را بالا می‌برند تا رابط، وضعیت «هنوز فعال نیست»
 * را به‌جای صفر نمایشی نشان بدهد. هیچ داده‌ی نمایشی ساخته نمی‌شود.
 */

export const TEAM_RUNS_FULL_COLS =
  'id, cycle_id, team, wave, status, started_at, finished_at, output_summary, llm_calls, error, progress, current_task, updated_at';

export const TEAM_RUNS_BASE_COLS =
  'id, cycle_id, team, wave, status, started_at, finished_at, output_summary, llm_calls, error';

export const SUBAGENT_COLS =
  'id, team_run_id, team, label, status, control, current_task, progress, started_at, finished_at, updated_at';

type QueryResult = {
  data: Record<string, unknown>[];
  error: { message: string; code?: string } | null;
};

/**
 * نرمال‌سازی خروجی PostgREST به شکل ساده؛ برای دور زدن ناسازگاری تایپ
 * بیلدرها (GenericStringError) با تایپ ساده‌ی داخلی.
 */
export function toQueryResult(res: {
  data: unknown;
  error: { message: string; code?: string } | null;
}): QueryResult {
  return {
    data: Array.isArray(res.data) ? (res.data as Record<string, unknown>[]) : [],
    error: res.error ? { message: res.error.message, code: res.error.code } : null,
  };
}

function isMissingColumn(err: { message: string; code?: string } | null): boolean {
  if (!err) return false;
  const text = `${err.code ?? ''} ${err.message}`.toLowerCase();
  return (
    err.code === '42703' ||
    text.includes('does not exist') ||
    text.includes('column') && text.includes('not exist')
  );
}

export interface TeamRunsResult {
  data: Record<string, unknown>[];
  /** true یعنی ستون‌های زنده (پیشرفت/کار جاری/آخرین به‌روزرسانی) واقعاً خوانده شدند. */
  liveColumns: boolean;
}

/**
 * اجرای یک کوئری team_runs با ستون‌های دلخواه؛ اگر ستون‌های زنده نباشند،
 * یک‌بار با ستون‌های پایه تلاش می‌کند. خطای واقعی (غیر از ستون ناموجود)
 * را throw می‌کند.
 */
export async function fetchTeamRuns(
  sb: SupabaseClient,
  query: (cols: string) => Promise<QueryResult>,
): Promise<TeamRunsResult> {
  const first = await query(TEAM_RUNS_FULL_COLS);
  if (!first.error) {
    return { data: first.data, liveColumns: true };
  }
  if (isMissingColumn(first.error)) {
    const fallback = await query(TEAM_RUNS_BASE_COLS);
    if (fallback.error) {
      throw new Error(`خطا در خواندن اجراهای تیم‌ها: ${fallback.error.message}`);
    }
    return { data: fallback.data, liveColumns: false };
  }
  throw new Error(`خطا در خواندن اجراهای تیم‌ها: ${first.error.message}`);
}

export interface SubagentsResult {
  data: Record<string, unknown>[];
  /** true یعنی جدول subagents وجود دارد و واقعاً خوانده شد. */
  tableReady: boolean;
}

/** خوانش ساب‌ایجنت‌ها؛ اگر جدول هنوز ساخته نشده، خالی صادقانه + پرچم false. */
export async function fetchSubagents(
  sb: SupabaseClient,
  runIds: string[],
): Promise<SubagentsResult> {
  if (runIds.length === 0) return { data: [], tableReady: true };
  try {
    const { data, error } = await sb
      .from('subagents')
      .select(SUBAGENT_COLS)
      .in('team_run_id', runIds)
      .order('started_at', { ascending: true });
    if (error) {
      console.warn('[live-data] جدول subagents خوانده نشد:', error.message);
      return { data: [], tableReady: false };
    }
    return { data: (data ?? []) as Record<string, unknown>[], tableReady: true };
  } catch (err) {
    console.warn('[live-data] خطا در خواندن subagents:', err instanceof Error ? err.message : err);
    return { data: [], tableReady: false };
  }
}
