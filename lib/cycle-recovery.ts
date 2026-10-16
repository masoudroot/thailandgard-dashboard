/**
 * lib/cycle-recovery.ts — بازیابی ریشه‌ای چرخه پس از kill (مشکل ۶).
 *
 * ریشه تأییدشده: اگر فرایند چرخه وسط کار kill شود (تایم‌اوت جاب، کرش، لغو
 * دستی)، این بقایا برای همیشه گیر می‌کنند چون هیچ‌کس آن‌ها را جمع نمی‌کند:
 *   ۱. ردیف cycles در وضعیت running می‌ماند و findActiveCycle برای همیشه
 *      همین چرخه مرده را برمی‌گرداند؛ پس اتوماسیون عملاً می‌ایستد.
 *   ۲. قفل ارکستراتور (agent_state/orchestrator:lock) در وضعیت running
 *      می‌ماند و چرخه جدید تا پایان TTL (در قفل جدید ۱۰ دقیقه با heartbeat)
 *      نمی‌تواند شروع شود.
 *   ۳. پچ‌های پل در وضعیت gated می‌مانند؛ claimBridgePatch فقط از
 *      proposed ادعا می‌کند و جاروی پچ‌های یتیم فقط proposed را پردازش
 *      می‌کند، پس پچ gated برای همیشه گیر می‌کند.
 *   ۴. تسک‌های build_queue در وضعیت in_progress می‌مانند چون settle فقط
 *      در finally فرایند زنده اجرا می‌شود و با kill اجرا نمی‌شود.
 *   ۵. ردیف‌های team_runs در وضعیت running و ساب‌ایجنت‌های باز می‌مانند.
 *
 * قرارداد این ماژول: در شروع هر تیک ورکر و در beginCycle (قبل از گرفتن
 * قفل)، چرخه‌های «مرده» شناسایی می‌شوند؛ چرخه‌ای که نه به‌تازگی شروع شده
 * و نه هیچ ضربان تازه‌ای از تیم‌هایش دارد. بقایایشان پاک‌سازی و بازیابی
 * می‌شود تا چرخه جدید «تمیز» شروع شود. چرخه‌ای که کاربر عمداً pause کرده
 * (وضعیت paused) هرگز مرده حساب نمی‌شود.
 *
 * تشخیص مرگ بر مبنای «ضربان» است نه «زمان شروع»، چون یک چرخه سالم ممکن
 * است ساعت‌ها طول بکشد. سیگنال زنده‌بودن: heartbeat_at ردیف team_runs
 * (پس از مایگریشن 20261016160000) وگرنه updated_at.
 */

import { getSupabase } from './api';
import { ACTIVE_CYCLE_STATUSES, type CycleStatus } from './types';
import { forceReleaseLock } from './lock';

/** پیشوند خطای چرخه‌های killشده؛ مبنای شروع خودکار چرخه بعدی. */
export const CYCLE_KILLED_ERROR_PREFIX = 'KILLED:';

/**
 * اگر چرخه‌ای این‌قدر هیچ ضربانی نداشته باشد، مرده حساب می‌شود.
 * بزرگ‌تر از تایم‌اوت تیم‌های گیرکرده در ورکر، تا چرخه‌ای که ورکر دارد
 * تیم‌هایش را یکی‌یکی تایم‌اوت می‌کند، اشتباهی مرده خوانده نشود.
 */
export const DEAD_CYCLE_QUIET_MS = 20 * 60 * 1000;

/** پچ gated/committed که این‌قدر به‌روز نشده، یتیمِ kill حساب می‌شود. */
export const STUCK_PATCH_MS = 30 * 60 * 1000;

/** تسک in_progress که این‌قدر قدیمی است، یتیمِ kill حساب می‌شود. */
export const STUCK_QUEUE_TASK_MS = 60 * 60 * 1000;

export interface CycleRecoveryReport {
  /** شناسه چرخه‌های مرده‌ای که بسته شدند. */
  reapedCycles: string[];
  /** تعداد قفل‌های آزادشده. */
  releasedLocks: number;
  /** تعداد ردیف‌های team_runs که از running به failed رفتند. */
  failedTeamRuns: number;
  /** تعداد ساب‌ایجنت‌های بازی که بسته شدند. */
  closedSubagents: number;
  /** تعداد تسک‌های صف که از in_progress به pending برگشتند. */
  resetQueueTasks: number;
  /** تعداد پچ‌های پل که از gated/committed به proposed برگشتند. */
  reproposedPatches: number;
}

const emptyReport = (): CycleRecoveryReport => ({
  reapedCycles: [],
  releasedLocks: 0,
  failedTeamRuns: 0,
  closedSubagents: 0,
  resetQueueTasks: 0,
  reproposedPatches: 0,
});

interface CycleRow {
  id: string;
  run_id: string | null;
  status: string;
  started_at: string;
}

function isUserPaused(status: string): boolean {
  return status === 'paused' || status === 'pausing';
}

/**
 * آیا این چرخه مرده است؟ چرخه‌ای که کاربر pause کرده هرگز مرده نیست.
 * در غیر این صورت: اگر از شروعش کمتر از آستانه گذشته یا یکی از تیم‌هایش
 * به‌تازگی ضربان داشته، زنده است.
 */
async function isCycleDead(cycle: CycleRow, quietMs: number): Promise<boolean> {
  if (isUserPaused(cycle.status)) return false;
  const now = Date.now();
  if (now - new Date(cycle.started_at).getTime() < quietMs) return false;
  const sb = getSupabase();
  // جدیدترین سیگنال زنده‌بودن تیم‌های این چرخه (heartbeat_at اگر هست، وگرنه updated_at)
  const { data, error } = await sb
    .from('team_runs')
    .select('heartbeat_at, updated_at')
    .eq('cycle_id', cycle.id)
    .order('updated_at', { ascending: false })
    .limit(5);
  if (error) {
    console.error(`[cycle-recovery] failed to read team_runs heartbeats for ${cycle.id}:`, error.message);
    return false; // در شک، مرده اعلام نکن
  }
  for (const row of (data ?? []) as Array<{ heartbeat_at?: string | null; updated_at?: string | null }>) {
    const beat = row.heartbeat_at ?? row.updated_at;
    if (beat && now - new Date(beat).getTime() < quietMs) return false;
  }
  return true;
}

/**
 * آزادسازی قفل ارکستراتور اگر متعلق به همین چرخه مرده باشد.
 * به قفل جدید (lib/lock.ts) واگذار شده: forceReleaseLock فقط وقتی آزاد
 * می‌کند که قفل واقعاً مال همین چرخه باشد (cycleId جدید یا cycle_id قدیمی)؛
 * پس قفلِ چرخه‌ی تازه‌ای که با stale-takeover گرفته شده امن می‌ماند.
 */
async function releaseLockForCycle(cycleId: string): Promise<boolean> {
  try {
    return await forceReleaseLock(cycleId, 'cycle-recovery');
  } catch (err) {
    console.error('[cycle-recovery] failed to release lock:', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * بستن یک چرخه مرده و پاک‌سازی همه بقایایش. کاملاً idempotent است:
 * اجرای دوباره روی چرخه‌ای که قبلاً بسته شده، چیزی را عوض نمی‌کند.
 */
async function reapDeadCycle(cycle: CycleRow, report: CycleRecoveryReport): Promise<void> {
  const sb = getSupabase();
  const nowIso = new Date().toISOString();
  const killedError =
    `${CYCLE_KILLED_ERROR_PREFIX} چرخه بیش از ${Math.round(DEAD_CYCLE_QUIET_MS / 60000)} دقیقه ` +
    'هیچ ضربانی نداشت (احتمالاً kill شد)؛ بقایایش بازیابی شد و چرخه جدید می‌تواند تمیز شروع شود.';

  // ۱. خود چرخه: فقط اگر هنوز فعال است ببند (idempotent)
  const { data: updatedCycle } = await sb
    .from('cycles')
    .update({ status: 'failed', finished_at: nowIso, error: killedError.slice(0, 4000) })
    .eq('id', cycle.id)
    .in('status', [...ACTIVE_CYCLE_STATUSES] as string[])
    .select('id');
  if (!updatedCycle || (updatedCycle as unknown[]).length === 0) return; // دیگری زودتر بست
  report.reapedCycles.push(cycle.id);
  console.log(`[cycle-recovery] چرخه مرده بسته شد: ${cycle.id} (run_id=${cycle.run_id ?? '?'})`);

  // ۲. قفل stale متعلق به همین چرخه
  if (await releaseLockForCycle(cycle.id)) {
    report.releasedLocks += 1;
    console.log(`[cycle-recovery] قفل stale چرخه ${cycle.id} آزاد شد.`);
  }

  // ۳. ردیف‌های team_runs گیرکرده در running
  const { data: stuckRuns } = await sb
    .from('team_runs')
    .select('id')
    .eq('cycle_id', cycle.id)
    .eq('status', 'running');
  const stuckRunIds = ((stuckRuns ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (stuckRunIds.length > 0) {
    const { error: failErr } = await sb
      .from('team_runs')
      .update({
        status: 'failed',
        error: 'چرخه kill شد؛ اجرای تیم ناتمام ماند.',
        finished_at: nowIso,
      })
      .in('id', stuckRunIds)
      .eq('status', 'running');
    if (failErr) {
      console.error('[cycle-recovery] failed to fail stuck team_runs:', failErr.message);
    } else {
      report.failedTeamRuns += stuckRunIds.length;
    }
    // ۴. ساب‌ایجنت‌های باز این اجراها
    const { error: subErr, count } = await sb
      .from('subagents')
      .update({ status: 'failed', finished_at: nowIso }, { count: 'exact' })
      .in('team_run_id', stuckRunIds)
      .in('status', ['pending', 'running', 'paused']);
    if (subErr) {
      console.error('[cycle-recovery] failed to close subagents:', subErr.message);
    } else {
      report.closedSubagents += count ?? 0;
    }
  }

  // ۵. تسک‌های build_queue یتیم در in_progress.
  // این تسک‌ها پیش از claim وضعیت pending داشتند (claimNextTaskForTeam فقط
  // pending را برمی‌دارد)؛ پس برگشت امن به pending است تا چرخه بعدی دوباره
  // تحویلشان بگیرد. فقط تسک‌های به‌اندازه کافی قدیمی، تا تسک زنده‌ای که
  // همین حالا دستی اجرا می‌شود، اشتباهی برنگردد.
  const stuckBefore = new Date(Date.now() - STUCK_QUEUE_TASK_MS).toISOString();
  const { data: stuckTasks, error: qErr } = await sb
    .from('build_queue')
    .select('id')
    .eq('status', 'in_progress')
    .lt('created_at', stuckBefore);
  if (qErr) {
    console.error('[cycle-recovery] failed to list stuck queue tasks:', qErr.message);
  } else {
    const ids = ((stuckTasks ?? []) as Array<{ id: string }>).map((r) => r.id);
    for (const id of ids) {
      const { error: rErr } = await sb
        .from('build_queue')
        .update({
          status: 'pending',
          result: 'بازیابی خودکار پس از kill چرخه: تسک به صف برگشت تا دوباره تحویل گرفته شود.',
        })
        .eq('id', id)
        .eq('status', 'in_progress');
      if (rErr) {
        console.error(`[cycle-recovery] failed to reset queue task ${id}:`, rErr.message);
      } else {
        report.resetQueueTasks += 1;
      }
    }
  }

  // ۶. پچ‌های پل یتیم در gated/committed (ریشه «پچ‌های gated برای همیشه گیر می‌کنند»).
  // claimBridgePatch فقط از proposed ادعا می‌کند و جاروی یتیم‌ها فقط proposed
  // را پردازش می‌کند؛ پس پچِ killشده در میانه راه برای همیشه گیر می‌کرد.
  // برگشت به proposed تا جاروی بعدی دوباره کامل پردازشش کند (کامیت idempotent است).
  const patchBefore = new Date(Date.now() - STUCK_PATCH_MS).toISOString();
  const { data: stuckPatches, error: pErr } = await sb
    .from('bridge_patches')
    .select('id, status')
    .in('status', ['gated', 'committed'])
    .lt('updated_at', patchBefore);
  if (pErr) {
    console.error('[cycle-recovery] failed to list stuck bridge patches:', pErr.message);
  } else {
    for (const p of (stuckPatches ?? []) as Array<{ id: string; status: string }>) {
      const { error: rpErr } = await sb
        .from('bridge_patches')
        .update({ status: 'proposed', updated_at: nowIso })
        .eq('id', p.id)
        .in('status', ['gated', 'committed']);
      if (rpErr) {
        console.error(`[cycle-recovery] failed to requeue patch ${p.id}:`, rpErr.message);
      } else {
        report.reproposedPatches += 1;
        console.log(`[cycle-recovery] پچ یتیم ${p.id} (${p.status}) به proposed برگشت.`);
      }
    }
  }
}

/**
 * شناسایی و بازیابی همه چرخه‌های مرده. در شروع هر تیک ورکر و در beginCycle
 * (پیش از گرفتن قفل) صدا زده می‌شود تا چرخه جدید همیشه تمیز شروع شود.
 * کاملاً idempotent و fail-soft: خطا لاگ می‌شود و گزارش خالی برمی‌گردد تا
 * جریان اصلی چرخه هرگز به‌خاطر بازیابی نایستد.
 */
export async function recoverDeadCycles(): Promise<CycleRecoveryReport> {
  const report = emptyReport();
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('cycles')
      .select('id, run_id, status, started_at')
      .in('status', [...ACTIVE_CYCLE_STATUSES] as string[])
      .order('started_at', { ascending: false });
    if (error) {
      console.error('[cycle-recovery] failed to list active cycles:', error.message);
      return report;
    }
    for (const cycle of (data ?? []) as CycleRow[]) {
      try {
        if (await isCycleDead(cycle, DEAD_CYCLE_QUIET_MS)) {
          await reapDeadCycle(cycle, report);
        }
      } catch (err) {
        console.error(`[cycle-recovery] failed to reap cycle ${cycle.id}:`, err instanceof Error ? err.message : err);
      }
    }
    if (report.reapedCycles.length > 0) {
      console.log(
        `[cycle-recovery] بازیابی تمام شد: ${report.reapedCycles.length} چرخه مرده، ` +
          `${report.failedTeamRuns} اجرای تیم، ${report.closedSubagents} ساب‌ایجنت، ` +
          `${report.resetQueueTasks} تسک صف، ${report.reproposedPatches} پچ پل.`,
      );
    }
  } catch (err) {
    console.error('[cycle-recovery] unexpected error:', err instanceof Error ? err.message : err);
  }
  return report;
}

/** آیا آخرین چرخه با kill بسته شده و چرخه جدید می‌تواند خودکار شروع شود؟ */
export function isAutoRestartableAfterKill(lastCycle: {
  status: string;
  error?: string | null;
}): boolean {
  return (
    lastCycle.status === 'failed' &&
    typeof lastCycle.error === 'string' &&
    lastCycle.error.startsWith(CYCLE_KILLED_ERROR_PREFIX)
  );
}

/** تایپ وضعیت چرخه برای مصرف‌کنندگان این ماژول. */
export type { CycleStatus };
