/**
 * ارکستراتور چرخه: مدیریت چرخه‌های ۵ تیم در ۳ موج (دستور مسعود، ۱۴۰۵/۰۷/۲۴).
 *
 * معماری: ورسل فقط داشبورد و API مدیریتی است. اجرای تیم‌ها با
 * ورکر گیت‌هاب اکشنز (worker/cycle-worker.ts) انجام می‌شود که در هر
 * اجرا فقط یک تیم را اجرا می‌کند (runSingleTeam).
 *
 * جریان یک چرخه:
 *   1. beginCycle: ساخت run_id یکتا + گرفتن قفل سراسری (agent_state)
 *      + ساخت ردیف cycles
 *   2. ورکر گیت‌هاب: اجرای تک‌تک تیم‌ها (runSingleTeam)
 *   3. finishCycle: آزاد کردن قفل + ثبت وضعیت نهایی cycles
 *
 * هر تیم با تابع runTeam از ماژول lib/teams/<team>.ts (ایمپورت داینامیک)
 * اجرا می‌شود. اگر ماژول تیم هنوز ساخته نشده باشد، اجرای آن تیم با
 * خطای واضح fail می‌شود ولی بقیه‌ی تیم‌ها ادامه می‌دهند.
 */
import { getSupabase } from './api';
import { recordEvent } from './operation-events';
import { runKnowledgeSubagent } from './knowledge-subagent';
import {
  acquireLock as acquireLockNew,
  claimTeam as claimTeamAtomic,
  forceReleaseLock,
  readLock as readLockNew,
  releaseLock as releaseLockNew,
  touchLock,
  LockAcquisitionError,
  type LockOwner,
} from './lock';
import { runWithTeamContext } from './llm';
import { notifyTeamReport } from './notify';
import {
  claimNextTaskForTeam,
  isValidTaskId,
  listApprovedTasksForTeam,
  settleClaimedTask,
  type ClaimedTaskOutcome,
} from './taskqueue';
import {
  ACTIVE_CYCLE_STATUSES,
  MAX_SAME_CYCLE_FIX_ATTEMPTS,
  normalizeCycleStatus,
  WAVES,
  type CycleStatus,
  type MemoryEntry,
  type PatchFile,
  type ProgressReporter,
  type SubagentControl,
  type TeamName,
  type TeamResult,
  type TeamRunStatus,
} from './types';

/**
 * @deprecated قفل قدیمی (read-then-write با TTL ۱۵۰ دقیقه‌ای و بدون heartbeat).
 * race condition دارد: دو فراخوان هم‌زمان می‌توانستند هر دو قفل را بگیرند.
 * به‌جایش از lib/lock.ts استفاده کن (acquireLock/touchLock/releaseLock).
 * این توابع فقط برای سازگاری نگه داشته شده‌اند و دیگر هیچ‌جا صدا زده نمی‌شوند.
 */
const LOCK_KEY = 'orchestrator:lock';
/**
 * @deprecated بخشی از قفل قدیمی است؛ نگاه کن به LOCK_TTL_MS در lib/lock.ts.
 */
const LOCK_TTL_MINUTES = 150;
/** How often a paused cycle re-reads its status while waiting for resume/cancel. */
const PAUSE_POLL_MS = 5000;

/**
 * چرخه‌ای دیگر در حال اجراست. از LockAcquisitionError ارث می‌برد تا هم
 * قرارداد قدیمی API (گرفتن instanceof در روت‌ها => 409) حفظ شود، هم
 * مصرف‌کننده‌های قفل جدید بتوانند آن را به‌عنوان «قفل دست دیگری است»
 * بگیرند. پیام، همان پیام قفل جدید است (مالک + سن قفل).
 */
export class CycleLockedError extends LockAcquisitionError {}

/** وقتی کاربر ساب‌ایجنت را متوقف می‌کند، در مرز مرحله‌ی بعدی پرتاب می‌شود. */
export class SubagentStoppedError extends Error {
  constructor(public readonly stage: string) {
    super(`subagent stopped by user at stage: ${stage}`);
  }
}

/** برچسب‌هایی که مرحله‌ی واقعی نیستند و ساب‌ایجنت جدا نمی‌خواهند. */
const PSEUDO_TASKS = new Set(['شروع اجرا', 'پایان کار', 'خطا در اجرا']);
/** هر چند وقت یک‌بار ردیف team_runsِ تیمِ در حال اجرا لمس می‌شود (میلی‌ثانیه). */
const HEARTBEAT_MS = 60_000;
/** گزارش‌های پیشرفت تکراری/خیلی نزدیک به هم ادغام می‌شوند. */
const PROGRESS_MIN_INTERVAL_MS = 2000;
/** فاصله‌ی نظرسنجی سیگنال کنترلی وقتی ساب‌ایجنت متوقف‌شده (pause) است. */
const CONTROL_POLL_MS = 5000;
/** سقف انتظار برای ادامه‌یافتن (resume) یک ساب‌ایجنت متوقف‌شده: ۳۰ دقیقه. */
const PAUSE_TIMEOUT_MS = 30 * 60_000;
/**
 * حداکثر دور اصلاح پس از چک سادهٔ رهبر (دستور مسعود، ۱۴۰۵/۰۷/۲۴):
 * دور ۱ اجرای اول است؛ اگر چک ساده رد کرد، فقط ۱ دور اصلاح با دستور
 * مشخص انجام می‌شود. بدون حلقهٔ ۳دوره‌ای.
 */
const MAX_FIX_ROUNDS = 1;

/**
 * خروجی چک سادهٔ رهبر روی کار تیم: «کار می‌کنه؟» بله/نه + یک جمله دلیل.
 * نه نمره، نه چند دور.
 */
export interface SimpleCheckResult {
  pass: boolean;
  /** یک جمله دلیل، فارسی. */
  note: string;
  /** اگر رد شد، یک دستور مشخص برای دور اصلاح (اختیاری). */
  fixDirective?: string;
}

/**
 * چک سادهٔ رهبر روی خروجی یک تیم (جایگزین حلقهٔ نقد ۳دوره‌ای).
 * اول چند قانون سبک قاعده‌محور، بعد یک فراخوان LLM سبک با حکم بله/نه.
 * fail-soft: اگر LLM خطا داد، خروجی پذیرفته می‌شود (اعتماد به تیم) و
 * این چک هرگز نتیجهٔ تیم را خراب نمی‌کند.
 */
export async function runSimpleCheck(team: TeamName, output: TeamResult): Promise<SimpleCheckResult> {
  // ۱) قواعد سبک: خروجی خالی یا پر از بلاکر، بدون LLM رد می‌شود
  const summary = (output.summary ?? '').trim();
  const blockers = (output.blockers ?? []).filter((b) => b && b.trim().length > 0);
  if (summary.length < 20) {
    return {
      pass: false,
      note: 'خلاصهٔ خروجی خالی یا خیلی کوتاه است؛ تیم چیزی تحویل نداده.',
      fixDirective: 'خروجی کامل را تولید کن و خلاصهٔ واقعی آن را بنویس؛ خروجی خالی قابل قبول نیست.',
    };
  }
  if (output.approved === false && blockers.length > 0) {
    return {
      pass: false,
      note: `تیم خودش خروجی را تأیید نکرد: ${blockers[0].slice(0, 300)}`,
      fixDirective: `این ایراد را برطرف کن و خروجی کامل را از نو تولید کن: ${blockers[0].slice(0, 500)}`,
    };
  }
  // استثنای سقف هوشمند: رهبر وقتی دادهٔ تازه‌ای نیست و صادقانه تسکی نساخته،
  // این «کار درست» است نه خرابی؛ بدون قضاوت LLM عبور می‌کند.
  if (
    team === 'leader' &&
    (output.tasks ?? []).length === 0 &&
    /داده[ٔی]?\s+تازه/.test(summary)
  ) {
    return {
      pass: true,
      note: 'چک رهبر: دادهٔ تازه‌ای نبود؛ تسک نساختن تصمیم درست است.',
    };
  }
  // ۲) داوری سبک LLM: فقط «کار می‌کنه؟» + یک جمله دلیل + دستور اصلاح
  try {
    const { callLLMJson } = await import('./llm');
    const verdict = await callLLMJson<{ pass: boolean; note: string; fixDirective?: string }>(
      [
        `تو رهبر تیم‌های تایلندگرد هستی. خروجی تیم «${team}» را فقط با یک سؤال بسنج: «کار می‌کنه؟»`,
        'یعنی: آیا تیم واقعاً کاری را که قولش را داده انجام داده و خروجی‌اش قابل استفاده است؟',
        'نه نمره بده، نه چند دور؛ فقط بله یا نه + یک جمله دلیل.',
        '',
        'خلاصهٔ تیم:',
        summary.slice(0, 3000),
        blockers.length > 0 ? `\nبلاکرهای ثبت‌شده: ${blockers.slice(0, 3).join(' | ').slice(0, 1000)}` : '',
        output.tasks && output.tasks.length > 0
          ? `\nتسک‌های پیشنهادی تیم (${output.tasks.length}): ${output.tasks.map((t) => t.title).join(' | ').slice(0, 500)}`
          : '',
        '',
        'فقط JSON معتبر بده: {"pass": true/false, "note": "یک جمله دلیل فارسی", "fixDirective": "اگر رد شد، یک دستور مشخص و اجرایی برای اصلاح"}',
        'خروجی باید دقیقاً با { شروع و با } تمام شود. هیچ متن، توضیح یا کدفنس قبل و بعد از JSON ننویس.',
      ].join('\n'),
      { system: 'تو رهبر عمل‌گرای تیم‌های تایلندگرد هستی؛ حکم کوتاه و مشخص می‌دهی.' },
    );
    const pass = verdict.pass !== false;
    return {
      pass,
      note: String(verdict.note ?? '').trim().slice(0, 500) || (pass ? 'چک رهبر: قابل قبول.' : 'چک رهبر: رد شد.'),
      fixDirective: pass ? undefined : String(verdict.fixDirective ?? '').trim().slice(0, 1000) || undefined,
    };
  } catch {
    // fail-soft: خطای LLM یعنی چک انجام نشد؛ به تیم اعتماد می‌کنیم
    return { pass: true, note: 'چک خودکار رهبر انجام نشد؛ خروجی تیم پذیرفته شد.' };
  }
}

/**
 * چرخهٔ یادگیری (دستور مسعود، ۱۴۰۵/۰۷/۲۴): بعد از هر اجرای تیم (موفق یا
 * ناموفق)، یک فراخوان LLM سبک «از این اجرا چه درس کاربردی گرفتیم؟ (۱ جمله)»
 * و ثبت آن با upsertGoldenRule. سقف ۱۰ قانون طلایی هر تیم و حذف
 * کم‌اثرترینِ اضافه را همان ماژول دانش مدیریت می‌کند.
 * کاملاً fail-soft: خطای ثبت درس هرگز نتیجهٔ تیم را خراب نمی‌کند.
 */
export async function recordRunLesson(
  team: TeamName,
  status: TeamRunStatus,
  summary: string,
): Promise<void> {
  try {
    const { callLLMJson } = await import('./llm');
    const { upsertGoldenRule } = await import('./knowledge/golden-rules');
    const lesson = await callLLMJson<{ lesson: string }>(
      [
        `تیم «${team}» تایلندگرد یک اجرا را با وضعیت «${status}» تمام کرد.`,
        `خلاصهٔ اجرا: ${summary.slice(0, 1500) || '(خلاصه‌ای ثبت نشد)'}`,
        '',
        'از این اجرا چه درس کاربردی و مشخصی برای چرخه‌های بعدی همین تیم گرفتیم؟ فقط ۱ جملهٔ کوتاه و اجرایی بده؛ کلی‌گویی ممنوع.',
        'فقط JSON معتبر بده: {"lesson": "یک جمله"}',
        'خروجی باید دقیقاً با { شروع و با } تمام شود. هیچ متن، توضیح یا کدفنس قبل و بعد از JSON ننویس.',
      ].join('\n'),
      {
        system:
          'تو مربی تیم‌های تایلندگرد هستی؛ درس‌ها را کوتاه، مشخص و اجرایی می‌نویسی.',
      },
    );
    const rule = String(lesson.lesson ?? '').trim().slice(0, 500);
    if (!rule) return;
    await upsertGoldenRule(
      team,
      rule,
      `درس خودکار از اجرای تیم ${team} (وضعیت: ${status})`,
      'learned',
      50,
    );
    console.log(`[orchestrator] درس اجرای تیم ${team} در دانش ثبت شد.`);
  } catch (err) {
    // fail-soft: خطای ثبت درس هرگز نتیجهٔ تیم را خراب نمی‌کند
    console.error(
      '[orchestrator] ثبت درس تیم ناموفق بود (نادیده):',
      err instanceof Error ? err.message : err,
    );
  }
}

/** ورودی استاندارد هر تیم. */
export interface TeamInput {
  cycleId: string;
  runId: string;
  /** زمینه‌ی متنی از خروجی موج‌های قبلی همین چرخه. */
  ragContext: string;
  /** حافظه‌ی ذخیره‌شده‌ی تیم از چرخه‌های قبلی (جدول team_memory). */
  memory: MemoryEntry[];
  /** خروجی کامل موج‌های قبلی: team -> TeamResult (یا null برای تیم‌های fail/skipped). */
  previousWavesOutput: Record<string, TeamResult | null>;
  /**
   * گزارش زنده‌ی پیشرفت به ارکستر: تیم در مرز مرحله‌هایش صدا می‌زند و
   * ارکستر آن را در team_runs (progress/current_task) می‌نویسد و ساب‌ایجنت‌ها
   * را مدیریت می‌کند.
   */
  reportProgress: ProgressReporter;
  /**
   * دور جاری اجرای تیم (۱ = اجرای اول؛ ۲ = دور اصلاح پس از چک سادهٔ رهبر).
   * بیش از ۱ دور اصلاح انجام نمی‌شود (MAX_FIX_ROUNDS).
   */
  round?: number;
  /**
   * دستور مشخص چک سادهٔ رهبر برای دور اصلاح (دلیل رد + کار خواسته‌شده).
   * فقط در دور ۲ پر است. تیم‌ها آن را در ابتدای زمینه می‌بینند.
   */
  reviewDirective?: string;
}

type RunTeamFn = (input: TeamInput) => Promise<TeamResult>;

/** ساخت run_id یکتا: run-YYYYMMDDHHMMSS-xxxxxx */
function makeRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(
    d.getUTCHours(),
  )}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 8);
  return `run-${stamp}-${rand}`;
}

/** @deprecated شکل قدیمی ردیف قفل (snake_case)؛ شکل جدید LockState در lib/lock.ts است. */
interface LockRow {
  state:
    | {
        status?: string;
        run_id?: string;
        cycle_id?: string;
        started_at?: string;
        paused?: boolean;
      }
    | null;
  updated_at: string;
}

/** @deprecated به‌جایش readLock از lib/lock.ts. */
async function readLock(): Promise<LockRow | null> {
  console.warn('[orchestrator] deprecated: readLock قدیمی صدا زده شد؛ از lib/lock.ts استفاده کن');
  const { data, error } = await getSupabase()
    .from('agent_state')
    .select('state, updated_at')
    .eq('agent', LOCK_KEY)
    .maybeSingle();
  if (error) throw new Error(`failed to read orchestrator lock: ${error.message}`);
  return data as LockRow | null;
}

/** @deprecated به‌جایش touchLock/releaseLock/forceReleaseLock از lib/lock.ts. */
async function writeLock(state: Record<string, unknown>): Promise<void> {
  console.warn('[orchestrator] deprecated: writeLock قدیمی صدا زده شد؛ از lib/lock.ts استفاده کن');
  const { error } = await getSupabase()
    .from('agent_state')
    .upsert(
      { agent: LOCK_KEY, state, updated_at: new Date().toISOString() },
      { onConflict: 'agent' },
    );
  if (error) throw new Error(`failed to write orchestrator lock: ${error.message}`);
}

/**
 * @deprecated race دارد (read-then-write). به‌جایش acquireLock از lib/lock.ts
 * که با compare-and-swap اتمیک است.
 */
async function acquireLock(runId: string): Promise<void> {
  console.warn('[orchestrator] deprecated: acquireLock قدیمی صدا زده شد؛ از lib/lock.ts استفاده کن');
  const existing = await readLock();
  if (existing?.state?.status === 'running') {
    const ref =
      existing.updated_at || existing.state.started_at || new Date(0).toISOString();
    const ageMin = (Date.now() - new Date(ref).getTime()) / 60000;
    if (ageMin < LOCK_TTL_MINUTES) {
      throw new CycleLockedError(
        `another cycle is already running (run_id=${existing.state.run_id ?? 'unknown'}, age=${Math.round(
          ageMin,
        )}m); wait for it to finish or for the ${LOCK_TTL_MINUTES}-minute stale-lock window to pass`,
      );
    }
  }
  await writeLock({
    status: 'running',
    run_id: runId,
    started_at: new Date().toISOString(),
  });
}

/** فقط قفل گرفتن + ساخت ردیف cycles (بدون اجرای موج‌ها). */
export async function beginCycle(): Promise<{ cycleId: string; runId: string }> {
  // رفع ریشه‌ای مشکل kill (مشکل ۶): پیش از گرفتن قفل، بقایای چرخه مرده
  // (قفل stale، تسک‌های claimشده رها، وضعیت‌های ناتمام، پچ‌های gated یتیم)
  // بازیابی می‌شوند تا چرخه جدید تمیز شروع شود. fail-soft است.
  try {
    const { recoverDeadCycles } = await import('./cycle-recovery');
    await recoverDeadCycles();
  } catch (err) {
    console.error('[orchestrator] cycle recovery before beginCycle failed (continuing):', err instanceof Error ? err.message : err);
  }
  const runId = makeRunId();
  // شناسه‌ی چرخه را همین‌جا می‌سازیم تا در همان لحظه‌ی گرفتن قفل، cycleId
  // روی قفل ثبت شود؛ بازیابی چرخه‌ی مرده (cycle-recovery) با همین cycleId
  // قفل را به چرخه‌ی درست وصل می‌کند. قفل جدید اتمیک است (CAS)؛ برخلاف
  // قفل قدیمی، دو beginCycle هم‌زمان نمی‌توانند هر دو موفق شوند.
  const cycleId = crypto.randomUUID();
  const owner: LockOwner = {
    engine: process.env.CYCLE_ENGINE ?? (process.env.GITHUB_RUN_ID ? 'github-actions' : 'vercel'),
    runId,
  };
  try {
    await acquireLockNew(owner, cycleId);
  } catch (err) {
    // قرارداد API حفظ می‌شود: روت‌ها instanceof CycleLockedError را می‌گیرند (409)
    if (err instanceof LockAcquisitionError) throw new CycleLockedError(err.message);
    throw err;
  }
  const sb = getSupabase();
  const { error } = await sb.from('cycles').insert({ id: cycleId, run_id: runId, status: 'running' });
  if (error) {
    // ردیف چرخه ساخته نشد؛ قفل را پس بده تا چرخه‌ی بعدی گیر نکند
    await releaseLockNew(owner).catch(() => {});
    throw new Error(`failed to create cycle row: ${error.message}`);
  }
  // لایه ۱ دیده‌بان زنده: شروع چرخه (fail-soft)
  await recordEvent(runId, 'orchestrator', 'cycle_started', { run_id: runId });
  return { cycleId, runId };
}

/* ==========================================================================
 * کنترل چرخه: توقف نرم (graceful)، ادامه از همان نقطه، لغو.
 *
 * منطق اجرا (نه فقط لیبل UI) به وضعیت دیتابیس گوش می‌دهد:
 *  - requestPause: running -> pausing. حلقه‌ی اجرا بین موج‌ها این را می‌بیند،
 *    تیم‌های موج جاری را تا انتها می‌دوند (graceful)، بعد وضعیت را paused
 *    می‌کند و بدون شروع موج بعدی منتظر می‌ماند.
 *  - resumeCycle: paused -> running. اگر حلقه‌ی درون‌حافظه‌ای زنده باشد همان
 *    حلقه از همان موج ادامه می‌دهد؛ اگر سرور ری‌استارت شده بود، موج‌های
 *    باقی‌مانده در پس‌زمینه از همان نقطه از سر گرفته می‌شوند.
 *  - cancelCycle: فعال -> canceled و آزاد شدن قفل. حلقه‌ی اجرا در اولین
 *    ایست‌بازرسی، چرخه را با وضعیت canceled می‌بندد.
 * ========================================================================== */

/** خواندن وضعیت فعلی چرخه از دیتابیس (نرمال‌شده). */
async function readCycleStatus(cycleId: string): Promise<CycleStatus | null> {
  const { data, error } = await getSupabase()
    .from('cycles')
    .select('status')
    .eq('id', cycleId)
    .maybeSingle();
  if (error || !data) return null;
  return normalizeCycleStatus((data as { status: string }).status);
}

async function setCycleStatus(cycleId: string, status: CycleStatus): Promise<void> {
  const { error } = await getSupabase().from('cycles').update({ status }).eq('id', cycleId);
  if (error) throw new Error(`failed to set cycle status: ${error.message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ضربان قفل در حلقه‌ی انتظار pause: قفل را تازه نگه می‌دارد تا stale حساب
 * نشود. برخلاف نسخه‌ی قدیمی (writeLock بدون بررسی مالکیت و raceدار)، فقط
 * با هویت دارنده‌ی فعلی قفل heartbeat می‌زند؛ اگر قفل دست چرخه‌ی دیگری
 * باشد، چیزی نمی‌نویسد. fail-soft است تا حلقه‌ی انتظار نشکند.
 */
async function touchPausedLock(cycleId: string): Promise<void> {
  try {
    const lock = await readLockNew();
    const st = lock?.state;
    if (!st || st.status !== 'running' || !st.owner) return;
    if (st.cycleId && st.cycleId !== cycleId) return; // مال چرخه‌ی دیگری است
    await touchLock(st.owner);
  } catch (err) {
    console.error('[orchestrator] touchPausedLock failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * ایست‌بازرسی قبل از هر موج. اگر توقف خواسته شده بود، graceful صبر می‌کند
 * تا ادامه یا لغو برسد. خروجی 'canceled' یعنی چرخه باید بسته شود.
 */
async function checkpointBeforeWave(
  cycleId: string,
  runId: string,
): Promise<'continue' | 'canceled'> {
  let status = await readCycleStatus(cycleId);
  if (status === 'canceled') return 'canceled';
  if (status === 'pausing') {
    await setCycleStatus(cycleId, 'paused');
    status = 'paused';
  }
  if (status === 'paused') {
    // تیم‌های موج جاری تمام شده‌اند؛ موج بعدی شروع نمی‌شود تا ادامه یا لغو برسد.
    for (;;) {
      await touchPausedLock(cycleId);
      await sleep(PAUSE_POLL_MS);
      const s = await readCycleStatus(cycleId);
      if (s === 'canceled') return 'canceled';
      if (s === 'running') return 'continue';
      // در غیر این صورت (paused/pausing) همچنان منتظر می‌مانیم.
    }
  }
  return 'continue';
}

/** درخواست توقف نرم: فقط از وضعیت running به pausing می‌رود. */
export async function requestPause(cycleId: string): Promise<void> {
  const status = await readCycleStatus(cycleId);
  if (status === null) throw new Error('چرخه پیدا نشد.');
  if (status === 'paused' || status === 'pausing') return; // از قبل متوقف است
  if (status !== 'running') {
    throw new Error(`فقط چرخهٔ در حال اجرا را می‌توان متوقف کرد (وضعیت فعلی: ${status}).`);
  }
  await setCycleStatus(cycleId, 'pausing');
}

/** ادامهٔ چرخهٔ متوقف‌شده از همان نقطه. */
export async function resumeCycle(cycleId: string): Promise<void> {
  const sb = getSupabase();
  const { data: cycle, error } = await sb
    .from('cycles')
    .select('run_id, status')
    .eq('id', cycleId)
    .maybeSingle();
  if (error || !cycle) throw new Error('چرخه پیدا نشد.');
  const row = cycle as { run_id: string; status: string };
  const status = normalizeCycleStatus(row.status);
  if (status === 'running') return; // از قبل در حال اجراست
  if (status !== 'paused' && status !== 'pausing') {
    throw new Error(`فقط چرخهٔ متوقف‌شده را می‌توان ادامه داد (وضعیت فعلی: ${status}).`);
  }
  await setCycleStatus(cycleId, 'running');

  // قفل را تازه نگه می‌داریم تا ورکر گیت‌هاب اکشنز در تیک بعدی چرخه را ادامه دهد.
  // فقط اگر قفل هنوز دست همین چرخه است ضربان می‌زنیم؛ هرگز قفل چرخه‌ی
  // دیگری را نمی‌دزدیم. fail-soft است چون سیگنال اصلی، وضعیت cycles است.
  try {
    const lock = await readLockNew();
    const st = lock?.state;
    if (st?.status === 'running' && st.owner && (!st.cycleId || st.cycleId === cycleId)) {
      await touchLock(st.owner);
    }
  } catch (err) {
    console.error(
      '[orchestrator] resumeCycle: lock refresh failed (continuing):',
      err instanceof Error ? err.message : err,
    );
  }
}

/** لغو چرخهٔ فعال: وضعیت canceled + آزاد شدن قفل. حلقه‌ی اجرا در اولین ایست‌بازرسی می‌ایستد. */
export async function cancelCycle(cycleId: string): Promise<void> {
  const status = await readCycleStatus(cycleId);
  if (status === null) throw new Error('چرخه پیدا نشد.');
  if (status === 'canceled') return;
  if (!ACTIVE_CYCLE_STATUSES.includes(status)) {
    throw new Error(`این چرخه دیگر فعال نیست (وضعیت فعلی: ${status}).`);
  }
  const sb = getSupabase();
  const { error } = await sb
    .from('cycles')
    .update({
      status: 'canceled',
      finished_at: new Date().toISOString(),
      error: 'لغو شده توسط کاربر',
    })
    .eq('id', cycleId);
  if (error) throw new Error(`failed to cancel cycle: ${error.message}`);
  // آزادسازی قفل بدون توجه به مالکیت (لغو دستی از داشبورد)؛
  // فقط اگر قفل مال همین چرخه باشد تا قفل چرخه‌ی تازه‌ای آزاد نشود.
  await forceReleaseLock(cycleId, 'cancelCycle');
}

/** آیا چرخهٔ فعالی (running/pausing/paused) در دیتابیس هست؟ */
export async function findActiveCycle(): Promise<{
  id: string;
  run_id: string;
  status: CycleStatus;
} | null> {
  const { data, error } = await getSupabase()
    .from('cycles')
    .select('id, run_id, status')
    .in('status', ACTIVE_CYCLE_STATUSES)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { id: string; run_id: string; status: string };
  return { id: row.id, run_id: row.run_id, status: normalizeCycleStatus(row.status) };
}

/** ایمپورت داینامیک ماژول تیم؛ اگر ماژول نیست، خطای واضح می‌دهد (بلاک نمی‌شود). */
async function loadRunTeam(team: TeamName): Promise<RunTeamFn> {
  try {
    const mod = (await import(`./teams/${team}`)) as { runTeam?: unknown };
    if (typeof mod.runTeam !== 'function') {
      throw new Error(`does not export an async runTeam(input) function`);
    }
    return mod.runTeam as RunTeamFn;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `cannot run team "${team}": failed to load lib/teams/${team}.ts (${reason}). ` +
        `Make sure lib/teams/${team}.ts exists and exports async runTeam(input).`,
    );
  }
}

/** حافظه‌ی تیم از جدول team_memory (آخرین ورودی‌های هر kind). */
async function loadTeamMemory(team: TeamName): Promise<MemoryEntry[]> {
  try {
    const { data, error } = await getSupabase()
      .from('team_memory')
      .select('team, kind, content')
      .eq('team', team)
      .order('created_at', { ascending: false })
      .limit(30);
    if (error || !data) return [];
    const seen = new Set<string>();
    const out: MemoryEntry[] = [];
    for (const row of data as { team: string; kind: string; content: string }[]) {
      if (seen.has(row.kind)) continue;
      seen.add(row.kind);
      out.push({ team: row.team as TeamName, key: row.kind, value: row.content });
    }
    return out;
  } catch {
    return [];
  }
}

/** زمینه‌ی متنی از خلاصه‌ی خروجی موج‌های قبلی. */
function buildRagContext(previousWavesOutput: Record<string, TeamResult | null>): string {
  const lines: string[] = [];
  for (const [team, result] of Object.entries(previousWavesOutput)) {
    if (result?.summary) lines.push(`- ${team}: ${result.summary}`);
  }
  return lines.join('\n');
}

interface WaveCtx {
  runId: string;
  previousWavesOutput: Record<string, TeamResult | null>;
  /**
   * شمارهٔ تلاش اصلاح در همین چرخه (۱ = اجرای اول).
   * وقتی تیمی در همین چرخه رد/ناموفق شده و دوباره اجرا می‌شود، > ۱ است
   * (حلقهٔ اصلاح درون‌چرخه‌ای؛ دستور مسعود، ۱۴۰۵/۰۷/۲۶).
   */
  fixAttempt?: number;
  /**
   * دستور اصلاح به‌جامانده از رد/خطای قبلی همین چرخه؛ در دور اولِ تلاش
   * اصلاح به‌عنوان دستور رهبر به زمینه تزریق می‌شود (بالاترین اولویت).
   */
  priorFixDirective?: string;
}

export interface RunWavesOptions {
  /** تیم‌هایی که رد می‌شوند؛ کلید به شکل `${wave}:${team}` (برای ادامه از همان نقطه). */
  skip?: Set<string>;
  /**
   * خروجی تیم‌های از قبل تمام‌شده در ادامهٔ چرخه؛ فقط برای موج‌های قبل‌تر
   * از موج جاری به زمینه اضافه می‌شود.
   */
  prefill?: Map<string, { wave: number; result: TeamResult | null }>;
}

/**
 * ثبت پچ پیشنهادی تیم در جدول bridge_patches با وضعیت proposed.
 * طرح جدول (ساختهٔ مهندس دیتابیس، supabase/migrations/20261015200000_bridge_patches.sql):
 * یک ردیف برای هر تیم در هر چرخه؛ files آرایهٔ JSON از {path, content} است.
 * اگر جدول هنوز اعمال نشده (خطای 42P01)، فقط در لاگ ثبت می‌شود؛
 * این قدم هرگز نتیجهٔ تیم را خراب نمی‌کند.
 * برمی‌گرداند: شناسهٔ ردیف پچ، یا null اگر ثبتی انجام نشد.
 */
async function registerProposedPatches(
  sb: ReturnType<typeof getSupabase>,
  opts: {
    team: TeamName;
    cycleId: string;
    runId: string;
    summary: string;
    patches: PatchFile[] | undefined;
  },
): Promise<string | null> {
  const files = (opts.patches ?? [])
    .filter(
      (p) =>
        p &&
        typeof p.path === 'string' &&
        p.path.trim().length > 0 &&
        typeof p.content === 'string',
    )
    .map((p) => ({
      path: p.path.trim().replace(/^\/+/, ''),
      content: p.content,
    }));
  if (files.length === 0) return null;
  const { data, error } = await sb
    .from('bridge_patches')
    .insert({
      team: opts.team,
      cycle_id: opts.cycleId,
      summary: opts.summary.slice(0, 2000),
      files,
      status: 'proposed',
    })
    .select('id')
    .single();
  if (error) {
    // 23505 = پچ این تیم در این چرخه از قبل ثبت شده (تلاش مجدد ورکر)؛
    // به‌جای خطا، شناسهٔ ردیف موجود را برمی‌گردانیم تا پچ تکراری ساخته نشود.
    if (error.code === '23505') {
      const { data: existing } = await sb
        .from('bridge_patches')
        .select('id')
        .eq('team', opts.team)
        .eq('cycle_id', opts.cycleId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      const existingId = (existing as { id?: string } | null)?.id ?? null;
      console.log(
        `[orchestrator] پچ تیم ${opts.team} در چرخه ${opts.runId} از قبل ثبت شده بود (id=${existingId})؛ ثبت تکراری رد شد.`,
      );
      return existingId;
    }
    if (error.code === '42P01') {
      console.error(
        `[orchestrator][DB-ENGINEER] جدول bridge_patches هنوز اعمال نشده؛ ` +
          `${files.length} فایل پیشنهادی تیم ${opts.team} در چرخه ${opts.runId} ثبت نشد. ` +
          `مهندس دیتابیس: مایگریشن supabase/migrations/20261015200000_bridge_patches.sql را اعمال کن.`,
      );
    } else {
      console.error(
        `[orchestrator] ثبت bridge_patches برای تیم ${opts.team} خطا داد:`,
        error.message,
      );
    }
    return null;
  }
  const patchId = (data as { id?: string } | null)?.id ?? null;
  console.log(
    `[orchestrator] پچ پیشنهادی تیم ${opts.team} (${files.length} فایل) در bridge_patches با وضعیت proposed ثبت شد (id=${patchId}).`,
  );
  return patchId;
}

/**
 * پردازش خودکار پچ پل: دروازه کیفیت ← کامیت ← مرج خودکار به dev.
 * دستور مسعود: بدون تأیید دستی. کاملاً best-effort؛ هرگز نتیجهٔ تیم را خراب نمی‌کند.
 */
async function autoProcessBridgePatch(patchId: string, team: TeamName): Promise<void> {
  try {
    const { processProposedPatch } = await import('./bridge/propose');
    const res = await processProposedPatch(patchId);
    if (!res.gated) {
      console.log(
        `[orchestrator] پچ ${patchId} تیم ${team} در دروازه رد شد (needs_review)؛ چرخه ادامه می‌یابد.`,
      );
      return;
    }
    if (res.merged) {
      console.log(
        `[orchestrator] پچ ${patchId} تیم ${team} خودکار به dev مرج شد (merge_sha=${res.mergeSha ?? 'already'}).`,
      );
    } else {
      console.log(
        `[orchestrator] پچ ${patchId} تیم ${team} کامیت شد ولی مرج خودکار ناموفق بود: ${res.mergeError ?? 'نامشخص'}.`,
      );
    }
  } catch (err) {
    console.error(
      `[orchestrator] پردازش خودکار پچ ${patchId} تیم ${team} خطا داد:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** اجرای یک تیم و ثبت نتیجه در team_runs. خطا => team_run=failed، ولی موج ادامه می‌یابد. */
export async function runSingleTeam(
  cycleId: string,
  team: TeamName,
  wave: number,
  ctx: WaveCtx,
  teamRunId?: string,
): Promise<TeamResult | null> {
  const sb = getSupabase();
  let runRowId: string;
  if (teamRunId) {
    // ردیف از قبل با claimTeam اتمیک ساخته شده؛ فقط استفاده کن
    runRowId = teamRunId;
  } else {
    // claim اتمیک از lib/lock.ts (ایندکس یکتای team_runs_one_running_per_team):
    // اگر ورکر دیگری هم‌زمان همین تیم را برداشت، null برمی‌گردد و این اجرا
    // بی‌صدا رد می‌شود؛ برخلاف insert خام قبلی که race داشت و throw می‌کرد.
    const claimed = await claimTeamAtomic(cycleId, team, wave, {
      engine: 'orchestrator',
      runId: ctx.runId,
    });
    if (!claimed) {
      console.log(`[orchestrator] team ${team} already claimed by another worker; skipping`);
      return null;
    }
    runRowId = claimed;
  }

  // لایه ۱ دیده‌بان زنده: شروع تیم + کرونومتر مدت اجرا (همه fail-soft)
  const teamStartMs = Date.now();
  await recordEvent(ctx.runId, team, 'team_started', {
    wave,
    team_run_id: runRowId,
  });

  const finish = async (patch: Record<string, unknown>) => {
    const { error } = await sb
      .from('team_runs')
      .update({ ...patch, finished_at: new Date().toISOString() })
      .eq('id', runRowId);
    if (error) console.error(`[orchestrator] failed to update team_run ${runRowId}:`, error.message);
  };

  /** بستن همه‌ی ساب‌ایجنت‌های باز این اجرا با وضعیت نهایی. */
  const closeSubagents = async (status: 'success' | 'failed' | 'stopped') => {
    const { error } = await sb
      .from('subagents')
      .update({ status, finished_at: new Date().toISOString() })
      .eq('team_run_id', runRowId)
      .in('status', ['pending', 'running', 'paused']);
    if (error) console.error(`[orchestrator] failed to close subagents of ${runRowId}:`, error.message);
  };

  /** خواندن سیگنال کنترلی یک ساب‌ایجنت (run/pause/stop). */
  const readControl = async (subagentId: string): Promise<SubagentControl> => {
    const { data } = await sb.from('subagents').select('control').eq('id', subagentId).maybeSingle();
    const control = (data as { control?: string } | null)?.control;
    return control === 'pause' || control === 'stop' ? control : 'run';
  };

  /**
   * اعمال کنترل کاربر در مرز مرحله: اگر ساب‌ایجنت متوقف (pause) شده،
   * تا ادامه‌یافتن (resume) صبر می‌کند؛ اگر stop شده، SubagentStoppedError می‌دهد.
   * کنترل روی مرحله‌ای که هم‌اکنون در حال اجراست اثر نمی‌گذارد؛ از مرحله‌ی
   * بعدی اعمال می‌شود (محدودیت صادقانه‌ی معماری مرحله‌ای).
   */
  const enforceControl = async (subagentId: string, label: string): Promise<void> => {
    const deadline = Date.now() + PAUSE_TIMEOUT_MS;
    for (;;) {
      const control = await readControl(subagentId);
      if (control === 'run') {
        await sb.from('subagents').update({ status: 'running' }).eq('id', subagentId);
        return;
      }
      if (control === 'stop') {
        await sb
          .from('subagents')
          .update({ status: 'stopped', finished_at: new Date().toISOString() })
          .eq('id', subagentId);
        throw new SubagentStoppedError(label);
      }
      // pause: وضعیت را «متوقف‌شده» نشان بده و منتظر بمان
      await sb.from('subagents').update({ status: 'paused' }).eq('id', subagentId);
      if (Date.now() > deadline) {
        throw new SubagentStoppedError(`${label} (پایان مهلت انتظار برای ادامه)`);
      }
      await new Promise((resolve) => setTimeout(resolve, CONTROL_POLL_MS));
    }
  };

  // گزارش زنده‌ی پیشرفت: تیم در مرز مرحله‌هایش صدا می‌زند. اینجا:
  //  ۱. team_runs به‌روز می‌شود (progress/current_task)؛
  //  ۲. ساب‌ایجنت مرحله در جدول subagents ساخته/به‌روز می‌شود؛
  //  ۳. سیگنال کنترلی کاربر (توقف/ادامه/توقف کامل) اعمال می‌شود.
  // تریگر دیتابیس updated_at را هم تازه می‌کند.
  let lastPct = -1;
  let lastTask = '';
  let lastWriteAt = 0;
  const reportProgress: ProgressReporter = async (task, progress) => {
    const pct = Math.max(0, Math.min(100, Math.round(progress)));
    const now = Date.now();
    if (pct === lastPct && task === lastTask) return;
    if (pct < 100 && now - lastWriteAt < PROGRESS_MIN_INTERVAL_MS && pct <= lastPct) return;
    lastPct = pct;
    lastTask = task;
    lastWriteAt = now;
    const { error } = await sb
      .from('team_runs')
      .update({ progress: pct, current_task: task.slice(0, 500) })
      .eq('id', runRowId);
    if (error) console.error(`[orchestrator] failed to report progress for ${team}:`, error.message);

    if (PSEUDO_TASKS.has(task)) return;
    // ساب‌ایجنت این مرحله: بساز یا بیاور، بعد کنترل کاربر را اعمال کن.
    const { data: existing } = await sb
      .from('subagents')
      .select('id')
      .eq('team_run_id', runRowId)
      .eq('label', task)
      .maybeSingle();
    let subagentId = (existing as { id?: string } | null)?.id;
    if (!subagentId) {
      const { data: created, error: createErr } = await sb
        .from('subagents')
        .insert({
          team_run_id: runRowId,
          team,
          label: task,
          status: 'running',
          current_task: task.slice(0, 500),
          progress: pct,
        })
        .select('id')
        .single();
      if (createErr || !created) {
        console.error(`[orchestrator] failed to create subagent row:`, createErr?.message);
        return;
      }
      subagentId = created.id as string;
    }
    await enforceControl(subagentId, task);
    // مرحله‌ی قبلی تمام شد؛ بقیه‌ی «در حال اجرا»ها بسته می‌شوند.
    // صادقانه: اگر لیبل مرحله نشان‌دهندهٔ خطا/تلاش مجدد است، «موفق» ثبت نمی‌شود؛
    // «خطا» ثبت می‌شود تا داشبورد گمراه‌کننده نباشد (دستور مسعود: وضعیت باید نتیجهٔ واقعی را نشان بدهد).
    const { data: prevRunning } = await sb
      .from('subagents')
      .select('id, label')
      .eq('team_run_id', runRowId)
      .eq('status', 'running')
      .neq('id', subagentId);
    const nowIso = new Date().toISOString();
    for (const prev of prevRunning ?? []) {
      const label = (prev as { label?: string }).label ?? '';
      const isErrorStep = /خطا|ناموفق|شکست|error|failed/i.test(label);
      const { error: closeOneErr } = await sb
        .from('subagents')
        .update({ status: isErrorStep ? 'failed' : 'success', finished_at: nowIso })
        .eq('id', (prev as { id: string }).id);
      if (closeOneErr) console.error('[orchestrator] failed to close previous subagent:', closeOneErr.message);
    }
    await sb
      .from('subagents')
      .update({ current_task: task.slice(0, 500), progress: pct })
      .eq('id', subagentId);
  };

  // ضربانِ زنده‌بودن: هر ۶۰ ثانیه فقط heartbeat_at نوشته می‌شود.
  // عمداً updated_at لمس نمی‌شود تا «زنده‌بودن فرایند» از «پیشرفت واقعی»
  // جدا بماند؛ وگرنه نگهبان (واچ‌داگ/ورکر) تیمِ هنگ‌کرده‌ی ضربان‌زن را
  // «سالم» می‌بیند. تریگر دیتابیس هم همین جدایی را تضمین می‌کند.
  const heartbeat = setInterval(() => {
    void sb
      .from('team_runs')
      .update({ heartbeat_at: new Date().toISOString() })
      .eq('id', runRowId)
      .then(({ error }) => {
        if (error) console.error(`[orchestrator] heartbeat failed for ${team}:`, error.message);
      });
  }, HEARTBEAT_MS);
  if (typeof heartbeat === 'object' && 'unref' in heartbeat) {
    (heartbeat as unknown as { unref(): void }).unref();
  }

  // رفع ریشه‌ای زامبی‌شدن صف (مشکل ۲): تسک claimشده باید در پایان هر اجرا
  // (موفق/ردشده/ناموفق/متوقف/ناتمام) حتماً done شود. شناسه بیرون از بلوک
  // claim نگه داشته می‌شود؛ settleClaimedTaskOnce با گارد once از مسیرهای
  // صریح صدا زده می‌شود و finally هم تور آخر است | هیچ مسیری جا نمی‌ماند.
  // گارد محلی فقط پس از موفقیت واقعی ست می‌شود تا خطای گذرای دیتابیس،
  // تلاش مجدد در finally را از بین نبرد.
  let claimedTask: { id: string; title: string } | null = null;
  let claimedTaskSettled = false;
  const settleClaimedTaskOnce = async (
    outcome: ClaimedTaskOutcome,
    summary: string,
  ): Promise<void> => {
    if (!claimedTask || claimedTaskSettled) return;
    try {
      await settleClaimedTask(claimedTask.id, outcome, {
        team,
        title: claimedTask.title,
        summary,
      });
      claimedTaskSettled = true;
      console.log(
        `[orchestrator] تسک claimشدهٔ تیم ${team} با سرنوشت «${outcome}» بسته شد (id=${claimedTask.id})`,
      );
    } catch (err) {
      console.error(
        `[orchestrator] بستن تسک claimشده ${claimedTask.id} خطا داد:`,
        err instanceof Error ? err.message : err,
      );
    }
  };

  try {
    await reportProgress('شروع اجرا', 5);
    // ساب‌ایجنت دانش: گردآوری نکته‌های تازه از منابع معتبر، قبل از سرپرست.
    // fail-soft: هر خطایی نادیده گرفته می‌شود و تیم با دانش قبلی جلو می‌رود.
    let knowledgeSnippet = '';
    try {
      await reportProgress('دانش: گردآوری', 8);
      const knowledgeResult = await runKnowledgeSubagent(
        team,
        ctx.runId,
        buildRagContext(ctx.previousWavesOutput),
        reportProgress,
      );
      if (knowledgeResult.contextSnippet) {
        knowledgeSnippet = `\n\nیافته‌های تازهٔ دانش این چرخه:\n${knowledgeResult.contextSnippet}`;
      }
      if (knowledgeResult.summary) {
        console.log(`[orchestrator] ساب‌ایجنت دانش تیم ${team}: ${knowledgeResult.summary}`);
      }
    } catch (err) {
      console.error(
        `[orchestrator] ساب‌ایجنت دانش تیم ${team} خطا داد (نادیده گرفته شد):`,
        err instanceof Error ? err.message : err,
      );
    }
    const { resetLLMStats, getLLMStats } = await import('./llm');
    resetLLMStats();
    const runTeam = await loadRunTeam(team);
    const memory = await loadTeamMemory(team);
    // قدم ۳: تحویل اتمیک تسک از صف ساخت. اگر تسک بود، بریف آن (عنوان/شرح/معیار
    // قبولی) به ورودی تیم تزریق می‌شود؛ اگر نبود، رفتار فعلی (حدسی) حفظ می‌شود.
    let claimedTaskContext = '';
    try {
      const claimed = await claimNextTaskForTeam(team);
      if (claimed && isValidTaskId(claimed.id)) {
        // شناسه بیرون نگه داشته می‌شود تا در پایان اجرا (هر سرنوشتی) بسته شود.
        claimedTask = { id: claimed.id, title: claimed.title };
        claimedTaskContext =
          `\n\nکار تحویل‌شده از صف ساخت (در اولویت اجرا):\n` +
          `عنوان: ${claimed.title}\n` +
          `شرح: ${(claimed.description ?? '').trim() || 'ثبت نشده'}\n` +
          `معیار قبولی: ${(claimed.acceptance ?? '').trim() || 'ثبت نشده'}\n`;
        console.log(`[orchestrator] تیم ${team}: کار «${claimed.title}» از صف claim شد (id=${claimed.id})`);
        const { error: curErr } = await sb
          .from('team_runs')
          .update({ current_task: `کار صف: ${claimed.title}`.slice(0, 500) })
          .eq('id', runRowId);
        if (curErr) console.error(`[orchestrator] failed to set current_task for ${team}:`, curErr.message);
      } else if (claimed) {
        // تور آخر دفاعی: نباید رخ دهد (گارد در claimNextTaskForTeam)، ولی اگر
        // ردیفی نامعتبر رسید، با لاگ تمیز نادیده گرفته می‌شود؛ شناسه‌ای ذخیره
        // نمی‌شود تا completeTask هرگز با id نامعتبر صدا زده نشود.
        console.log(`[orchestrator] تیم ${team}: خروجی claim معتبر نبود؛ نادیده گرفته شد.`);
      }
    } catch (err) {
      console.error(
        `[orchestrator] claim تسک برای تیم ${team} خطا داد (رفتار فعلی حفظ شد):`,
        err instanceof Error ? err.message : err,
      );
    }
    // کارهای تأییدشدهٔ این تیم («برود در چرخه») در اولویت زمینهٔ اجرا قرار می‌گیرند.
    let approvedContext = '';
    try {
      const approved = await listApprovedTasksForTeam(team);
      if (approved.length > 0) {
        const lines = approved.map(
          (t) => `- ${t.title}: ${(t.description ?? '').slice(0, 300)}`,
        );
        approvedContext = `\n\nکارهای تأییدشدهٔ در انتظار این تیم (در اولویت انجام):\n${lines.join('\n')}`;
      }
    } catch (err) {
      console.error(`[orchestrator] failed to load approved tasks for ${team}:`, err instanceof Error ? err.message : err);
    }
    const baseRagContext =
      buildRagContext(ctx.previousWavesOutput) + claimedTaskContext + approvedContext + knowledgeSnippet;
    // دانش ذخیره‌شده تیم (قانون مسعود): همه تیم‌ها باید از دانششان استفاده کنند.
    // به‌جای تکیه بر input.memory (که ۱۱ تیم نادیده می‌گرفتند)، مستقیم در ragContext تزریق می‌شود.
    let teamKnowledgeContext = '';
    if (memory.length > 0) {
      const memLines = memory.map((m) => `- [${m.key}] ${String(m.value).slice(0, 500)}`);
      teamKnowledgeContext = `\n\nدانش ذخیره‌شده تیم ${team} (حتماً در کارت استفاده کن):\n${memLines.join('\n')}`;
      console.log(`[orchestrator] دانش تیم ${team}: ${memory.length} قلم تزریق شد`);
    } else {
      console.log(`[orchestrator] تیم ${team}: دانش ذخیره‌شده‌ای ندارد`);
    }
    const fullRagContext = baseRagContext + teamKnowledgeContext;
    // حلقهٔ اصلاح درون‌چرخه‌ای (دستور مسعود، ۱۴۰۵/۰۷/۲۶): اگر این اجرا
    // تلاش مجددِ همین چرخه است (تیم قبلاً رد/ناموفق شده)، شمارهٔ تلاش و
    // دستور به‌جامانده از قبل را از ctx می‌خوانیم. لاگ شفاف تا در مانیتور
    // معلوم باشد کدام تیم دارد در همین چرخه اصلاح می‌شود.
    const fixAttempt = Math.max(1, ctx.fixAttempt ?? 1);
    const priorFixDirective = (ctx.priorFixDirective ?? '').trim() || undefined;
    if (fixAttempt > 1) {
      console.log(
        `[fix-loop] team ${team}: same-cycle fix attempt ${fixAttempt}/${MAX_SAME_CYCLE_FIX_ATTEMPTS}` +
          (priorFixDirective ? ' (prior directive injected)' : ' (no prior directive)'),
      );
      await reportProgress(`تلاش اصلاح ${fixAttempt} در همین چرخه`, 6);
    }
    // چرخهٔ جدید (دستور مسعود، ۱۴۰۵/۰۷/۲۴): اجرای یک‌باره + گیت خروجی +
    // چک سادهٔ رهبر («کار می‌کنه؟»)؛ در صورت رد، حداکثر ۱ دور اصلاح با
    // دستور مشخص. بدون حلقهٔ ۳دوره‌ای.
    const { validateWorkerOutput } = await import('./critic-loop');
    const checkLog: Array<{
      round: number;
      approved: boolean;
      reason: string;
      directive?: string;
    }> = [];

    const runTeamOnce = async (fixRound: number, directive?: string): Promise<TeamResult> => {
      // حلقهٔ اصلاح درون‌چرخه‌ای (دستور مسعود، ۱۴۰۵/۰۷/۲۶): در تلاش‌های
      // اصلاح (fixAttempt>1)، دستور به‌جامانده از رد/خطای قبلیِ همین چرخه
      // بالاترین اولویت را دارد و به دور اول تزریق می‌شود تا تیم دقیقاً
      // همان ایراد را برطرف کند، نه اینکه از صفر حدس بزند.
      const effectiveDirective =
        fixRound === 0 && priorFixDirective ? priorFixDirective : directive;
      const directivePrefix = effectiveDirective
        ? `\n\nدستور رهبر برای دور اصلاح (خروجی دور قبل رد شد):\n${effectiveDirective}\n`
        : '';
      const input: TeamInput = {
        cycleId,
        runId: ctx.runId,
        ragContext: directivePrefix + fullRagContext,
        memory,
        previousWavesOutput: { ...ctx.previousWavesOutput },
        reportProgress,
        round: fixRound + 1,
        reviewDirective: effectiveDirective,
      };
      if (fixRound > 0) {
        await reportProgress('دور اصلاح با دستور رهبر', 10);
      }
      // Ambient team context: every callLLM inside runTeam automatically uses
      // this team's configured endpoint + model (settings: llm_endpoints/team_models).
      return runWithTeamContext(team, () => runTeam(input));
    };

    const checkOutput = async (round: number, output: TeamResult): Promise<void> => {
      const gate = validateWorkerOutput(output);
      const check = gate.valid
        ? await runSimpleCheck(team, output)
        : {
            pass: false,
            note: `گیت خروجی: ${gate.detail}`,
            fixDirective: `خروجی نامعتبر است (${gate.detail}). خروجی کامل و معتبر تولید کن.`,
          };
      checkLog.push({
        round,
        approved: check.pass,
        reason: check.note,
        ...(check.fixDirective ? { directive: check.fixDirective.slice(0, 2000) } : {}),
      });
    };

    // دور ۱: اجرای اول + گیت خروجی + چک سادهٔ رهبر
    let result = await runTeamOnce(0);
    await checkOutput(1, result);

    // دور ۲ (حداکثر ۱ دور اصلاح): فقط اگر رد شد و دستور اصلاح مشخص داریم
    const lastCheck = checkLog[checkLog.length - 1];
    if (!lastCheck.approved && lastCheck.directive) {
      result = await runTeamOnce(1, lastCheck.directive);
      await checkOutput(2, result);
    }
    const finalCheck = checkLog[checkLog.length - 1];
    if (!finalCheck) {
      throw new Error(`اجرای تیم ${team} هیچ نتیجه‌ای تولید نکرد`);
    }
    const llmCalls = getLLMStats().total;
    // چک سادهٔ رهبر تعیین‌کنندهٔ نهایی است: رد بعد از دور اصلاح → rejected
    if (!finalCheck.approved) {
      // حلقهٔ اصلاح درون‌چرخه‌ای (دستور مسعود، ۱۴۰۵/۰۷/۲۶): اگر سقف تلاش
      // در همین چرخه خورده، تیم «مسدود» ثبت می‌شود — نه بی‌صدا به چرخهٔ
      // بعد موکول می‌شود، نه بی‌دلیل رها می‌شود. دلیلش مشخص و اجرایی است.
      const fixLoopNote =
        fixAttempt >= MAX_SAME_CYCLE_FIX_ATTEMPTS
          ? ` پس از ${fixAttempt} تلاش اصلاح در همین چرخه همچنان مردود است و «مسدود» ثبت شد (به چرخهٔ بعد موکول نشد)؛ نیاز به بررسی جدی علت دارد.`
          : ` (تلاش اصلاح ${fixAttempt} از ${MAX_SAME_CYCLE_FIX_ATTEMPTS} در همین چرخه؛ در ادامهٔ همین چرخه دوباره تلاش می‌شود).`;
      result = {
        ...result,
        approved: false,
        summary: `${result.summary ?? ''}\n\nرد شد در چک رهبر: ${finalCheck.reason}${fixLoopNote}`.trim(),
      };
    }
    // تفکیک «رد رهبر» از «خطای سیستمی» (دستور مسعود):
    // - approved=false یعنی تیم بدون خطای سیستمی اجرایش را تمام کرد ولی رهبر خروجی را رد کرد → 'rejected'
    // - 'failed' فقط برای خطای واقعی (exception، تایم‌اوت، خطای LLM) در بلوک catch پایین می‌ماند
    const teamStatus: TeamRunStatus = result.approved === false ? 'rejected' : 'success';
    // ساب‌ایجنت‌ها کارشان را تمام کرده‌اند؛ رد رهبر خطای آن‌ها نیست
    await closeSubagents('success');
    // تیم ۹: ردیابی استفاده از دانش | کدام چانک‌ها تزریق شدند و آیا مفید بودند؟
    try {
      const { getLastRetrievedChunkIds, recordKnowledgeUsage } = await import('./rag');
      const usedChunkIds = getLastRetrievedChunkIds(team);
      if (usedChunkIds.length > 0) {
        await recordKnowledgeUsage(usedChunkIds, runRowId, teamStatus === 'success');
      }
    } catch {
      // best-effort: خطای ردیابی دانش نباید نتیجه تیم را خراب کند
    }
    await finish({
      status: teamStatus,
      progress: 100,
      current_task:
        teamStatus === 'rejected'
          ? `رد شد در چک رهبر (${finalCheck.reason.slice(0, 200)})`
          : 'پایان کار',
      output_summary: result.summary?.slice(0, 4000) ?? null,
      error: teamStatus === 'rejected' ? (result.summary?.slice(0, 4000) ?? null) : null,
      llm_calls: llmCalls,
      // لاگ چک سادهٔ رهبر (دستور مسعود): دور، تأیید/رد، دلیل، دستور اصلاح
      review_rounds: checkLog,
    });
    // بستن قطعی تسک claimشده (مشکل ۲): موفق یا ردشده، هر دو done می‌شوند؛
    // سرنوشت واقعی در result ثبت می‌ماند. best-effort: خطایش نتیجه تیم را خراب نمی‌کند.
    await settleClaimedTaskOnce(
      teamStatus === 'success' ? 'success' : 'rejected',
      result.summary?.slice(0, 4000) ?? '(خلاصه‌ای ثبت نشد)',
    );
    // دروازه ثبت پچ (دستور مسعود): فقط پچ تیم موفقِ تأییدشده وارد پل می‌شود.
    // تیم ردشده (approved=false → rejected) یا ناموفق (failed) اصلاً در bridge_patches ثبت نمی‌شود.
    if (teamStatus !== 'success') {
      console.log(
        `[orchestrator] پچ تیم ${team} ثبت نشد چون چک رهبر رد کرد (وضعیت: ${teamStatus}).`,
      );
    } else {
      // پچ پیشنهادی تیم → جدول bridge_patches (وضعیت proposed)؛
      // بعد خودکار: دروازه کیفیت ← کامیت ← مرج به dev (بدون تأیید دستی، دستور مسعود).
      // best-effort: هرگز نتیجهٔ تیم را خراب نمی‌کند.
      try {
        // تیم‌ها دو فیلد جدا دارند (patch در dev، patches در content/design/seo)؛ هر دو را می‌گیریم
        const seen = new Set<string>();
        const mergedPatches: PatchFile[] = [];
        for (const p of [...(result.patch ?? []), ...(result.patches ?? [])]) {
          const key = (p?.path ?? '').trim().toLowerCase();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          mergedPatches.push(p);
        }
        const patchId = await registerProposedPatches(sb, {
          team,
          cycleId,
          runId: ctx.runId,
          summary: result.summary ?? '',
          patches: mergedPatches,
        });
        if (patchId) {
          await autoProcessBridgePatch(patchId, team);
        }
      } catch (err) {
        console.error(
          `[orchestrator] خطای غیرمنتظره در پل خودکار تیم ${team}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    // گزارش دوگانه: ثبت در پنل + ارسال به تلگرام (best-effort، مسدودکننده نیست).
    await notifyTeamReport({
      team,
      message: `گزارش تیم در چرخه ${ctx.runId}\n\n${result.summary ?? '(خلاصه‌ای ثبت نشد)'}`,
      cycleId,
    });
    // لایه ۱ دیده‌بان زنده: پایان موفق/ردشده تیم (fail-soft)
    await recordEvent(ctx.runId, team, 'team_finished', {
      wave,
      status: teamStatus,
      duration_ms: Date.now() - teamStartMs,
    });
    // خودترمیمی در لحظه (دستور مسعود): تشخیص الگوی خرابی + ترمیم سیستم/تیم،
    // بدون اثر روی نتیجهٔ این تیم. fail-soft: هرگز خطا پرتاب نمی‌کند.
    try {
      const { checkAndHealTeam } = await import('./self-heal');
      await checkAndHealTeam(team, teamStatus, {
        rejectionReasons: checkLog.filter((r) => !r.approved).map((r) => r.reason),
      });
    } catch {
      /* نادیده: خودترمیمی نباید نتیجه تیم را خراب کند */
    }
    // چرخهٔ یادگیری (دستور مسعود): ثبت درس این اجرا در دانش تیم (fail-soft)
    await recordRunLesson(team, teamStatus, result.summary ?? '');
    return result;
  } catch (err) {
    if (err instanceof SubagentStoppedError) {
      await closeSubagents('stopped');
      await finish({ status: 'stopped', current_task: 'متوقف شد توسط کاربر' });
      await notifyTeamReport({
        team,
        message: `تیم در چرخه ${ctx.runId} توسط کاربر متوقف شد (مرحله: ${err.stage}).`,
        cycleId,
      });
      await settleClaimedTaskOnce(
        'stopped',
        `تیم در چرخه ${ctx.runId} توسط کاربر متوقف شد (مرحله: ${err.stage}).`,
      );
      // لایه ۱ دیده‌بان زنده: پایان با توقف کاربر (fail-soft)
      await recordEvent(ctx.runId, team, 'team_finished', {
        wave,
        status: 'stopped',
        duration_ms: Date.now() - teamStartMs,
      });
      return null;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[orchestrator] team "${team}" failed:`, message);
    // لایه ۱ دیده‌بان زنده: خطای اصلی تیم | فقط پیام، نه استک کامل (fail-soft)
    await recordEvent(ctx.runId, team, 'error', {
      message: message.slice(0, 2000),
    });
    await closeSubagents('failed');
    await finish({ status: 'failed', current_task: 'خطا در اجرا', error: message.slice(0, 4000) });
    await notifyTeamReport({
      team,
      message: `تیم در چرخه ${ctx.runId} ناموفق بود:\n\n${message.slice(0, 1500)}`,
      cycleId,
    });
    await settleClaimedTaskOnce('failed', message.slice(0, 4000));
    // لایه ۱ دیده‌بان زنده: پایان ناموفق تیم (fail-soft)
    await recordEvent(ctx.runId, team, 'team_finished', {
      wave,
      status: 'failed',
      duration_ms: Date.now() - teamStartMs,
    });
    // خودترمیمی در لحظه (دستور مسعود): اگر این خطا الگو شد (۲ بار پیاپی همسان)،
    // مدل تیم خودکار عوض می‌شود. fail-soft.
    try {
      const { checkAndHealTeam } = await import('./self-heal');
      await checkAndHealTeam(team, 'failed', { errorText: message });
    } catch {
      /* نادیده */
    }
    // چرخهٔ یادگیری (دستور مسعود): ثبت درس این اجرای ناموفق در دانش تیم (fail-soft)
    await recordRunLesson(team, 'failed', message);
    return null;
  } finally {
    clearInterval(heartbeat);
    // تور آخر (مشکل ۲): اگر هیچ‌کدام از مسیرهای بالا تسک claimشده را نبستند،
    // اینجا با سرنوشت interrupted بسته می‌شود. گارد once از دوباره‌بستن جلوگیری می‌کند.
    await settleClaimedTaskOnce(
      'interrupted',
      'اجرای تیم بدون رسیدن به نقطهٔ پایانی شناخته‌شده تمام شد.',
    );
  }
}





/** بستن چرخه: ثبت وضعیت نهایی + آمار + آزاد کردن قفل. */
export async function finishCycle(
  cycleId: string,
  status: CycleStatus,
  errorMessage?: string,
): Promise<void> {
  const sb = getSupabase();
  try {
    const { data: cycle } = await sb
      .from('cycles')
      .select('run_id, started_at')
      .eq('id', cycleId)
      .maybeSingle();
    const { data: runs } = await sb
      .from('team_runs')
      .select('team, status, llm_calls, started_at')
      .eq('cycle_id', cycleId);
    const rows = (runs ?? []) as { team: string; status: string; llm_calls: number; started_at: string }[];
    // حلقهٔ اصلاح درون‌چرخه‌ای ممکن است برای یک تیم چند ردیف بسازد؛
    // آمار چرخه فقط «آخرین» اجرای هر تیم را می‌شمارد، نه همهٔ تلاش‌ها را.
    const latest = new Map<string, { status: string; llm_calls: number }>();
    const attempts = new Map<string, number>();
    for (const r of rows) {
      latest.set(r.team, { status: r.status, llm_calls: r.llm_calls ?? 0 });
      attempts.set(r.team, (attempts.get(r.team) ?? 0) + 1);
    }
    // خلاصهٔ حلقه‌های اصلاح این چرخه (دستور مسعود): کدام تیم‌ها در همین
    // چرخه اصلاح شدند، چند تلاش کردند و وضعیت نهایی‌شان چه شد.
    const fixLoops: Record<string, { attempts: number; final_status: string }> = {};
    attempts.forEach((n, team) => {
      if (n > 1) {
        fixLoops[team] = { attempts: n, final_status: latest.get(team)?.status ?? 'unknown' };
      }
    });
    const latestRows: Array<{ status: string; llm_calls: number }> = [];
    latest.forEach((v) => latestRows.push(v));
    const stats: Record<string, number | string | boolean | object> = {
      total_teams: latest.size,
      success: latestRows.filter((r) => r.status === 'success').length,
      failed: latestRows.filter((r) => r.status === 'failed').length,
      rejected: latestRows.filter((r) => r.status === 'rejected').length,
      llm_calls: latestRows.reduce((sum, r) => sum + (r.llm_calls ?? 0), 0),
      fix_loops: fixLoops,
    };
    if (cycle) {
      stats.duration_minutes = Math.round(
        (Date.now() - new Date((cycle as { started_at: string }).started_at).getTime()) / 60000,
      );
    }
    const { error } = await sb
      .from('cycles')
      .update({
        status,
        finished_at: new Date().toISOString(),
        stats,
        ...(errorMessage ? { error: errorMessage.slice(0, 4000) } : {}),
      })
      .eq('id', cycleId);
    if (error) console.error('[orchestrator] failed to update cycles row:', error.message);
    // لایه ۱ دیده‌بان زنده: پایان چرخه (fail-soft)
    await recordEvent(
      (cycle as { run_id?: string } | null)?.run_id ?? cycleId,
      'orchestrator',
      'cycle_finished',
      { status },
    );
    // آزاد کردن قفل: وضعیت دیگر running نیست، ولی ردیف برای حسابرسی می‌ماند.
    // فقط اگر قفل مال همین چرخه باشد (تا قفل چرخه‌ی تازه‌ای را آزاد نکنیم).
    await forceReleaseLock(cycleId, 'finishCycle');
  } catch (err) {
    console.error('[orchestrator] finishCycle failed:', err instanceof Error ? err.message : err);
    try {
      await forceReleaseLock(cycleId, 'finishCycle');
    } catch {
      /* best effort */
    }
  }
}

