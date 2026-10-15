/**
 * lib/teams/analytics.ts - تیم analytics: رفتار کاربر و متریک تماس (خوانندهٔ داده)
 *
 * اقتباس از ورک‌فلو n8n (v1tgtGJnLhAic4X6)، بخش analytics:
 * سرپرست کار را به سه مجری می‌شکند، منتقد سخت‌گیرانه داوری می‌کند
 * و نتیجه در حافظه ثبت می‌شود.
 *
 * خط لوله:
 *  ۱. سرپرست: از روی زمینه، سه مأموریت مجزا برای سه مجری می‌سازد.
 *  ۲. مجری ۱ (analyze): رکوردینگ و هیت‌مپ کلریتی؛ نقطه‌های ریزش تا دکمهٔ تماس.
 *  ۳. مجری ۲ (code): ایونت‌ها و اهداف کلریتی؛ قیف اندازه‌گیری روز اول ترافیک.
 *  ۴. مجری ۳ (write): گزارش هفتگی با سه یافته و دو اقدام؛ هر عدد باید بگوید «پس چه کار کنیم».
 *  ۵. منتقد: داوری با خروجی JSON (approved / reason / payload).
 *  ۶. ثبت حافظه با کلید learned:<runId>.
 */

import { callLLM, callLLMJson } from '../llm';
import { writeMemory } from '../memory';
import type { MemoryEntry, ProgressReporter, QueuedTask, TeamName, TeamResult, TeamProgressInput } from '../types';

export const TEAM: TeamName = 'analytics';

/** یک خط: مأموریت تیم. */
export const MISSION =
  'می‌فهمد کاربر روی سایت چه می‌کند و تماس کجا از دست می‌رود؛ تنها متریک مهم، تماس به‌ازای هر هزار بازدید است.';

const SUPERVISOR_SYSTEM = 'تو سرپرست تیم analytics تایلندگرد هستی.';
const WORKER_SYSTEM = 'تو مجری تیم analytics تایلندگرد هستی.';
const CRITIC_SYSTEM = 'تو منتقد سخت‌گیر تیم analytics هستی.';

const HONESTY_RULE =
  'وقتی دیتا نیست، صادقانه بنویس «دیتا نداریم». فقط واقعیت؛ بدون حدس.';

interface WorkerRole {
  role: 'analyze' | 'code' | 'write';
  brief: string;
}

const WORKER_ROLES: [WorkerRole, WorkerRole, WorkerRole] = [
  {
    role: 'analyze',
    brief:
      'رکوردینگ‌ها، هیت‌مپ‌ها و مسیر تا دکمهٔ تماس را در کلریتی می‌خواند و نقطه‌های ریزش را پیدا می‌کند.',
  },
  {
    role: 'code',
    brief:
      'ایونت‌ها و اهداف کلریتی را تعریف می‌کند و قیف اندازه‌گیری را برای روز اول ترافیک آماده می‌کند.',
  },
  {
    role: 'write',
    brief:
      'گزارش هفتگی را با سه یافته و دو اقدام می‌نویسد؛ هر عدد باید بگوید «پس چه کار کنیم».',
  },
];

interface SupervisorPlan {
  workers: string[];
}

interface CriticVerdict {
  approved: boolean;
  reason: string;
  payload: unknown;
}

export interface RunTeamOptions {
  /** زمینهٔ چرخه: خروجی بازیابی دانش یا هر متن مرجع دیگر. */
  context?: string;
}

/**
 * ورودی استاندارد اجرای تیم از ارکستر (سازگار با TeamInput در lib/orchestrator.ts).
 * ارکستر همیشه یک آبجکت ورودی پاس می‌دهد؛ این امضا همان را می‌پذیرد.
 */
export interface AnalyticsTeamInput extends TeamProgressInput {
  runId: string;
  ragContext?: string;
  context?: string;
  memory?: MemoryEntry[];
  previousWavesOutput?: Record<string, TeamResult | null>;
}

/** خط تیرهٔ بلند (U+2014) در هیچ خروجی نباید باشد. */
function sanitize(input: string): string {
  return input.replace(/\u2014/g, '-');
}

/** سرپرست: سه مأموریت مجزا از روی زمینه می‌سازد. */
async function planWork(context: string): Promise<[string, string, string]> {
  const plan = await callLLMJson<SupervisorPlan>(
    [
      'زمینه:',
      context || 'زمینه‌ای در دست نیست.',
      '',
      `مأموریت تیم analytics: ${MISSION}`,
      HONESTY_RULE,
      '',
      'بر اساس زمینه، تصمیم بگیر این چرخه چه کاری باید انجام شود و آن را به سه مأموریت مجزا برای سه مجری بشکن.',
      'خروجی: فقط JSON معتبر با کلید workers شامل سه مأموریت.',
    ].join('\n'),
    { system: SUPERVISOR_SYSTEM },
  );

  const missions = Array.isArray(plan?.workers) ? plan.workers.filter(Boolean).slice(0, 3) : [];
  if (missions.length === 0) {
    throw new Error('سرپرست analytics سه مأموریت معتبر برنگرداند.');
  }
  // اگر مأموریت کم آمد، از روی شرح نقش‌ها تکمیل می‌شود تا سه مجری همیشه اجرا شوند.
  while (missions.length < 3) {
    missions.push(WORKER_ROLES[missions.length].brief);
  }
  return missions as [string, string, string];
}

/** مجری: یک مأموریت را با نقش خودش اجرا می‌کند. */
async function runWorker(mission: string, index: 0 | 1 | 2): Promise<string> {
  const { role, brief } = WORKER_ROLES[index];
  return callLLM(
    ['مأموریت سرپرست:', mission, '', `نقش تو (${role}): ${brief}`, HONESTY_RULE].join('\n'),
    { system: WORKER_SYSTEM },
  );
}

/**
 * منتقد: داوری سخت‌گیرانه؛ هر یافتهٔ رفتاری باید مخرج و بُعد داشته باشد،
 * حدس‌ها شرط ابطال داشته باشند و عدد بی‌معنا گزارش نشده باشد.
 */
async function judge(outputs: [string, string, string]): Promise<CriticVerdict> {
  const raw = await callLLMJson<CriticVerdict>(
    [
      'خروجی مجری ۱:',
      outputs[0],
      '',
      'خروجی مجری ۲:',
      outputs[1],
      '',
      'خروجی مجری ۳:',
      outputs[2],
      '',
      'داوری کن و فقط JSON معتبر بده با کلیدهای: approved (بولین)، reason (یک جمله)، payload.',
      'تمرکز داوری: آیا هر یافتهٔ رفتاری مخرج و بُعد دارد، حدس‌ها شرط ابطال دارند و عدد بی‌معنا گزارش نشده؟',
    ].join('\n'),
    { system: CRITIC_SYSTEM },
  );

  return {
    approved: raw?.approved === true,
    reason:
      typeof raw?.reason === 'string' && raw.reason.trim()
        ? sanitize(raw.reason.trim())
        : 'منتقد دلیلی ثبت نکرد.',
    payload: raw?.payload ?? null,
  };
}

/** کارهای پیشنهادی را از payload منتقد استخراج و عادی‌سازی می‌کند. */
function extractTasks(payload: unknown): QueuedTask[] {
  if (!payload || typeof payload !== 'object') return [];
  const raw = (payload as { tasks?: unknown }).tasks;
  if (!Array.isArray(raw)) return [];
  const valid: Array<QueuedTask['priority']> = ['low', 'medium', 'high', 'critical'];
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({
      title: typeof t.title === 'string' ? sanitize(t.title) : 'کار پیشنهادی analytics',
      description: typeof t.description === 'string' ? sanitize(t.description) : '',
      files_hint: typeof t.files_hint === 'string' ? t.files_hint : '',
      priority: valid.includes(t.priority as QueuedTask['priority'])
        ? (t.priority as QueuedTask['priority'])
        : 'medium',
    }));
}

/** اجرای کامل تیم analytics در یک چرخه. */
export async function runTeam(input: AnalyticsTeamInput): Promise<TeamResult> {
  const runId = typeof input?.runId === 'string' ? input.runId : 'unknown';
  const reportLive = input?.reportProgress;
  try {
    await reportLive?.('سرپرست: طراحی مأموریت‌ها', 15);
    const missions = await planWork(input.ragContext ?? input.context ?? '');
    await reportLive?.('مجری‌ها: تحلیل رفتار و متریک‌ها', 55);
    const outputs = (await Promise.all(
      missions.map((mission, i) => runWorker(mission, i as 0 | 1 | 2)),
    )) as [string, string, string];

    await reportLive?.('منتقد: داوری خروجی', 85);
    const verdict = await judge(outputs);

    await writeMemory(TEAM, `learned:${runId}`, {
      approved: verdict.approved,
      reason: verdict.reason,
      payload: verdict.payload,
      at: new Date().toISOString(),
    });

    return {
      team: TEAM,
      summary: verdict.approved ? `داوری گذشت: ${verdict.reason}` : `داوری رد شد: ${verdict.reason}`,
      blockers: verdict.approved ? [] : [verdict.reason],
      tasks: extractTasks(verdict.payload),
      approved: verdict.approved,
    };
  } catch (err) {
    const message = sanitize(err instanceof Error ? err.message : String(err));
    return {
      team: TEAM,
      summary: `اجرای تیم analytics به خطا خورد: ${message}`,
      blockers: [message],
      tasks: [],
      approved: false,
    };
  }
}
