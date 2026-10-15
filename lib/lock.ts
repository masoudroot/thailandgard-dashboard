/**
 * قفل توزیع‌شده‌ی ارکستراتور تایلندگرد.
 *
 * چرا این ماژول جدا شد؟
 * قفل قبلی در lib/orchestrator.ts سه مشکل داشت:
 *  ۱. read-then-write بود؛ دو ورکر هم‌زمان می‌توانستند هر دو «قفل آزاد است»
 *     بخوانند و هر دو بنویسند (race condition).
 *  ۲. TTL برابر ۱۵۰ دقیقه بود و هیچ heartbeat نداشت؛ اگر ورکر می‌مرد، قفل
 *     تا ۲.۵ ساعت گیر می‌کرد و چرخه می‌خوابید.
 *  ۳. claim تیم اتمیک نبود؛ دو اجرای هم‌زمان ورکر گیت‌هاب می‌توانستند یک تیم
 *     را دو بار اجرا کنند (ردیف team_runs تکراری).
 *
 * قراردادهای این ماژول:
 *  - acquireLock با compare-and-swap روی updated_at اتمیک است.
 *  - دارنده‌ی قفل باید هر LOCK_HEARTBEAT_MS یک بار touchLock بزند؛
 *    در غیر این صورت پس از LOCK_TTL_MS قفل «stale» حساب می‌شود و
 *    ورکر بعدی می‌تواند آن را تصاحب کند.
 *  - claimTeam با ایندکس یکتای جزئی دیتابیس اتمیک است؛ فقط یک ورکر
 *    می‌تواند یک تیم را در یک چرخه claim کند.
 *  - همه‌ی خطاها fail-soft نیستند: LockAcquisitionError یعنی «الان نوبت تو
 *    نیست»، نه «سیستم خراب است». فراخوان باید عقب بنشیند و بعداً دوباره
 *    تلاش کند، نه اینکه قفل را بشکند.
 */

import { getSupabase } from './api';

/** کلید ردیف قفل در جدول agent_state. */
export const ORCHESTRATOR_LOCK_KEY = 'orchestrator:lock';
/**
 * اگر دارنده‌ی قفل بیش از این مدت heartbeat نزند، قفل مرده حساب می‌شود.
 * کوتاه‌تر از TTL قبلی (۱۵۰ دقیقه) چون حالا heartbeat داریم.
 */
export const LOCK_TTL_MS = 10 * 60 * 1000;
/** فاصله‌ی پیشنهادی heartbeat دارنده‌ی قفل. */
export const LOCK_HEARTBEAT_MS = 60 * 1000;

/** هویت دارنده‌ی قفل؛ برای تشخیص «دو موتور» (ورسل در برابر گیت‌هاب). */
export interface LockOwner {
  /** مثل 'github-actions' | 'vercel' | 'manual' */
  engine: string;
  /** شناسه‌ی اجرای ورکر (run_id چرخه یا run_id گیت‌هاب) */
  runId: string;
}

export interface LockState {
  status: 'running' | 'idle';
  owner?: LockOwner;
  cycleId?: string;
  /** آخرین heartbeat دارنده؛ اگر نباشد از updated_at ردیف استفاده می‌شود. */
  heartbeatAt?: string;
  startedAt?: string;
}

/** یعنی قفل دست کس دیگری است و هنوز تازه است؛ بعداً دوباره تلاش کن. */
export class LockAcquisitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockAcquisitionError';
  }
}

interface LockRow {
  state: LockState | null;
  updated_at: string;
}

/** خواندن وضعیت فعلی قفل. null یعنی هنوز هیچ قفلی ثبت نشده. */
export async function readLock(): Promise<LockRow | null> {
  const { data, error } = await getSupabase()
    .from('agent_state')
    .select('state, updated_at')
    .eq('agent', ORCHESTRATOR_LOCK_KEY)
    .maybeSingle();
  if (error) throw new Error(`failed to read orchestrator lock: ${error.message}`);
  return data as LockRow | null;
}

/**
 * آیا قفل فعلی stale است؟ یعنی وضعیت running دارد ولی دارنده بیش از
 * LOCK_TTL_MS است که heartbeat نزده (احتمالاً ورکر مرده).
 */
export async function isLockStale(nowMs: number = Date.now()): Promise<boolean> {
  const lock = await readLock();
  if (!lock?.state || lock.state.status !== 'running') return false;
  const ref = lock.state.heartbeatAt || lock.updated_at;
  if (!ref) return false;
  return nowMs - new Date(ref).getTime() > LOCK_TTL_MS;
}

/**
 * تصاحب اتمیک قفل با compare-and-swap روی updated_at.
 *
 * اگر قفل دست دیگری و تازه باشد => LockAcquisitionError.
 * اگر قفل stale باشد یا آزاد => تصاحب می‌شود.
 * اگر بین خواندن و نوشتن، ورکر دیگری قفل را تغییر داده باشد => LockAcquisitionError
 * (فراخوان باید با backoff دوباره تلاش کند).
 */
export async function acquireLock(owner: LockOwner, cycleId?: string): Promise<void> {
  const sb = getSupabase();
  const existing = await readLock();
  const nowIso = new Date().toISOString();

  const newState: LockState = {
    status: 'running',
    owner,
    cycleId,
    heartbeatAt: nowIso,
    startedAt: nowIso,
  };

  // قفل آزاد یا هرگز ثبت نشده
  if (!existing?.state || existing.state.status !== 'running') {
    const { error } = await sb.from('agent_state').upsert(
      { agent: ORCHESTRATOR_LOCK_KEY, state: newState, updated_at: nowIso },
      { onConflict: 'agent' },
    );
    if (error) throw new Error(`failed to acquire lock: ${error.message}`);
    // مسابقه‌ی ثبت هم‌زمان: دوباره بخوان و مطمئن شو مال ماست
    const check = await readLock();
    if (check?.state?.owner?.runId !== owner.runId || check?.state?.owner?.engine !== owner.engine) {
      throw new LockAcquisitionError('lock was taken by another worker during acquire');
    }
    return;
  }

  // قفل running است؛ تازه یا stale؟
  const ref = existing.state.heartbeatAt || existing.updated_at;
  const ageMs = Date.now() - new Date(ref).getTime();
  if (ageMs < LOCK_TTL_MS) {
    throw new LockAcquisitionError(
      `lock held by ${existing.state.owner?.engine ?? 'unknown'}` +
        ` (run_id=${existing.state.owner?.runId ?? 'unknown'}, age=${Math.round(ageMs / 60000)}m);` +
        ` back off and retry`,
    );
  }

  // stale است؛ با CAS تصاحبش کن تا با ورکری که هم‌زمان همین کار را می‌کند مسابقه ندهیم
  const { data, error } = await sb
    .from('agent_state')
    .update({ state: newState, updated_at: nowIso })
    .eq('agent', ORCHESTRATOR_LOCK_KEY)
    .eq('updated_at', existing.updated_at)
    .select('updated_at');
  if (error) throw new Error(`failed to acquire stale lock: ${error.message}`);
  if (!data || data.length === 0) {
    throw new LockAcquisitionError('stale lock was taken by another worker during acquire');
  }
}

/**
 * تازه‌سازی heartbeat. فقط اگر قفل هنوز دست همین owner باشد موفق می‌شود؛
 * در غیر این صورت خطای LockAcquisitionError می‌دهد (یعنی قفل را از دست داده‌ای).
 */
export async function touchLock(owner: LockOwner): Promise<void> {
  const sb = getSupabase();
  const existing = await readLock();
  if (
    !existing?.state ||
    existing.state.status !== 'running' ||
    existing.state.owner?.engine !== owner.engine ||
    existing.state.owner?.runId !== owner.runId
  ) {
    throw new LockAcquisitionError('lock is not held by this owner; cannot heartbeat');
  }
  const nowIso = new Date().toISOString();
  const { data, error } = await sb
    .from('agent_state')
    .update({
      state: { ...existing.state, heartbeatAt: nowIso },
      updated_at: nowIso,
    })
    .eq('agent', ORCHESTRATOR_LOCK_KEY)
    .eq('updated_at', existing.updated_at)
    .select('updated_at');
  if (error) throw new Error(`failed to heartbeat lock: ${error.message}`);
  if (!data || data.length === 0) {
    throw new LockAcquisitionError('lock changed during heartbeat; lost ownership');
  }
}

/**
 * آزادسازی قفل. فقط دارنده می‌تواند آزاد کند؛ اگر قفل دست دیگری باشد
 * (یا stale شده و دیگری تصاحبش کرده) بی‌صدا رد می‌شود تا قفلِ دیگری را
 * اشتباهی آزاد نکنیم.
 */
export async function releaseLock(owner: LockOwner): Promise<void> {
  const sb = getSupabase();
  const existing = await readLock();
  if (
    !existing?.state ||
    existing.state.owner?.engine !== owner.engine ||
    existing.state.owner?.runId !== owner.runId
  ) {
    return; // قفل مال ما نیست؛ دست نزن
  }
  const nowIso = new Date().toISOString();
  await sb
    .from('agent_state')
    .update({
      state: { status: 'idle', owner, heartbeatAt: nowIso } as LockState,
      updated_at: nowIso,
    })
    .eq('agent', ORCHESTRATOR_LOCK_KEY)
    .eq('updated_at', existing.updated_at);
}

/**
 * شروع heartbeat دوره‌ای؛ تابع برگشتی آن را متوقف می‌کند.
 * خطای heartbeat (از دست رفتن قفل) فقط لاگ می‌شود و heartbeat متوقف می‌شود.
 */
export function startHeartbeat(owner: LockOwner, intervalMs: number = LOCK_HEARTBEAT_MS): () => void {
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      await touchLock(owner);
    } catch (err) {
      console.error('[lock] heartbeat failed, stopping:', (err as Error).message);
      clearInterval(timer);
      stopped = true;
    }
  }, intervalMs);
  if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
    (timer as unknown as { unref: () => void }).unref();
  }
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Claim اتمیک یک تیم در یک چرخه.
 *
 * فقط یک ورکر می‌تواند موفق شود؛ بقیه null می‌گیرند.
 * اتمیک‌بودن با ایندکس یکتای جزئی دیتابیس تضمین می‌شود:
 *   CREATE UNIQUE INDEX team_runs_one_running_per_team
 *     ON team_runs (cycle_id, team) WHERE status = 'running';
 * (مایگریشن: supabase/migrations/20261015190000_team_claim.sql)
 *
 * برمی‌گرداند: شناسه‌ی ردیف team_runs در صورت موفقیت، null اگر تیم قبلاً
 * توسط ورکر دیگری claim شده باشد.
 */
export async function claimTeam(
  cycleId: string,
  team: string,
  wave: number,
  owner: LockOwner,
): Promise<string | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('team_runs')
    .insert({
      cycle_id: cycleId,
      team,
      wave,
      status: 'running',
      started_at: new Date().toISOString(),
      current_task: `claimed by ${owner.engine}:${owner.runId}`,
    })
    .select('id')
    .single();
  if (error) {
    // 23505 = unique violation => تیم را ورکر دیگری claim کرده
    if ((error as { code?: string }).code === '23505') return null;
    throw new Error(`failed to claim team ${team}: ${error.message}`);
  }
  if (!data) return null;
  return data.id as string;
}

/**
 * آزادسازی claim یک تیم وقتی ورکر قبل از اتمام می‌میرد یا انصراف می‌دهد:
 * وضعیت را به 'failed' می‌برد تا ورکر بعدی بتواند دوباره claim کند.
 * فقط اگر ردیف هنوز 'running' و متعلق به همین claim باشد.
 */
export async function releaseTeamClaim(teamRunId: string, errorMessage: string): Promise<void> {
  const { error } = await getSupabase()
    .from('team_runs')
    .update({
      status: 'failed',
      error: errorMessage,
      finished_at: new Date().toISOString(),
    })
    .eq('id', teamRunId)
    .eq('status', 'running');
  if (error) console.error(`[lock] failed to release team claim ${teamRunId}:`, error.message);
}
