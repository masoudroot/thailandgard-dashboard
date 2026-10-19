/**
 * lib/teams/vibefarsi.ts: تیم وایب‌فارسی (ممیز رجیستری وایب‌فارسی)
 *
 * وابستگی: خروجی تیم design از موج‌های قبلی (previousWavesOutput['design']).
 * جریان اجرا، همان خط n8n است:
 * حلقه نقد ۳ دوره‌ای (lib/critic-loop.ts):
 *   دور ۱: سرپرست ← ۳ مجری
 *   دور ۲: رد ← دستور دقیق منتقد ← ۳ مجری اصلاح می‌کنند
 *   دور ۳: فقط نظارت و نظر نهایی (حق رد ندارد)
 * → ثبت حافظه.
 * همه فراخوانی‌های مدل از callLLM می‌گذرد؛ حافظه با کلید learned:<runId>.
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

export const TEAM: TeamName = 'vibefarsi';

/** مأموریت تیم در یک خط */
export const MISSION: string =
  'ممیز انطباق با رجیستری وایب‌فارسی؛ هر چیزی که روی سایت می‌نشیند باید نزدیک‌ترین آیتم رجیستری را داشته باشد؛ تأیید می‌کند، انحراف آگاهانه را ثبت می‌کند یا دستور اصلاح می‌دهد.';

/** ورودی اجرای تیم */
export interface RunTeamInput {
  /** گزارش زنده‌ی پیشرفت به ارکستر؛ ارکستر همیشه آن را می‌دهد. */
  reportProgress?: ProgressReporter;
  /** شناسه اجرای جاری (برای کلید حافظه) */
  runId: string;
  /** خروجی موج‌های قبلی؛ تیم design منبع اصلی ممیزی است */
  previousWavesOutput: Record<string, string | null | undefined>;
  /**
   * دستور مستقیم منتقد از حلقهٔ بیرونی ارکستراتور (همین چرخه)؛ بالاترین
   * اولویت را دارد و در ابتدای دستور مجری‌ها تزریق می‌شود.
   */
  reviewDirective?: string;
}

interface SupervisorPlan {
  workers: string[];
}

interface CriticVerdict {
  approved: boolean;
  /** امتیاز کیفی منتقد (۰ تا ۱۰۰)؛ تعیین‌کننده نهایی: تأیید فقط با ≥ ۸۰. */
  score?: number;
  reason: string;
  payload: unknown;
}

/** خروجی یک دور از مجری‌های حلقه نقد: مأموریت‌ها + خروجی هر سه مجری */
interface WorkerRoundOutput {
  missions: string[];
  outputs: [string, string, string];
}

const SYSTEM_SUPERVISOR = 'تو سرپرست تیم vibefarsi تایلندگرد هستی.';
const SYSTEM_WORKER = 'تو مجری تیم vibefarsi تایلندگرد هستی.';
const SYSTEM_CRITIC = 'تو منتقد سخت‌گیر تیم vibefarsi هستی.';

function supervisorPrompt(designOutput: string | null, knowledgeSection = ''): string {
  const context = designOutput ?? '(خروجی تیم design در این چرخه ثبت نشده است)';
  return [
    'زمینه (خروجی تیم design از موج‌های قبلی):',
    ...(knowledgeSection ? [knowledgeSection, ''] : []),
    context,
    '',
    'مأموریت تیم vibefarsi:',
    MISSION,
    '',
    'بر اساس زمینه، تصمیم بگیر این چرخه چه کاری باید انجام شود و آن را به سه مأموریت مجزا برای سه مجری بشکن:',
    'مجری ۱ (تحلیل): خروجی یا دیف design را با چک‌لیست ممیزی می‌خواند.',
    'مجری ۲ (ثبت فنی): انحراف‌های آگاهانه را با دلیل فنی ثبت می‌کند.',
    'مجری ۳ (نگارش): فهرست ممیزی هر نوبت را با ارجاع دقیق به slug می‌نویسد.',
    'فقط JSON معتبر بده با کلید workers که آرایه‌ای از دقیقاً سه رشته (مأموریت هر مجری) است.',
  ].join('\n');
}

function worker1Prompt(mission: string, prevInstruction?: string): string {
  return [
    ...(prevInstruction
      ? ['دستور منتقد برای اصلاح این دور (حتماً رعایت کن):', prevInstruction, '']
      : []),
    'مأموریت سرپرست:',
    mission,
    '',
    'نقش تو: خروجی یا دیف تیم design را با چک‌لیست ممیزی وایب‌فارسی بخوان: نزدیک‌ترین slug رجیستری برای هر المان، توکن‌محوری (رنگ، فاصله و تایپوگرافی همه از توکن‌ها)، ممنوعیت استایل من‌درآوردی.',
    'فقط واقعیت بنویس؛ بدون حدس. برای هر یافته بگو: کدام المان، چه انحرافی، نزدیک‌ترین slug کدام است.',
  ].join('\n');
}

function worker2Prompt(mission: string, prevInstruction?: string): string {
  return [
    ...(prevInstruction
      ? ['دستور منتقد برای اصلاح این دور (حتماً رعایت کن):', prevInstruction, '']
      : []),
    'مأموریت سرپرست:',
    mission,
    '',
    'نقش تو: انحراف‌های آگاهانه را با دلیل فنی ثبت کن.',
    'خروجی: بلوک‌های آماده برای DEVIATIONS.md؛ هر مورد شامل slug آیتم، شرح انحراف، و دلیل فنی که چرا کپی بایت‌به‌بایت ممکن یا درست نبوده است.',
    'فقط واقعیت؛ بدون حدس.',
  ].join('\n');
}

function worker3Prompt(mission: string, prevInstruction?: string): string {
  return [
    ...(prevInstruction
      ? ['دستور منتقد برای اصلاح این دور (حتماً رعایت کن):', prevInstruction, '']
      : []),
    'مأموریت سرپرست:',
    mission,
    '',
    'نقش تو: فهرست ممیزی این نوبت را با ارجاع دقیق به slug بنویس و یافته‌های تازه را برای KNOWLEDGE.md ثبت کن.',
    'هر قلم فهرست: وضعیت (تأیید / انحراف ثبت‌شده / نیازمند اصلاح)، المان، slug مرجع.',
    'فقط واقعیت؛ بدون حدس.',
  ].join('\n');
}

function criticPrompt(text1: string, text2: string, text3: string): string {
  return [
    'خروجی مجری ۱:',
    text1,
    '',
    'خروجی مجری ۲:',
    text2,
    '',
    'خروجی مجری ۳:',
    text3,
    '',
    'داوری کن و فقط JSON معتبر بده با کلیدهای: approved (بولین)، score (عدد ۰ تا ۱۰۰)، reason (یک جمله)، payload.',
    CRITIC_SCORE_PROMPT_LINE,
    'تمرکز داوری: آیا کپی آیتم بایت‌به‌بایت است، همه‌چیز از توکن می‌آید و هیچ تصمیمی بدون slug نیست؟',
  ].join('\n');
}

/**
 * تبدیل دلیل ردِ منتقد قدیمی به دستور اجرایی (CriticVerdictV2.instruction).
 * امری و بلندتر از ۵۰ نویسه تا از اعتبارسنجی حلقه رد شود.
 */
function criticInstructionFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی ایراد دارد';
  return [
    `خروجی را بر اساس این نقد اصلاح کن: «${r}»`,
    'هر سه خروجی را بازنویسی کن: نزدیک‌ترین slug رجیستری را برای هر المان مشخص کن؛',
    'همه‌چیز را از توکن (رنگ، فاصله، تایپوگرافی) بگیر و استایل من‌درآوردی را حذف کن؛',
    'هیچ تصمیمی را بدون slug رها نکن و فقط واقعیت بنویس، بدون حدس.',
  ].join(' ');
}

/**
 * تبدیل دلیل رد به معیار قبولی (CriticVerdictV2.acceptance).
 */
function criticAcceptanceFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی ایراد دارد';
  return `وقتی درست است که نقد «${r}» دیگر دربارهٔ خروجی صدق نکند: کپی آیتم بایت‌به‌بایت است، همه‌چیز از توکن می‌آید و هیچ تصمیمی بدون slug نیست.`;
}

/**
 * اجرای کامل تیم vibefarsi در یک چرخه.
 * سرپرست مأموریت‌ها را می‌شکند، سه مجری موازی کار می‌کنند،
 * منتقد داوری می‌کند و یادگیری چرخه در حافظه ثبت می‌شود.
 * (مهاجرت به حلقه نقد ۳ دوره‌ای lib/critic-loop.ts)
 */
export async function runTeam(input: RunTeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;
  const { runId, previousWavesOutput } = input;
  const designOutput = previousWavesOutput['design'] ?? null;
  const blockers: string[] = [];
  const tasks: QueuedTask[] = [];

  if (!designOutput) {
    blockers.push('خروجی تیم design در موج‌های قبلی ثبت نشده؛ ممیزی روی زمینه تهی انجام شد.');
  }

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
  let cachedMissions: string[] | null = null;
  // داوری خام آخرین دور (برای تسک اصلاح و خلاصه)
  let lastVerdict: CriticVerdict | null = null;

  /**
   * runWorkers: سرپرست (دور ۱) + سه مجری موازی هر دور.
   */
  const runWorkers = async (
    round: number,
    prevInstruction?: string,
  ): Promise<WorkerRoundOutput> => {
    if (round === 1) {
      // قدم ۱: سرپرست، سه مأموریت مجری‌ها را مشخص می‌کند
      await reportLive?.('سرپرست: طراحی مأموریت‌ها', 20);
      const plan = await callLLMJson<SupervisorPlan>(supervisorPrompt(designOutput, knowledgeSection), {
        system: SYSTEM_SUPERVISOR,
      });
      const missions = Array.isArray(plan.workers) ? plan.workers.slice(0, 3) : [];
      while (missions.length < 3) missions.push('مأموریت پیش‌فرض: خروجی design را با چک‌لیست وایب‌فارسی ممیزی کن.');
      cachedMissions = missions;
    } else {
      await reportLive?.(`دور ${round}: اصلاح با دستور منتقد`, 55);
    }
    const missions = cachedMissions;
    if (!missions) {
      throw new Error('مأموریت‌های سرپرست در کش پیدا نشد.');
    }

    // قدم ۲: سه مجری به‌صورت موازی
    // دستور مستقیم حلقهٔ بیرونی (reviewDirective) بالاترین اولویت را دارد.
    const instruction = combineReviewDirectives(input.reviewDirective, prevInstruction);
    const outputs = (await Promise.all([
      callLLM(worker1Prompt(missions[0], instruction), { system: SYSTEM_WORKER, temperature: 0.3 }),
      callLLM(worker2Prompt(missions[1], instruction), { system: SYSTEM_WORKER, temperature: 0.3 }),
      callLLM(worker3Prompt(missions[2], instruction), { system: SYSTEM_WORKER, temperature: 0.3 }),
    ])) as [string, string, string];
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
    // قدم ۳: منتقد
    await reportLive?.(`منتقد: داوری خروجی (دور ${round})`, 70);
    const verdict = await callLLMJson<CriticVerdict>(
      criticPrompt(output.outputs[0], output.outputs[1], output.outputs[2]),
      {
        system: SYSTEM_CRITIC,
        temperature: 0.2,
      },
    );
    lastVerdict = verdict;
    const reason =
      typeof verdict?.reason === 'string' && verdict.reason.trim()
        ? verdict.reason
        : 'منتقد دلیلی ثبت نکرد.';
    const approved = verdict?.approved === true;
    const score = parseCriticScore(verdict?.score) ?? undefined;

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
        domain: 'استاندارد وایب‌فارسی',
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
    onProgress: (msg) => reportLive?.(msg, 60),
  });

  const verdict: CriticVerdict = lastVerdict ?? {
    approved: false,
    reason: '',
    payload: null,
  };
  const approved = loopResult.approved;
  const reason =
    (typeof verdict.reason === 'string' && verdict.reason.trim()
      ? verdict.reason
      : loopResult.finalOpinion) || 'منتقد دلیلی ثبت نکرد.';

  // قدم ۴: اگر تأیید نشد، کار اصلاح در صف می‌نشیند
  if (!approved) {
    tasks.push({
      title: 'اصلاح انحراف‌های رجیستری وایب‌فارسی',
      description: `منتقد تأیید نکرد: ${reason}`,
      files_hint: 'site/ (کامپوننت‌ها و استایل‌های خارج از رجیستری)',
      priority: 'high',
    });
  }

  // قدم ۵: ثبت یادگیری چرخه در حافظه
  const learned = [
    `نتیجه ممیزی: ${approved ? 'تأیید شد' : 'تأیید نشد'}`,
    `دلیل منتقد: ${reason}`,
    `حلقه در دور ${loopResult.finalRound} تمام شد.`,
    designOutput ? 'ممیزی روی خروجی واقعی تیم design انجام شد.' : 'خروجی design در دسترس نبود.',
  ].join('\n');
  await writeMemory(TEAM, `learned:${runId}`, learned);

  const summary = approved
    ? `ممیزی وایب‌فارسی پاس شد: ${reason} ${lastKnowledgeLog}`
    : `ممیزی وایب‌فارسی رد شد و کار اصلاح در صف نشست: ${reason} ${lastKnowledgeLog}`;

  return {
    team: TEAM,
    summary,
    blockers,
    tasks,
    approved,
  };
}
