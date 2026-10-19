/**
 * lib/teams/seocontent.ts : تیم سئوی محتوا (seocontent)
 *
 * پل بین تولید محتوا و سئوست؛ فقط روی محتواها کار می‌کند، نه سئوی تکنیکال.
 * به خروجی تیم content وابسته است و آن را از previousWavesOutput می‌خواند.
 *
 * خط لوله (اقتباس تمیز از ورک‌فلو n8n ‏thailandgard-all-teams):
 *   حلقه نقد ۳ دوره‌ای (lib/critic-loop.ts):
 *     دور ۱: سرپرست (analyze) ← سه مجری موازی (analyze / code / write)
 *     دور ۲: رد ← دستور دقیق منتقد (analyze) ← سه مجری اصلاح می‌کنند
 *     دور ۳: فقط نظارت و نظر نهایی (حق رد ندارد)
 *   تایید ← writeMemory با کلید learned:<runId> / رد ← بسته‌بندی بلوکر
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
  combineReviewDirectives,
  parseCriticScore,
  CRITIC_SCORE_PROMPT_LINE,
  type CriticLoopResult,
  type CriticVerdictV2,
} from '../critic-loop';
import type { ProgressReporter, QueuedTask, TeamName, TeamResult } from '../types';

export const TEAM: TeamName = 'seocontent';

export const MISSION =
  'پل بین تولید محتوا و سئوست؛ هر محتوایی که منتشر می‌شود از زیر دست این تیم رد می‌شود تا شانس رتبه‌اش حداکثر شود.';

const SYSTEM_SUPERVISOR = 'تو سرپرست تیم seocontent تایلندگرد هستی.';
const SYSTEM_WORKER = 'تو مجری تیم seocontent تایلندگرد هستی.';
const SYSTEM_CRITIC = 'تو منتقد سخت‌گیر تیم seocontent هستی.';

/** ورودی اجرای تیم: خروجی موج‌های قبلی (کلید team به TeamResult). */
export interface RunTeamInput {
  /** گزارش زنده‌ی پیشرفت به ارکستر؛ ارکستر همیشه آن را می‌دهد. */
  reportProgress?: ProgressReporter;
  /** شناسهٔ اجرای چرخه؛ در کلید حافظه به شکل learned:<runId> می‌نشیند. */
  runId: string;
  /** شمارهٔ موج اجرایی این تیم. */
  wave: number;
  /** خروجی تیم‌های موج‌های قبلی؛ seocontent به تیم content وابسته است. */
  previousWavesOutput: Record<string, TeamResult | undefined>;
  /**
   * دستور مستقیم منتقد از حلقهٔ بیرونی ارکستراتور (همین چرخه)؛ بالاترین
   * اولویت را دارد و در ابتدای دستور مجری‌ها تزریق می‌شود.
   */
  reviewDirective?: string;
}

interface SupervisorPlan {
  workers: [string, string, string] | string[];
}

interface CriticVerdict {
  approved: boolean;
  /** امتیاز کیفی منتقد (۰ تا ۱۰۰)؛ تعیین‌کننده نهایی: تأیید فقط با ≥ ۸۰. */
  score?: number;
  reason: string;
  payload?: unknown;
}

/** خروجی یک دور از مجری‌های حلقه نقد: مأموریت‌ها + خروجی هر سه مجری */
interface WorkerRoundOutput {
  missions: string[];
  outputs: [string, string, string];
}

const WORKER_ROLES = [
  {
    // مجری ۱ : شکار فرصت رتبه (analyze)
    temperature: 0.7,
    maxTokens: 2500,
    missionLine:
      'نقش تو: محتواهای موجود را می‌خوانی و فرصت‌های رتبه (کنیبالیزیشن، محتوای کهنه) را پیدا می‌کنی. فقط واقعیت؛ بدون حدس.',
  },
  {
    // مجری ۲ : نگاشت کلمه‌کلیدی و لینک‌سازی داخلی (code)
    temperature: 0.3,
    maxTokens: 3000,
    missionLine:
      'نقش تو: نگاشت کلمه‌کلیدی به صفحه را نگه می‌داری و لینک‌سازی داخلی بین محتواها را اجرا می‌کنی. فقط واقعیت؛ بدون حدس.',
  },
  {
    // مجری ۳ : بهینه‌سازی عنوان و متا و بریف سئو (write)
    temperature: 0.7,
    maxTokens: 3000,
    missionLine:
      'نقش تو: عنوان، متا، تیترها و FAQ هر محتوا را بهینه می‌کنی و بریف سئو برای درفت‌های تیم محتوا می‌نویسی. فقط واقعیت؛ بدون حدس.',
  },
] as const;

function summarizeContentOutput(result: TeamResult | undefined): string {
  if (!result) {
    return 'خروجی تیم content در این چرخه یافت نشد؛ بر اساس مأموریت تیم و دانش عمومی پیش برو.';
  }
  const parts = [`خلاصه: ${result.summary}`];
  if (result.blockers.length > 0) parts.push(`بلوکرهای تیم content: ${result.blockers.join('؛ ')}`);
  if (result.tasks.length > 0) {
    parts.push(
      `کارهای باز تیم content: ${result.tasks.map((t) => t.title).join('؛ ')}`,
    );
  }
  return parts.join('\n');
}

async function makeSupervisorMissions(contentSummary: string): Promise<string[]> {
  // تزریق best-effort دانش تیم در ابتدای بخش زمینه (تیم ۱۳)؛
  // بدون دانش، پرامپت دقیقاً مثل قبل می‌ماند.
  let knowledgeSection = '';
  try {
    knowledgeSection = await buildKnowledgePromptSection(TEAM, MISSION);
  } catch {
    knowledgeSection = '';
  }
  const prompt = [
    ...(knowledgeSection ? [knowledgeSection, ''] : []),
    `زمینه (خروجی تیم content):\n${contentSummary}`,
    '',
    `مأموریت تیم seocontent: ${MISSION} فقط روی محتواها کار می‌کند نه سئوی تکنیکال.`,
    '',
    'بر اساس زمینه، تصمیم بگیر این چرخه چه کاری باید انجام شود و آن را به سه مأموریت مجزا برای سه مجری بشکن:',
    'مجری ۱: شکار فرصت رتبه در محتواهای موجود (کنیبالیزیشن، محتوای کهنه).',
    'مجری ۲: نگاشت کلمه‌کلیدی به صفحه و لینک‌سازی داخلی بین محتواها.',
    'مجری ۳: بهینه‌سازی عنوان، متا، تیترها و FAQ و نوشتن بریف سئو برای درفت‌های تیم محتوا.',
    '',
    'خروجی: فقط JSON معتبر با کلید workers شامل سه مأموریت رشته‌ای.',
  ].join('\n');

  const plan = await callLLMJson<SupervisorPlan>(prompt, {
    system: SYSTEM_SUPERVISOR,
    temperature: 0.5,
    maxTokens: 2000,
  });

  const workers = Array.isArray(plan?.workers) ? plan.workers : [];
  const missions = workers.filter((w): w is string => typeof w === 'string' && w.trim().length > 0);
  if (missions.length < 3) {
    throw new Error('سرپرست کمتر از سه مأموریت معتبر برای مجری‌ها برگرداند.');
  }
  return missions.slice(0, 3);
}

async function executeWorker(index: number, mission: string, contentSummary: string, prevInstruction?: string): Promise<string> {
  const role = WORKER_ROLES[index];
  const prompt = [
    ...(prevInstruction
      ? ['دستور منتقد برای اصلاح این دور (حتماً رعایت کن):', prevInstruction, '']
      : []),
    `مأموریت سرپرست:\n${mission}`,
    '',
    `زمینه (خروجی تیم content):\n${contentSummary}`,
    '',
    role.missionLine,
  ].join('\n');

  return callLLM(prompt, {
    system: SYSTEM_WORKER,
    temperature: role.temperature,
    maxTokens: role.maxTokens,
  });
}

async function judgeWorkers(outputs: [string, string, string]): Promise<CriticVerdict> {
  const prompt = [
    `خروجی مجری ۱:\n${outputs[0]}`,
    '',
    `خروجی مجری ۲:\n${outputs[1]}`,
    '',
    `خروجی مجری ۳:\n${outputs[2]}`,
    '',
    'داوری کن و فقط JSON معتبر بده با کلیدهای: approved (بولین)، score (عدد ۰ تا ۱۰۰)، reason (یک جمله)، payload.',
    CRITIC_SCORE_PROMPT_LINE,
    'تمرکز داوری: آیا بهینه‌سازی برای انسان هم بهتر شده (نه فقط موتور) و صفحه از کلمهٔ کلیدی پر نشده؟',
    'در payload این‌ها را بگذار: summary (خلاصهٔ یک‌پاراگرافی خروجی تیم)، tasks (آرایه‌ای از کارهای قابل اجرا با title، description، files_hint و priority یکی از low/medium/high/critical)، و learned (یک تا سه درس ماندگار این چرخه).',
  ].join('\n');

  const verdict = await callLLMJson<CriticVerdict>(prompt, {
    system: SYSTEM_CRITIC,
    temperature: 0.3,
    maxTokens: 3000,
  });

  if (typeof verdict?.approved !== 'boolean' || typeof verdict?.reason !== 'string') {
    throw new Error('منتقد حکم معتبر (approved/reason) برنگرداند.');
  }
  return { ...verdict, score: parseCriticScore(verdict.score) ?? undefined };
}

function coerceTasks(raw: unknown): QueuedTask[] {
  if (!Array.isArray(raw)) return [];
  const priorities = ['low', 'medium', 'high', 'critical'] as const;
  return raw
    .filter(
      (t): t is Record<string, unknown> =>
        typeof t === 'object' && t !== null && typeof (t as Record<string, unknown>).title === 'string',
    )
    .map((t) => ({
      title: String(t.title),
      description: typeof t.description === 'string' ? t.description : '',
      files_hint: typeof t.files_hint === 'string' ? t.files_hint : '',
      priority: priorities.includes(t.priority as (typeof priorities)[number])
        ? (t.priority as QueuedTask['priority'])
        : 'medium',
    }));
}

function coercePayload(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  return { result: typeof raw === 'string' ? raw : JSON.stringify(raw ?? null) };
}

/**
 * تبدیل دلیل ردِ منتقد قدیمی به دستور اجرایی (CriticVerdictV2.instruction).
 * امری و بلندتر از ۵۰ نویسه تا از اعتبارسنجی حلقه رد شود.
 */
function criticInstructionFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی ایراد دارد';
  return [
    `خروجی را بر اساس این نقد اصلاح کن: «${r}»`,
    'هر سه خروجی را بازنویسی کن: بهینه‌سازی را برای انسان هم بهتر کن، نه فقط موتور؛',
    'صفحه را از کلمهٔ کلیدی پر نکن؛ فقط واقعیت بنویس، بدون حدس.',
  ].join(' ');
}

/**
 * تبدیل دلیل رد به معیار قبولی (CriticVerdictV2.acceptance).
 */
function criticAcceptanceFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی ایراد دارد';
  return `وقتی درست است که نقد «${r}» دیگر دربارهٔ خروجی صدق نکند: بهینه‌سازی برای انسان هم بهتر شده و صفحه از کلمهٔ کلیدی پر نشده است.`;
}

/**
 * اجرای کامل تیم seocontent در یک چرخه:
 * حلقه نقد ← (تایید: حافظه + خروجی استاندارد) / (رد: بستهٔ بلوکر)
 * (مهاجرت به حلقه نقد ۳ دوره‌ای lib/critic-loop.ts)
 */
export async function runTeam(input: RunTeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;
  const contentSummary = summarizeContentOutput(input.previousWavesOutput['content']);

  try {
    // ---------- توابع حلقه نقد ----------

    // کش دور ۱: مأموریت‌های سرپرست در هر چرخه یک بار ساخته می‌شوند؛
    // دورهای ۲ و ۳ همان مأموریت‌ها را با دستور منتقد اصلاح می‌کنند.
    let cachedMissions: string[] | null = null;
    // داوری خام آخرین دور (برای خلاصه، تسک‌ها و حافظه)
    let lastVerdict: CriticVerdict | null = null;

    /**
     * runWorkers: سرپرست (دور ۱) + سه مجری موازی هر دور.
     */
    const runWorkers = async (
      round: number,
      prevInstruction?: string,
    ): Promise<WorkerRoundOutput> => {
      if (round === 1) {
        await reportLive?.('سرپرست: طراحی مأموریت‌ها', 20);
        cachedMissions = await makeSupervisorMissions(contentSummary);
      } else {
        await reportLive?.(`دور ${round}: اصلاح با دستور منتقد`, 55);
      }
      const missions = cachedMissions;
      if (!missions) {
        throw new Error('مأموریت‌های سرپرست در کش پیدا نشد.');
      }

      await reportLive?.('مجری‌ها: سه خروجی موازی', 60);
      const outputs = (await Promise.all(
        missions.map((mission, i) =>
          executeWorker(
            i,
            mission,
            contentSummary,
            combineReviewDirectives(input.reviewDirective, prevInstruction),
          ),
        ),
      )) as [string, string, string];
      return { missions, outputs };
    };

    /**
     * runCritic: منتقد فعلی، با تبدیل خروجی به CriticVerdictV2.
     * دور ۳: آخرین دور؛ حکم خام منتقد ثبت می‌شود.
     */
    const runCritic = async (
      output: WorkerRoundOutput,
      round: number,
    ): Promise<CriticVerdictV2> => {
      await reportLive?.(`منتقد: داوری خروجی (دور ${round})`, 80);
      const verdict = await judgeWorkers(output.outputs);
      lastVerdict = verdict;
      const reason = verdict.reason;
      const score = verdict.score;

      if (verdict.approved) {
        return {
          approved: true,
          score,
          reason: '',
          instruction: '',
          acceptance: '',
          finalOpinion: reason || undefined,
        };
      }
      return {
        approved: false,
        score,
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
          domain: 'محتوای سئو',
          instruction: record.instruction,
          round,
          rounds: roundHistory.slice(),
          isFinal: round === 3,
        },
        input.runId,
      );
      roundHistory.push(record);
      lastKnowledgeLog = criticKnowledgeLog(knowledgeResult);
    };

    // ---------- اجرای حلقه نقد ۳ دوره‌ای ----------
    const loopResult: CriticLoopResult<WorkerRoundOutput> = await runCriticLoop<WorkerRoundOutput>({
      team: TEAM,
      runId: input.runId,
      runWorkers,
      runCritic,
      onRoundKnowledge,
      onProgress: (msg) => reportLive?.(msg, 70),
    });

    const verdict: CriticVerdict = lastVerdict ?? {
      approved: false,
      reason: 'داوری ثبت نشد.',
      payload: null,
    };
    const payload = coercePayload(verdict.payload);

    if (loopResult.approved) {
      await writeMemory(TEAM, `learned:${input.runId}`, {
        ...payload,
        finalRound: loopResult.finalRound,
        rounds: loopResult.verdicts.map((v, i) => ({
          round: i + 1,
          approved: v.approved,
          reason: v.reason || v.finalOpinion || '',
        })),
      });

      const summary =
        typeof payload.summary === 'string' && payload.summary.trim().length > 0
          ? payload.summary
          : 'تیم seocontent چرخه را با موفقیت پشت سر گذاشت.';

      return {
        team: TEAM,
        summary: `${summary} (حلقه در دور ${loopResult.finalRound} تمام شد) ${lastKnowledgeLog}`,
        blockers: [],
        tasks: coerceTasks(payload.tasks),
        approved: true,
      };
    }

    // بسته‌بندی بلوکر: دلیل منتقد + یک کار رفع برای چرخهٔ بعد
    return {
      team: TEAM,
      summary: `منتقد خروجی تیم seocontent را رد کرد: ${verdict.reason} ${lastKnowledgeLog}`,
      blockers: [verdict.reason],
      tasks: [
        {
          title: 'رفع ایراد منتقد seocontent',
          description: verdict.reason,
          files_hint: 'lib/teams/seocontent.ts',
          priority: 'medium',
        },
      ],
      approved: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      team: TEAM,
      summary: `اجرای تیم seocontent با خطا متوقف شد: ${message}`,
      blockers: [message],
      tasks: [],
      approved: false,
    };
  }
}
