/**
 * GET /api/cron/cycle-tick: پیشبرد چرخه‌های فعال به‌صورت افزایشی.
 * هر ۲ دقیقه توسط کرون ورسل اجرا می‌شود.
 * - تیم‌های گیرکرده (بیش از ۱۵ دقیقه running) را تایم‌اوت می‌کند
 * - اگر موج جاری تمام شده، موج بعد را شروع می‌کند
 * - اگر همه موج‌ها تمام شدند، چرخه را می‌بندد
 */
import { fail, getSupabase, ok } from '../../../../lib/api';
import { waitUntil } from '@vercel/functions';
import { WAVES } from '../../../../lib/types';
import { finishCycle, runWave } from '../../../../lib/orchestrator';

const STUCK_TIMEOUT_MS = 15 * 60 * 1000; // ۱۵ دقیقه

export async function GET(request: Request): Promise<Response> {
  // احراز: کرون ورسل (CRON_SECRET) یا توکن مدیر
  const authHeader = request.headers.get('authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  let authorized = false;
  if (process.env.CRON_SECRET && token === process.env.CRON_SECRET) {
    authorized = true;
  } else if (token) {
    try {
      const { requireManagerAuth } = await import('../../../../lib/manager-auth');
      const auth = await requireManagerAuth(request);
      authorized = !(auth instanceof Response);
    } catch {
      /* نادیده */
    }
  }
  if (!authorized) return fail('غیرمجاز', 401);
  try {
    const sb = getSupabase();
    // چرخه فعال
    const { data: cycles } = await sb
      .from('cycles')
      .select('id, run_id, status')
      .eq('status', 'running')
      .order('started_at', { ascending: false })
      .limit(1);
    const cycle = cycles?.[0];
    if (!cycle) return ok({ ticked: false, reason: 'no active cycle' });

    const cycleId = String(cycle.id);
    // تیم‌های این چرخه
    const { data: runs } = await sb
      .from('team_runs')
      .select('team, status, started_at')
      .eq('cycle_id', cycleId);
    const teamStatus: Record<string, { status: string; started_at: string }> = {};
    for (const r of (runs ?? []) as { team: string; status: string; started_at: string }[]) {
      teamStatus[r.team] = { status: r.status, started_at: r.started_at };
    }

    // ۱. تایم‌اوت تیم‌های گیرکرده
    const now = Date.now();
    const stuck: string[] = [];
    for (const [team, info] of Object.entries(teamStatus)) {
      if (info.status === 'running') {
        const age = now - new Date(info.started_at).getTime();
        if (age > STUCK_TIMEOUT_MS) stuck.push(team);
      }
    }
    for (const team of stuck) {
      await sb
        .from('team_runs')
        .update({ status: 'failed', error: 'تایم‌اوت: بیش از ۱۵ دقیقه در حالت اجرا ماند' })
        .eq('cycle_id', cycleId)
        .eq('team', team);
      teamStatus[team] = { status: 'failed', started_at: teamStatus[team].started_at };
    }

    // ۲. پیدا کردن موج جاری (اولین موج ناتمام)
    const isDone = (s: string) => ['success', 'failed', 'stopped'].includes(s);
    let currentWave = -1;
    let allDone = true;
    for (const w of WAVES) {
      const waveDone = w.teams.every((t) => isDone(teamStatus[t]?.status ?? 'pending'));
      if (!waveDone) {
        allDone = false;
        currentWave = w.wave;
        break;
      }
    }

    // ۳. اگر همه تمام شدند، چرخه را ببند
    if (allDone) {
      const failed = Object.values(teamStatus).filter((t) => ['failed', 'stopped'].includes(t.status)).length;
      await finishCycle(cycleId, failed > 0 ? 'failed' : 'success');
      return ok({ ticked: true, action: 'finished', failed });
    }

    // ۴. اگر موج جاری تیم در حال اجرا ندارد، شروعش کن
    const waveDef = WAVES.find((w) => w.wave === currentWave)!;
    const hasRunning = waveDef.teams.some((t) => teamStatus[t]?.status === 'running');
    if (!hasRunning) {
      const runId = String(cycle.run_id ?? 'unknown');
      waitUntil(
        runWave(cycleId, currentWave, { runId, previousWavesOutput: {} }).catch((err) => {
          console.error(`[cycle-tick] wave ${currentWave} crashed:`, err);
        }),
      );
      return ok({ ticked: true, action: 'started_wave', wave: currentWave, timedOut: stuck });
    }

    return ok({ ticked: true, action: 'waiting', wave: currentWave, timedOut: stuck });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
