/**
 * lib/teams/analytics.ts - تیم analytics: رفتار کاربر و متریک تماس (خوانندهٔ داده)
 *
 * اقتباس از ورک‌فلو n8n (v1tgtGJnLhAic4X6)، بخش analytics:
 * سرپرست کار را به سه مجری می‌شکند، حلقه نقد ۳ دوره‌ای (lib/critic-loop.ts)
 * داوری می‌کند و نتیجه در حافظه ثبت می‌شود.
 *
 * خط لوله:
 *  ۱. حلقه نقد:
 *     دور ۱: سرپرست (سه مأموریت) ← ۳ مجری (analyze/code/write)
 *     دور ۲: رد ← دستور دقیق منتقد ← ۳ مجری همان مأموریت‌ها را اصلاح می‌کنند
 *     دور ۳: فقط نظارت و نظر نهایی (حق رد ندارد)
 *  ۲. ثبت حافظه با کلید learned:<runId>.
 */

import { callLLM, callLLMJson } from '../llm';
import { writeMemory } from '../memory';
import { buildKnowledgePromptSection } from '../rag';
import {
  extractCriticKnowledge,
  criticKnowledgeLog,
  type CriticRoundRecord,
} from '../knowledge/critic-knowledge';
import {
  runCriticLoop,
  type CriticLoopResult,
  type CriticVerdictV2,
} from '../critic-loop';
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

/** خروجی یک دور از مجری‌های حلقه نقد: مأموریت‌ها + خروجی هر سه مجری */
interface WorkerRoundOutput {
  missions: [string, string, string];
  outputs: [string, string, string];
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
async function planWork(context: string, knowledgeSection = ''): Promise<[string, string, string]> {
  const plan = await callLLMJson<SupervisorPlan>(
    [
      'زمینه:',
      ...(knowledgeSection ? [knowledgeSection, ''] : []),
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
async function runWorker(
  mission: string,
  index: 0 | 1 | 2,
  prevInstruction?: string,
): Promise<string> {
  const { role, brief } = WORKER_ROLES[index];
  return callLLM(
    [
      ...(prevInstruction
        ? ['دستور منتقد برای اصلاح این دور (حتماً رعایت کن):', prevInstruction, '']
        : []),
      'مأموریت سرپرست:',
      mission,
      '',
      `نقش تو (${role}): ${brief}`,
      HONESTY_RULE,
    ].join('\n'),
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

/**
 * تبدیل دلیل ردِ منتقد قدیمی به دستور اجرایی (CriticVerdictV2.instruction).
 * امری و بلندتر از ۵۰ نویسه تا از اعتبارسنجی حلقه رد شود.
 */
function criticInstructionFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی ایراد دارد';
  return [
    `خروجی را بر اساس این نقد اصلاح کن: «${r}»`,
    'هر سه خروجی را بازنویسی کن: هر یافتهٔ رفتاری مخرج و بُعد مشخص داشته باشد؛',
    'حدس‌ها را با شرط ابطال بنویس و عدد بی‌معنا را حذف کن؛',
    'وقتی دیتا نیست صادقانه بنویس «دیتا نداریم» و حدس نزن.',
  ].join(' ');
}

/**
 * تبدیل دلیل رد به معیار قبولی (CriticVerdictV2.acceptance).
 */
function criticAcceptanceFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی ایراد دارد';
  return `وقتی درست است که نقد «${r}» دیگر دربارهٔ خروجی صدق نکند: هر یافتهٔ رفتاری مخرج و بُعد دارد، حدس‌ها شرط ابطال دارند و هیچ عدد بی‌معنایی گزارش نشده است.`;
}

/** اجرای کامل تیم analytics در یک چرخه. (مهاجرت به حلقه نقد ۳ دوره‌ای) */
export async function runTeam(input: AnalyticsTeamInput): Promise<TeamResult> {
  const runId = typeof input?.runId === 'string' ? input.runId : 'unknown';
  const reportLive = input?.reportProgress;
  try {
    // تزریق best-effort دانش تیم در ابتدای بخش زمینه (تیم ۱۳)؛
    // بدون دانش، پرامپت دقیقاً مثل قبل می‌ماند.
    let knowledgeSection = '';
    try {
      knowledgeSection = await buildKnowledgePromptSection(TEAM, MISSION);
    } catch {
      knowledgeSection = '';
    }
    const context = input.ragContext ?? input.context ?? '';

    // ---------- توابع حلقه نقد ----------

    // کش دور ۱: مأموریت‌های سرپرست در هر چرخه یک بار ساخته می‌شوند؛
    // دورهای ۲ و ۳ همان مأموریت‌ها را با دستور منتقد اصلاح می‌کنند.
    let cachedMissions: [string, string, string] | null = null;
    // payload آخرین داوری منتقد (برای استخراج کارهای پیشنهادی)
    let lastPayload: unknown = null;

    /**
     * runWorkers: سرپرست (دور ۱) + سه مجری هر دور.
     */
    const runWorkers = async (
      round: number,
      prevInstruction?: string,
    ): Promise<WorkerRoundOutput> => {
      if (round === 1) {
        await reportLive?.('سرپرست: طراحی مأموریت‌ها', 15);
        cachedMissions = await planWork(context, knowledgeSection);
      } else {
        await reportLive?.(`دور ${round}: اصلاح با دستور منتقد`, 50);
      }
      const missions = cachedMissions;
      if (!missions) {
        throw new Error('مأموریت‌های سرپرست در کش پیدا نشد.');
      }
      await reportLive?.('مجری‌ها: تحلیل رفتار و متریک‌ها', 55);
      const outputs = (await Promise.all(
        missions.map((mission, i) => runWorker(mission, i as 0 | 1 | 2, prevInstruction)),
      )) as [string, string, string];
      return { missions, outputs };
    };

    /**
     * runCritic: منتقد فعلی، با تبدیل خروجی به CriticVerdictV2.
     * دور ۳: حق رد ندارد؛ فقط نظر نهایی.
     */
    const runCritic = async (
      output: WorkerRoundOutput,
      round: number,
    ): Promise<CriticVerdictV2> => {
      await reportLive?.(`منتقد: داوری خروجی (دور ${round})`, 85);
      const verdict = await judge(output.outputs);
      lastPayload = verdict.payload;
      const reason = verdict.reason;

      if (round === 3) {
        return {
          approved: true,
          reason: '',
          instruction: '',
          acceptance: '',
          finalOpinion: reason || 'نظر نهایی ثبت شد.',
        };
      }
      if (verdict.approved) {
        return {
          approved: true,
          reason: '',
          instruction: '',
          acceptance: '',
          finalOpinion: reason || undefined,
        };
      }
      return {
        approved: false,
        reason,
        instruction: criticInstructionFromReason(reason),
        acceptance: criticAcceptanceFromReason(reason),
      };
    };

    // تاریخچه دورها برای ثبت دانش + آخرین لاگ دانش برای خلاصه
    const roundHistory: CriticRoundRecord[] = [];
    let lastKnowledgeLog = '';

    /**
     * onRoundKnowledge: ثبت دانش هر دور با extractCriticKnowledge فعلی.
     */
    const onRoundKnowledge = async (
      round: number,
      verdict: CriticVerdictV2,
    ): Promise<void> => {
      const record: CriticRoundRecord = {
        round,
        approved: verdict.approved,
        reason: verdict.approved
          ? verdict.finalOpinion || 'تأیید شد.'
          : verdict.reason,
        instruction: verdict.instruction?.trim() || undefined,
      };
      const knowledgeResult = await extractCriticKnowledge(
        TEAM,
        {
          approved: verdict.approved,
          reason: record.reason,
          domain: 'تحلیل داده و متریک',
          instruction: record.instruction,
          round,
          rounds: roundHistory.slice(),
          isFinal: round === 3,
        },
        runId,
      );
      roundHistory.push(record);
      lastKnowledgeLog = criticKnowledgeLog(knowledgeResult);
    };

    // ---------- اجرای حلقه نقد ۳ دوره‌ای ----------
    const loopResult: CriticLoopResult<WorkerRoundOutput> = await runCriticLoop<WorkerRoundOutput>({
      team: TEAM,
      runId,
      runWorkers,
      runCritic,
      onRoundKnowledge,
      onProgress: (msg) => reportLive?.(msg, 70),
    });

    const finalVerdict = loopResult.verdicts[loopResult.verdicts.length - 1];
    const finalReason =
      finalVerdict.reason || finalVerdict.finalOpinion || 'منتقد دلیلی ثبت نکرد.';

    await writeMemory(TEAM, `learned:${runId}`, {
      approved: loopResult.approved,
      reason: finalReason,
      payload: lastPayload,
      at: new Date().toISOString(),
      finalRound: loopResult.finalRound,
      rounds: loopResult.verdicts.map((v, i) => ({
        round: i + 1,
        approved: v.approved,
        reason: v.reason || v.finalOpinion || '',
      })),
    });

    return {
      team: TEAM,
      summary: `${loopResult.approved ? `داوری گذشت: ${finalReason}` : `داوری رد شد: ${finalReason}`} (حلقه در دور ${loopResult.finalRound} تمام شد) ${lastKnowledgeLog}`,
      blockers: loopResult.approved ? [] : [finalReason],
      tasks: extractTasks(lastPayload),
      approved: loopResult.approved,
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
