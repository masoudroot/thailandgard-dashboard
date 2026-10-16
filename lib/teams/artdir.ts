/**
 * تیم «آرت‌دایرکشن» تایلندگرد (lib/teams/artdir.ts)
 *
 * اقتباس از ورک‌فلو n8n (سرپرست ← ۳ مجری ← منتقد):
 * ۱. حلقه نقد ۳ دوره‌ای (lib/critic-loop.ts):
 *    دور ۱: سرپرست سه مأموریت جدا می‌سازد ← مجری‌ها (در یک فراخوانی ترکیبی)
 *    دور ۲: رد ← دستور دقیق منتقد ← مجری‌ها اصلاح می‌کنند
 *    دور ۳: فقط نظارت و نظر نهایی (حق رد ندارد)
 * ۲. خروجی: نقد بصری مشخص سه‌قلمی، تصمیم‌های آرت‌دایرکشن برای ثبت در
 *    DECISIONS-ARTDIR.md، و بریف اجرایی کامل برای تیم طراحی.
 * ۳. منتقد سخت‌گیر داوری می‌کند: هر تصمیم بزرگ «چرا»ی مستند دارد؟
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
import type { ProgressReporter, MemoryEntry, QueuedTask, TeamName, TeamResult } from '../types';

export const TEAM: TeamName = 'artdir';

export const MISSION =
  '«سر» طراحی تایلندگرد است: کانسپت بصری، لی‌اوت، وایرفریم و تصمیم‌های آرت‌دایرکشن را می‌دهد، حکم نهایی زیبایی‌شناسی با اوست و نقد بصری روزانهٔ سایت را انجام می‌دهد؛ خودش اجرا نمی‌کند.';

export interface TeamInput {
  /** گزارش زنده‌ی پیشرفت به ارکستر؛ ارکستر همیشه آن را می‌دهد. */
  reportProgress?: ProgressReporter;
  cycleId: string;
  runId: string;
  ragContext: string;
  memory: MemoryEntry[];
  previousWavesOutput: Record<string, string>;
  /** دستور صریح منتقد از حلقهٔ بیرونی ارکستراتور (همین چرخه)؛ اگر بود، بالاترین اولویت را دارد. */
  reviewDirective?: string;
  /** شمارهٔ دور حلقهٔ بیرونی (۱ تا ۳). */
  round?: number;
}

interface SupervisorPlan {
  workers: [string, string, string];
}

interface CriticVerdict {
  approved: boolean;
  /** امتیاز کیفی منتقد (۰ تا ۱۰۰)؛ تعیین‌کننده نهایی: تأیید فقط با ≥ ۸۰. */
  score?: number;
  reason: string;
  payload: string;
}

/** خروجی یک دور از مجری‌های حلقه نقد: پلن سرپرست + خروجی ترکیبی مجری‌ها */
interface WorkerRoundOutput {
  plan: SupervisorPlan;
  workersOutput: string;
}

/** سرپرست: از زمینه، سه مأموریت مجزا برای مجری‌ها می‌سازد. */
async function makeSupervisorPlan(input: TeamInput): Promise<SupervisorPlan> {
  // تزریق best-effort دانش تیم در ابتدای بخش زمینه (تیم ۱۳)؛
  // بدون دانش، پرامپت دقیقاً مثل قبل می‌ماند.
  let knowledgeSection = '';
  try {
    knowledgeSection = await buildKnowledgePromptSection(TEAM, MISSION);
  } catch {
    knowledgeSection = '';
  }
  const memoryLines = input.memory.map((m) => `- ${m.key}: ${m.value}`).join('\n');
  const wavesLines = Object.entries(input.previousWavesOutput)
    .map(([team, out]) => `- ${team}: ${out}`)
    .join('\n');
  const prompt = [
    'زمینه:',
    ...(knowledgeSection ? [knowledgeSection, ''] : []),
    input.ragContext || '(زمینه‌ای نیست)',
    '',
    memoryLines ? `یادگیری‌های قبلی:\n${memoryLines}` : '',
    wavesLines ? `\nخروجی موج‌های قبلی:\n${wavesLines}` : '',
    '',
    'مأموریت تیم artdir: «سر» طراحی است؛ طرح می‌دهد نه اجرا: کانسپت بصری، لی‌اوت، وایرفریم و تصمیم‌های آرت‌دایرکشن. حکم نهایی زیبایی‌شناسی با این تیم است و نقد روزانهٔ بصری سایت را انجام می‌دهد.',
    '',
    'بر اساس زمینه و دانش بازیابی‌شده، تصمیم بگیر این چرخه چه کاری باید انجام شود و آن را به سه مأموریت مجزا برای سه مجری بشکن: مجری ۱ (نقد بصری مشخص با سه قلم: کدام المان، چه ایرادی، چه راه‌حلی)، مجری ۲ (تصمیم‌های آرت‌دایرکشن با دلیل مستند برای ثبت در DECISIONS-ARTDIR.md)، مجری ۳ (بریف کامل اجرایی: هدف، مخاطب، حس موردنظر، ارجاع بصری).',
    'فقط JSON معتبر بده با کلید workers شامل سه رشتهٔ مأموریت.',
  ]
    .filter((l) => l!== '')
    .join('\n');
  const plan = await callLLMJson<SupervisorPlan>(prompt, {
    system: 'تو سرپرست تیم artdir تایلندگرد هستی. فقط JSON معتبر می‌دهی؛ بدون حدس.',
    temperature: 0.3,
  });
  // اعتبارسنجی ساختاری: callLLMJson فقط JSON بودن را تضمین می‌کند، نه ساختار را.
  // اگر workers آرایهٔ سه‌تایی نباشد، خطای واضح می‌دهیم تا retry واقعاً سرپرست را دوباره صدا بزند
  // (نه اینکه در plan.workers.map با «Cannot read properties of undefined» بمیرد).
  if (!plan || !Array.isArray(plan.workers) || plan.workers.length !== 3 || !plan.workers.every((w) => typeof w === 'string' && w.trim().length > 0)) {
    throw new Error(
      `پلن سرپرست نامعتبر است: کلید workers باید آرایه‌ای از سه رشتهٔ مأموریت باشد؛ دریافت شد: ${JSON.stringify(plan).slice(0, 200)}`
    );
  }
  return plan;
}

/**
 * هر سه مجری در یک فراخوانی: تحلیل + تولید.
 * (هر سه مجری در یک فراخوانی: تحلیل و تولید با هم، برای سقف ۳ فراخوانی هر چرخه)
 */
async function executeWorkers(plan: SupervisorPlan, prevInstruction?: string): Promise<string> {
  const prompt = [
    ...(prevInstruction
      ? ['دستور منتقد برای اصلاح این دور (حتماً رعایت کن):', prevInstruction, '']
      : []),
    'مأموریت سرپرست:',
    plan.workers.map((w, i) => `${i + 1}. ${w}`).join('\n'),
    '',
    'نقش تو: مجری تیم artdir تایلندگرد. هر سه خروجی زیر را بده؛ فقط واقعیت، بدون حدس:',
    'الف) نقد بصری: خروجی‌های بصری سایت را با سه قلم نقد کن: کدام المان، چه ایرادی، چه راه‌حلی.',
    'ب) تصمیم‌های آرت‌دایرکشن: هر تصمیم با دلیل مستند (چه حسی، برای چه مخاطبی، با چه ارجاع بصری) آمادهٔ ثبت در DECISIONS-ARTDIR.md.',
    'پ) بریف اجرایی: بریف کامل برای تیم طراحی شامل هدف، مخاطب، حس موردنظر و ارجاع بصری؛ هیچ طرحی بدون بریف به اجرا نمی‌رود.',
  ].join('\n');
  return callLLM(prompt, {
    system: 'تو مجری تیم artdir تایلندگرد هستی. فارسی تمیز، بدون ادعای بی‌پشتوانه.',
    temperature: 0.7,
  });
}

/** منتقد سخت‌گیر: هر تصمیم بزرگ «چرا»ی مستند دارد و طرح بدون بریف به اجرا نرفته؟ */
async function judgeWorkers(workersOutput: string): Promise<CriticVerdict> {
  const prompt = [
    'خروجی مجری‌ها:',
    workersOutput,
    '',
    'داوری کن و فقط JSON معتبر بده با کلیدهای: approved (بولین)، score (عدد ۰ تا ۱۰۰)، reason (یک جمله)، payload (متن نهایی تأییدشده یا اصلاح‌شده).',
    CRITIC_SCORE_PROMPT_LINE,
    'تمرکز داوری: آیا هر تصمیم بزرگ «چرا»ی مستند دارد (چه حسی، برای چه مخاطبی، با چه ارجاعی) و طرح بدون بریف به اجرا نرفته؟',
  ].join('\n');
  const verdict = await callLLMJson<CriticVerdict>(prompt, {
    system: 'تو منتقد سخت‌گیر تیم artdir هستی. فقط JSON معتبر می‌دهی.',
    temperature: 0.2,
  });
  return { ...verdict, score: parseCriticScore(verdict.score) ?? undefined };
}

/**
 * تبدیل دلیل ردِ منتقد قدیمی به دستور اجرایی (CriticVerdictV2.instruction).
 * امری و بلندتر از ۵۰ نویسه تا از اعتبارسنجی حلقه رد شود.
 */
function criticInstructionFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی ایراد دارد';
  return [
    `خروجی را بر اساس این نقد اصلاح کن: «${r}»`,
    'هر سه بخش را بازنویسی کن: نقد بصری را با سه قلم مشخص (کدام المان، چه ایرادی، چه راه‌حلی) بنویس؛',
    'به هر تصمیم بزرگ «چرا»ی مستند بده (چه حسی، برای چه مخاطبی، با چه ارجاع بصری)؛',
    'بریف اجرایی را کامل کن: هیچ طرحی بدون بریف (هدف، مخاطب، حس موردنظر، ارجاع بصری) به اجرا نمی‌رود.',
  ].join(' ');
}

/**
 * تبدیل دلیل رد به معیار قبولی (CriticVerdictV2.acceptance).
 */
function criticAcceptanceFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی ایراد دارد';
  return `وقتی درست است که نقد «${r}» دیگر دربارهٔ خروجی صدق نکند: هر تصمیم بزرگ «چرا»ی مستند دارد و هیچ طرحی بدون بریف کامل به اجرا نرفته است.`;
}

export async function runTeam(input: TeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;

  // ---------- توابع حلقه نقد ----------

  // کش دور ۱: پلن سرپرست در هر چرخه یک بار ساخته می‌شود؛
  // دورهای ۲ و ۳ همان پلن را با دستور منتقد اصلاح می‌کنند.
  let cachedPlan: SupervisorPlan | null = null;
  // حکم خام آخرین داوری (پیش از اجبار دور ۳)
  let lastRawApproved: boolean = false;
  let lastRawReason = '';

  /**
   * runWorkers: سرپرست (دور ۱) + مجری‌های ترکیبی هر دور.
   */
  const runWorkers = async (
    round: number,
    prevInstruction?: string,
  ): Promise<WorkerRoundOutput> => {
    if (round === 1) {
      await reportLive?.('سرپرست: طراحی مأموریت‌ها', 15);
      cachedPlan = await makeSupervisorPlan(input);
    } else {
      await reportLive?.(`دور ${round}: اصلاح با دستور منتقد`, 50);
    }
    const plan = cachedPlan;
    if (!plan) {
      throw new Error('پلن سرپرست در کش پیدا نشد.');
    }
    await reportLive?.('مجری‌ها: اجرای مأموریت‌ها', 55);
    // دستور صریح حلقهٔ بیرونی (ارکستراتور) در همین چرخه — اولویت بالا، جدا از ragContext.
    // با همان قرارداد مشترک همه تیم‌ها (combineReviewDirectives).
    const combinedInstruction = combineReviewDirectives(input.reviewDirective, prevInstruction);
    const workersOutput = await executeWorkers(plan, combinedInstruction);
    return { plan, workersOutput };
  };

  /**
   * runCritic: منتقد فعلی، با تبدیل خروجی به CriticVerdictV2.
   * دور ۳: حق رد ندارد؛ فقط نظر نهایی.
   */
  const runCritic = async (
    output: WorkerRoundOutput,
    round: number,
  ): Promise<CriticVerdictV2> => {
    await reportLive?.(`منتقد: داوری خروجی (دور ${round})`, 80);
    const verdict = await judgeWorkers(output.workersOutput);
    lastRawApproved = verdict.approved === true;
    lastRawReason =
      typeof verdict.reason === 'string' && verdict.reason.trim()
        ? verdict.reason
        : 'منتقد دلیلی ثبت نکرد.';
    const reason = lastRawReason;
    const score = verdict.score;

    if (round === 3) {
      return {
        approved: true,
        score,
        reason: '',
        instruction: '',
        acceptance: '',
        finalOpinion: reason,
      };
    }
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
        domain: 'آرت‌دایرکشن و تصمیم‌های بصری',
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

  const tasks: QueuedTask[] = [];
  const blockers: string[] = [];

  if (lastRawApproved) {
    tasks.push(
      {
        title: 'ثبت تصمیم‌های آرت‌دایرکشن در DECISIONS-ARTDIR.md',
        description:
          'تصمیم‌های تأییدشدهٔ این چرخه با «چرا»ی مستند (حس، مخاطب، ارجاع بصری) در فایل تصمیم‌های آرت‌دایرکشن ثبت شود.',
        files_hint: 'DECISIONS-ARTDIR.md',
        priority: 'high',
      },
      {
        title: 'تحویل بریف اجرایی به تیم طراحی',
        description:
          'بریف کامل این چرخه (هدف، مخاطب، حس موردنظر، ارجاع بصری) به تیم طراحی تحویل داده شود تا طرح بدون بریف اجرا نشود.',
        files_hint: 'design/briefs/**',
        priority: 'high',
      },
      {
        title: 'پیگیری اصلاح ایرادهای نقد بصری',
        description:
          'ایرادهای مشخص‌شده در نقد بصری این چرخه (کدام المان، چه ایرادی، چه راه‌حلی) در صف اصلاح قرار گیرد.',
        files_hint: 'site/**',
        priority: 'medium',
      },
    );
  } else {
    blockers.push(`منتقد artdir تأیید نکرد: ${lastRawReason}`);
  }

  const lesson = lastRawApproved
    ? `چرخهٔ موفق: ${lastRawReason} (حلقه در دور ${loopResult.finalRound} تمام شد)`
    : `رد منتقد: ${lastRawReason} (حلقه در دور ${loopResult.finalRound} با نظر نهایی تمام شد)`;
  await writeMemory(TEAM, `learned:${input.runId}`, lesson);

  const summary = lastRawApproved
    ? `تیم آرت‌دایرکشن این چرخه سه خروجی داد: نقد بصری مشخص با راه‌حل، تصمیم‌های آرت‌دایرکشن با دلیل مستند و بریف اجرایی کامل برای تیم طراحی. ${lastRawReason} هر سه کار بعدی (ثبت تصمیم‌ها، تحویل بریف و پیگیری ایرادها) در صف گذاشته شد. ${lastKnowledgeLog}`
    : `تیم آرت‌دایرکشن این چرخه خروجی تولید کرد؛ منتقد در ${loopResult.finalRound} دور همین چرخه تأیید نکرد و نظر نهایی داد. دلیل: ${lastRawReason} دانش به‌روز شد و بلوکر در گزارش همین چرخه درج شد. ${lastKnowledgeLog}`;

  return {
    team: TEAM,
    summary,
    blockers,
    tasks: tasks.slice(0, 3),
    approved: true,
  };
}
