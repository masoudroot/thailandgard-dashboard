/**
 * lib/teams/design-ir.ts - تیم «چشم ایرانی» (design-ir)
 *
 * وابسته به خروجی تیم design است؛ طرح نمی‌کشد و کد نمی‌زند، می‌بیند و حکم می‌دهد.
 * خروجی‌های design را با سه لنز (فرهنگ دیداری ایرانی، زبان فارسی، نگاه مسافر ایرانی)
 * نقد می‌کند و حکم‌های لازم‌الاجرا صادر می‌کند.
 *
 * ساختار اجرا: حلقه نقد ۳ دوره‌ای (lib/critic-loop.ts):
 *   دور ۱: سرپرست ← ۳ مجری موازی
 *   دور ۲: رد ← دستور دقیق منتقد ← ۳ مجری اصلاح می‌کنند
 *   دور ۳: فقط نظارت و نظر نهایی (حق رد ندارد)
 * → ثبت یادگیری در حافظه.
 * اقتباس تمیز پرامپت‌های ورک‌فلو n8n «thailandgard-all-teams» (بخش design-ir).
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

export const TEAM: TeamName = 'design-ir';

export const MISSION =
  '«چشم ایرانی» تایلندگرد: طرح نمی‌کشد و کد نمی‌زند، می‌بیند و با سه لنز فرهنگ دیداری ایرانی، زبان فارسی و نگاه مسافر ایرانی حکم لازم‌الاجرا می‌دهد.';

export interface RunTeamInput {
  /** گزارش زنده‌ی پیشرفت به ارکستر؛ ارکستر همیشه آن را می‌دهد. */
  reportProgress?: ProgressReporter;
  /** شناسهٔ اجرای جاری (برای کلید حافظه: learned:<runId>) */
  runId: string;
  /** خروجی تیم‌های موج‌های قبلی؛ این تیم ورودی previousWavesOutput['design'] را می‌خواند */
  previousWavesOutput: Record<string, TeamResult | null | undefined>;
  /**
   * دستور مستقیم منتقد از حلقهٔ بیرونی ارکستراتور (همین چرخه)؛ بالاترین
   * اولویت را دارد و در ابتدای دستور مجری‌ها تزریق می‌شود.
   */
  reviewDirective?: string;
}

const TEAM_SYSTEM = 'تو سرپرست تیم design-ir تایلندگرد هستی.';
const WORKER_SYSTEM = 'تو مجری تیم design-ir تایلندگرد هستی.';
const CRITIC_SYSTEM = 'تو منتقد سخت‌گیر تیم design-ir هستی.';

const LENSES =
  'سه لنز: ۱) فرهنگ دیداری ایرانی (آشنا بودن تصویر و چیدمان برای چشم ایرانی) ۲) زبان فارسی (درست‌نویسی، لحن محاوره‌ای درست، خوانایی) ۳) نگاه مسافر ایرانی (آیا طرح به مسافر حس اعتماد و انگیزه سفر می‌دهد).';

interface SupervisorPlan {
  workers: string[];
}

interface CriticVerdict {
  approved: boolean;
  /** امتیاز کیفی منتقد (۰ تا ۱۰۰)؛ تعیین‌کننده نهایی: تأیید فقط با ≥ ۸۰. */
  score?: number;
  reason: string;
  payload?: unknown;
}

/** خروجی یک دور از مجری‌های حلقه نقد: مأموریت‌ها + متن هر سه مجری */
interface WorkerRoundOutput {
  missions: [string, string, string];
  texts: [string, string, string];
}

/** خلاصهٔ کوتاه و امن از خروجی تیم design برای تزریق به پرامپت‌ها. */
function describeDesignOutput(design: TeamResult | null | undefined): string {
  if (!design) {
    return 'خروجی تیم design در این چرخه ثبت نشده است؛ بر اساس دانش موجود نقد کن و به نبود خروجی اشاره کن.';
  }
  const blockers =
    design.blockers && design.blockers.length > 0
      ? `\nبلوکرهای design: ${design.blockers.join(' | ')}`
      : '';
  return `خلاصهٔ خروجی design:\n${design.summary}${blockers}`;
}

function ensureThreeMissions(missions: unknown): [string, string, string] {
  const list = Array.isArray(missions) ? missions.filter((m) => typeof m === 'string') : [];
  const fallback = [
    'خروجی‌های design را با سه لنز بخوان و نقد روزانهٔ ۵ نقطهٔ سایت را با سه قلم (کدام المان، چه ایرادی، چه راه‌حلی) بنویس.',
    'یافته‌های دتکتور unslop را روی فایل‌های صفحات مرور کن و هر یافتهٔ ماشینی را با سه لنز بسنج؛ یافتهٔ بی‌ربط را حذف کن.',
    'حکم‌های لازم‌الاجرا را مشخص (کدام صفحه یا سکشن، چه ایرادی، چه راه‌حلی) در قالب ورودی‌های VERDICTS.md بنویس.',
  ];
  while (list.length < 3) list.push(fallback[list.length]);
  return [list[0], list[1], list[2]];
}

function payloadToTasks(payload: unknown): QueuedTask[] {
  if (!payload || typeof payload !== 'object') return [];
  const raw = (payload as { tasks?: unknown }).tasks;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (t): t is { title?: unknown; description?: unknown; priority?: unknown } =>
        typeof t === 'object' && t !== null,
    )
    .slice(0, 10)
    .map((t) => ({
      title: typeof t.title === 'string' ? t.title : 'پیگیری حکم design-ir',
      description:
        typeof t.description === 'string'
          ? t.description
          : 'خروجی تیم چشم ایرانی نیاز به پیگیری دارد.',
      files_hint: 'thailandgard site',
      priority:
        t.priority === 'critical' || t.priority === 'high' || t.priority === 'medium'
          ? t.priority
          : ('medium' as QueuedTask['priority']),
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
    'هر سه خروجی را بازنویسی کن: نقدها را مشخص بنویس (کدام صفحه یا سکشن، چه ایرادی، چه راه‌حلی)؛',
    'به هر نقد راه‌حل بده؛ سلیقهٔ شخصی بدون استدلال فرهنگی نیاور؛',
    'فقط واقعیت بنویس، بدون حدس، و با هر سه لنز (فرهنگ دیداری ایرانی، زبان فارسی، نگاه مسافر ایرانی) بسنج.',
  ].join(' ');
}

/**
 * تبدیل دلیل رد به معیار قبولی (CriticVerdictV2.acceptance).
 */
function criticAcceptanceFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی ایراد دارد';
  return `وقتی درست است که نقد «${r}» دیگر دربارهٔ خروجی صدق نکند: هر نقد راه‌حل مشخص دارد، هیچ سلیقهٔ شخصی بدون استدلال فرهنگی نیست و طرح به مسافر حس می‌دهد نه بی‌روح.`;
}

/**
 * اجرای کامل تیم design-ir در یک چرخه.
 * ورودی: خروجی تیم design از موج‌های قبلی. خروجی: TeamResult استاندارد.
 * (مهاجرت به حلقه نقد ۳ دوره‌ای lib/critic-loop.ts)
 */
export async function runTeam(input: RunTeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;
  const designOutput = describeDesignOutput(input.previousWavesOutput['design']);

  // تزریق best-effort دانش تیم در ابتدای بخش زمینه (تیم ۱۳)؛
  // بدون دانش، پرامپت دقیقاً مثل قبل می‌ماند.
  let knowledgeSection = '';
  try {
    knowledgeSection = await buildKnowledgePromptSection(TEAM, MISSION);
  } catch {
    knowledgeSection = '';
  }

  // ---------- توابع حلقه نقد ----------

  // کش دور ۱: مأموریت‌های سرپرست در هر چرخه یک بار ساخته می‌شوند؛
  // دورهای ۲ و ۳ همان مأموریت‌ها را با دستور منتقد اصلاح می‌کنند.
  let cachedMissions: [string, string, string] | null = null;
  // payload آخرین داوری منتقد (برای استخراج کارهای پیشنهادی)
  let lastPayload: unknown = null;

  /** سه مجری به‌صورت موازی (منطق فعلی، بدون تغییر). */
  const executeWorkers = async (
    missions: [string, string, string],
    prevInstruction?: string,
  ): Promise<[string, string, string]> => {
    const workerPrompt = (mission: string) =>
      [
        ...(prevInstruction
          ? ['دستور منتقد برای اصلاح این دور (حتماً رعایت کن):', prevInstruction, '']
          : []),
        `مأموریت سرپرست:\n${mission}`,
        '',
        `زمینه (خروجی design):\n${designOutput}`,
        '',
        LENSES,
        'فقط واقعیت؛ بدون حدس. نقدها را مشخص بنویس: کدام صفحه یا سکشن، چه ایرادی، چه راه‌حلی.',
      ].join('\n');

    return (await Promise.all([
      callLLM(
        `${workerPrompt(missions[0])}\n\nنقش تو: خروجی‌های design را با سه لنز می‌خوانی و نقد روزانهٔ ۵ نقطهٔ سایت انجام می‌دهی.`,
        { system: WORKER_SYSTEM, maxTokens: 2500 },
      ),
      callLLM(
        `${workerPrompt(missions[1])}\n\nنقش تو: یافته‌های دتکتور unslop روی فایل‌های صفحات را مرور می‌کنی و یافته‌های ماشینی را با سه محک می‌سنجی؛ یافتهٔ بی‌پایه را رد می‌کنی.`,
        { system: WORKER_SYSTEM, maxTokens: 2500 },
      ),
      callLLM(
        `${workerPrompt(missions[2])}\n\nنقش تو: حکم‌های لازم‌الاجرا را مشخص (کدام صفحه یا سکشن، چه ایرادی، چه راه‌حلی) در قالب ورودی‌های فایل VERDICTS.md می‌نویسی.`,
        { system: WORKER_SYSTEM, maxTokens: 2500 },
      ),
    ])) as [string, string, string];
  };

  /**
   * runWorkers: سرپرست (دور ۱) + سه مجری موازی هر دور.
   */
  const runWorkers = async (
    round: number,
    prevInstruction?: string,
  ): Promise<WorkerRoundOutput> => {
    if (round === 1) {
      // ۱. سرپرست: شکستن کار این چرخه به سه مأموریت مجری
      await reportLive?.('سرپرست: طراحی مأموریت‌ها', 15);
      const plan = await callLLMJson<SupervisorPlan>(
        [
          ...(knowledgeSection ? [knowledgeSection, ''] : []),
          `زمینه و خروجی تیم design:\n${designOutput}`,
          '',
          'مأموریت تیم design-ir: «چشم ایرانی» زیرمجموعهٔ دیزاین است؛ طرح نمی‌کشد و کد نمی‌زند، می‌بیند و حکم می‌دهد.',
          'خروجی‌های design را با سه لنز فرهنگ دیداری ایرانی، زبان فارسی و دیدگاه مسافر ایرانی می‌سنجد؛ حکم‌هایش لازم‌الاجراست.',
          '',
          'بر اساس زمینه تصمیم بگیر این چرخه چه کاری باید انجام شود و آن را به سه مأموریت مجزا برای سه مجری بشکن.',
          'خروجی فقط JSON با کلید workers شامل سه مأموریت (هر مأموریت یک رشتهٔ فارسی).',
        ].join('\n'),
        { system: TEAM_SYSTEM, temperature: 0.4 },
      );
      cachedMissions = ensureThreeMissions(plan.workers);
    } else {
      await reportLive?.(`دور ${round}: اصلاح با دستور منتقد`, 50);
    }
    const missions = cachedMissions;
    if (!missions) {
      throw new Error('مأموریت‌های سرپرست در کش پیدا نشد.');
    }

    // ۲. سه مجری به‌صورت موازی
    await reportLive?.('مجری‌ها: سه خروجی موازی', 55);
    const texts = await executeWorkers(
      missions,
      combineReviewDirectives(input.reviewDirective, prevInstruction),
    );
    return { missions, texts };
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
    const verdict = await callLLMJson<CriticVerdict>(
      [
        `خروجی مجری ۱:\n${output.texts[0]}`,
        '',
        `خروجی مجری ۲:\n${output.texts[1]}`,
        '',
        `خروجی مجری ۳:\n${output.texts[2]}`,
        '',
        'داوری کن و فقط JSON معتبر بده با کلیدهای: approved (بولین)، score (عدد ۰ تا ۱۰۰)، reason (یک جمله)، payload.',
        CRITIC_SCORE_PROMPT_LINE,
        'تمرکز داوری: آیا نقد راه‌حل دارد، سلیقهٔ شخصی بدون استدلال فرهنگی نیست و طرح به مسافر حسی می‌دهد نه بی‌روح؟',
      ].join('\n'),
      { system: CRITIC_SYSTEM, temperature: 0.2 },
    );
    const approved = Boolean(verdict.approved);
    const score = parseCriticScore(verdict.score) ?? undefined;
    const reason =
      typeof verdict.reason === 'string' && verdict.reason.trim()
        ? verdict.reason
        : 'منتقد دلیلی ثبت نکرد.';
    lastPayload = verdict.payload ?? null;

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
    if (approved) {
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
        domain: 'دیزاین ایرانی',
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

  const approved = loopResult.approved;
  const finalVerdict = loopResult.verdicts[loopResult.verdicts.length - 1];
  const reason = finalVerdict.reason || finalVerdict.finalOpinion || 'منتقد دلیلی ثبت نکرد.';

  // ثبت یادگیری این اجرا در حافظه (غنی‌شده با تاریخچه دورهای حلقه)
  await writeMemory(
    TEAM,
    `learned:${input.runId}`,
    [
      `تیم design-ir در چرخه ${input.runId}:`,
      `سرپرست سه مأموریت داد؛ مجری‌ها نقد ۵ نقطه، سنجش یافته‌های unslop و حکم‌های VERDICTS.md را تولید کردند.`,
      `حکم منتقد: ${approved ? 'تأیید' : 'رد'}، ${reason}`,
      `حلقه در دور ${loopResult.finalRound} تمام شد.`,
      designOutput.includes('ثبت نشده')
        ? 'یادداشت: خروجی design در ورودی این چرخه نبود.'
        : 'یادداشت: خروجی design در ورودی این چرخه موجود بود.',
    ].join(' '),
  );

  // بسته‌بندی خروجی استاندارد
  const tasks = payloadToTasks(lastPayload);
  if (!approved) {
    tasks.unshift({
      title: 'رفع ایراد حکم منتقد design-ir',
      description: `منتقد خروجی را رد کرد: ${reason}`,
      files_hint: 'thailandgard site',
      priority: 'high',
    });
  }

  const summary = approved
    ? `چشم ایرانی تأیید شد: ${reason} مجری‌ها ۵ نقطهٔ سایت را با سه لنز نقد کردند، یافته‌های unslop را سنجیدند و حکم‌های لازم‌الاجرا را در قالب VERDICTS.md نوشتند. ${lastKnowledgeLog}`
    : `چشم ایرانی رد شد: ${reason} مجری‌ها خروجی تولید کردند ولی منتقد آن را ناکافی دانست؛ کار پیگیری در صف قرار گرفت. ${lastKnowledgeLog}`;

  return {
    team: TEAM,
    summary,
    blockers: approved ? [] : [reason],
    tasks,
    approved,
  };
}
