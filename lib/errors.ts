/**
 * lib/errors.ts: خواندن خطاهای واقعی تیم‌ها از جدول team_runs.
 *
 * قانون مطلق: هیچ داده‌ی نمایشی. هر چیزی که این ماژول برمی‌گرداند
 * مستقیم از team_runs می‌آید؛ اگر ردیفی نیست، آرایه‌ی خالی برمی‌گردد
 * و لایه‌ی نمایش حالت خالی صادقانه نشان می‌دهد.
 */
import { getSupabase } from './api';
import { TEAMS, type TeamName, type TeamRun } from './types';

/** رانی که بیش از این دقیقه در وضعیت running بماند، «گیرکرده» حساب می‌شود. */
export const STUCK_AFTER_MINUTES = 120;
/** چند شکست پشت‌سرهم برای هشدار «تلاش‌های ناموفق پشت سر هم» کافی است. */
export const CONSECUTIVE_FAILURE_ALERT = 2;

export interface ErrorItem extends TeamRun {
  /** run_id خوانای چرخه‌ی مادر (برای نمایش). */
  run_id: string | null;
}

export type AlertKind = 'consecutive_failures' | 'stuck';

export interface ErrorAlert {
  kind: AlertKind;
  team: TeamName;
  /** جزئیات واقعی: مثلاً «۳ اجرای اخیر پشت سر هم ناموفق بود». */
  detail: string;
  /** برای شکست‌های پشت‌سرهم: تعداد؛ برای گیرکرده: دقیقه‌ی سپری‌شده. */
  count: number;
  /** id آخرین ران مرتبط (برای دکمه‌ی تلاش مجدد). */
  run_id: string;
  started_at: string | null;
}

interface RunWithCycle extends TeamRun {
  cycles: { run_id: string } | null;
}

async function fetchRecentRuns(limit: number): Promise<RunWithCycle[]> {
  const { data, error } = await getSupabase()
    .from('team_runs')
    .select('*, cycles!inner(run_id)')
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`failed to read team_runs: ${error.message}`);
  return (data ?? []) as unknown as RunWithCycle[];
}

/** جدیدترین ران هر تیم (بر اساس started_at). */
export async function getLatestRunsByTeam(): Promise<Map<TeamName, RunWithCycle>> {
  const rows = await fetchRecentRuns(500);
  const byTeam = new Map<TeamName, RunWithCycle>();
  for (const row of rows) {
    if (!byTeam.has(row.team)) byTeam.set(row.team, row);
  }
  return byTeam;
}

function toErrorItem(row: RunWithCycle): ErrorItem {
  const { cycles, ...run } = row;
  return { ...run, run_id: cycles?.run_id ?? null };
}

function isStuck(row: RunWithCycle): boolean {
  if (row.status !== 'running' || !row.started_at) return false;
  const ageMin = (Date.now() - new Date(row.started_at).getTime()) / 60000;
  return ageMin > STUCK_AFTER_MINUTES;
}

/**
 * خطاهای جاری: جدیدترین ران هر تیم که ناموفق بوده (با پیام واقعی)،
 * به‌علاوه‌ی ران‌های گیرکرده (runningِ قدیمی‌تر از آستانه).
 */
export async function getCurrentErrors(): Promise<ErrorItem[]> {
  const byTeam = await getLatestRunsByTeam();
  const out: ErrorItem[] = [];
  for (const team of TEAMS) {
    const row = byTeam.get(team);
    if (!row) continue;
    if (row.status === 'failed') out.push(toErrorItem(row));
    else if (isStuck(row)) out.push({ ...toErrorItem(row), error: null });
  }
  out.sort(
    (a, b) =>
      new Date(b.started_at ?? 0).getTime() - new Date(a.started_at ?? 0).getTime(),
  );
  return out;
}

/**
 * هشدارها (فقط از داده‌ی واقعی):
 * - شکست‌های ناموفق پشت سر هم (حداقل CONSECUTIVE_FAILURE_ALERT)
 * - ران گیرکرده (timeout ضمنی: running قدیمی‌تر از آستانه)
 */
export async function getErrorAlerts(): Promise<ErrorAlert[]> {
  const rows = await fetchRecentRuns(500);
  const alerts: ErrorAlert[] = [];

  for (const team of TEAMS) {
    const teamRows = rows.filter((r) => r.team === team).slice(0, 10);
    if (teamRows.length === 0) continue;

    // شکست‌های پشت سر هم از جدیدترین به قدیمی
    let consecutive = 0;
    for (const r of teamRows) {
      if (r.status === 'failed') consecutive++;
      else break;
    }
    if (consecutive >= CONSECUTIVE_FAILURE_ALERT) {
      alerts.push({
        kind: 'consecutive_failures',
        team,
        detail: `${faCount(consecutive)} اجرای اخیر پشت سر هم ناموفق بود`,
        count: consecutive,
        run_id: teamRows[0].id,
        started_at: teamRows[0].started_at,
      });
    }

    // ران گیرکرده
    const latest = teamRows[0];
    if (isStuck(latest) && latest.started_at) {
      const ageMin = Math.round(
        (Date.now() - new Date(latest.started_at).getTime()) / 60000,
      );
      alerts.push({
        kind: 'stuck',
        team,
        detail: `بیش از ${faCount(STUCK_AFTER_MINUTES)} دقیقه در وضعیت «در حال اجرا» مانده و پاسخی ثبت نشده (احتمال timeout)`,
        count: ageMin,
        run_id: latest.id,
        started_at: latest.started_at,
      });
    }
  }

  return alerts;
}

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
function faCount(n: number): string {
  return String(n).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]);
}

/** شروع «امروز» به وقت تهران، به‌صورت ISO (تهران DST ندارد؛ همیشه +03:30). */
export function tehranDayStartUtc(now = new Date()): string {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return new Date(`${ymd}T00:00:00+03:30`).toISOString();
}

/** تاریخچه‌ی خطاهای امروز (تهران) با فیلتر اختیاری تیم. */
export async function getTodayErrors(team?: TeamName): Promise<ErrorItem[]> {
  const sb = getSupabase();
  let q = sb
    .from('team_runs')
    .select('*, cycles!inner(run_id)')
    .eq('status', 'failed')
    .gte('started_at', tehranDayStartUtc())
    .order('started_at', { ascending: false })
    .limit(200);
  if (team) q = q.eq('team', team);
  const { data, error } = await q;
  if (error) throw new Error(`failed to read today errors: ${error.message}`);
  return ((data ?? []) as unknown as RunWithCycle[]).map(toErrorItem);
}
