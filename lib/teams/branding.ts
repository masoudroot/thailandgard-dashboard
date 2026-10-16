/**
 * lib/teams/branding.ts : تیم «صدای برند» تایلندگرد
 *
 * اقتباس از ورک‌فلو n8n: سه خروجی برند (لحن، واژه‌نامهٔ یوایکس‌رایتینگ، شعار)
 * در حلقه نقد ۳ دوره‌ای (lib/critic-loop.ts):
 *   دور ۱: سرپرست ← مجری‌ها (یکجا)
 *   دور ۲: رد ← دستور دقیق منتقد ← مجری‌ها اصلاح می‌کنند
 *   دور ۳: فقط نظارت و نظر نهایی (حق رد ندارد)
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
import type { ProgressReporter, MemoryEntry, QueuedTask, TeamName, TeamResult } from '../types';

export const TEAM: TeamName = 'branding';

export const MISSION =
  'صدای برند تایلندگرد است: لحن برند، واژه‌نامهٔ یوایکس‌رایتینگ و شعار را می‌سازد و حکم‌هایش برای تیم‌های دیزاین و محتوا لازم‌الاجراست.';

export interface TeamInput {
  /** گزارش زنده‌ی پیشرفت به ارکستر؛ ارکستر همیشه آن را می‌دهد. */
  reportProgress?: ProgressReporter;
  cycleId: string;
  runId: string;
  ragContext: string;
  memory: MemoryEntry[];
  previousWavesOutput: Record<string, string>;
}

interface SupervisorPlan {
  workers: [string, string, string];
}

interface CriticVerdict {
  approved: boolean;
  reason: string;
  payload: string;
}

/** خروجی یک دور از مجری‌های حلقه نقد: مأموریت‌ها + خروجی ترکیبی مجری‌ها */
interface WorkerRoundOutput {
  missions: string[];
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
  const prompt = [
    'زمینه:',
    ...(knowledgeSection ? [knowledgeSection, ''] : []),
    input.ragContext || '(زمینه‌ای نیست)',
    '',
    memoryLines ? `یادگیری‌های قبلی:\n${memoryLines}` : '',
    '',
    'مأموریت تیم branding: «صدای» برند است؛ سه خروجی دارد: شعار بر اساس اصول، سند لحن برند، و استاندارد یوایکس‌رایتینگ. حکم‌هایش برای تیم‌های دیزاین و محتوا لازم‌الاجراست.',
    '',
    'بر اساس زمینه و دانش بازیابی‌شده، تصمیم بگیر این چرخه چه کاری باید انجام شود و آن را به سه مأموریت مجزا برای سه مجری بشکن: مجری ۱ (فیلتر لحن برند روی متن‌های زندهٔ سایت و حکم اصلاح مغایرت‌ها)، مجری ۲ (واژه‌نامهٔ یوایکس‌رایتینگ: دکمه، فرم، خطا، حالت خالی، اعلان)، مجری ۳ (شعار بر اساس اصول مصوب با ۳ گزینهٔ نهایی و دلیل انتخاب برای تأیید مسعود).',
    'فقط JSON معتبر بده با کلید workers شامل سه رشتهٔ مأموریت.',
  ]
    .filter((l) => l !== null)
    .join('\n');
  return callLLMJson<SupervisorPlan>(prompt, {
    system: 'تو سرپرست تیم branding تایلندگرد هستی. فقط JSON معتبر می‌دهی؛ بدون حدس.',
    temperature: 0.3,
  });
}

/** حداقل طول قابل‌قبول خروجی مجری (نویسه). */
const MIN_WORKER_OUTPUT_CHARS = 200;

/**
 * هر سه مجری در یک فراخوانی: تحلیل + تولید.
 * (فشرده‌سازی آگاهانه برای سقف ۳ فراخوانی هر چرخه)
 *
 * خروجی خالی/خیلی کوتاه (مدل گاهی فقط چند کلمه می‌دهد) یک بار با دستور
 * صریح «خروجی کامل» تکرار می‌شود؛ اگر باز هم خالی بود، خطا برمی‌گردد تا
 * به‌جای سکوت، بلوکر ثبت شود.
 */
async function executeWorkers(missions: string[], prevInstruction?: string): Promise<string> {
  const prompt = [
    ...(prevInstruction
      ? ['دستور منتقد برای اصلاح این دور (حتماً رعایت کن):', prevInstruction, '']
      : []),
    'مأموریت سرپرست:',
    missions.map((w, i) => `${i + 1}. ${w}`).join('\n'),
    '',
    'نقش تو: مجری تیم branding تایلندگرد. هر سه خروجی زیر را بده؛ فقط واقعیت، بدون حدس:',
    'الف) فیلتر لحن برند: چند متن زندهٔ فرضی سایت را از فیلتر لحن رد کن و به مغایرت‌ها حکم اصلاح بده.',
    'ب) واژه‌نامهٔ یوایکس‌رایتینگ: نمونهٔ استاندارد برای دکمه، فرم، خطا، حالت خالی و اعلان.',
    'پ) شعار: ۳ گزینهٔ نهایی بر اساس اصول مصوب، هر کدام با دلیل انتخاب، برای تأیید مسعود.',
  ].join('\n');
  const system =
    'تو مجری تیم branding تایلندگرد هستی. فارسی تمیز، بدون ادعای بی‌پشتوانه.';
  const first = await callLLM(prompt, { system, temperature: 0.7 });
  if (first.trim().length >= MIN_WORKER_OUTPUT_CHARS) return first;
  // تلاش دوم: خروجی ناقص بود؛ صریح بخواه کامل بدهد
  const second = await callLLM(
    `${prompt}\n\nتأکید: خروجی قبلی‌ات ناقص بود. این بار هر سه بخش (الف، ب، پ) را «کامل و مفصل» بنویس؛ خروجی کوتاه یا خالی قبول نیست.`,
    { system, temperature: 0.7 },
  );
  if (second.trim().length >= MIN_WORKER_OUTPUT_CHARS) return second;
  throw new Error(
    `مجری خروجی خالی/ناقص برگرداند (${second.trim().length} نویسه پس از دو تلاش)`,
  );
}

/** مأموریت‌های امن از خروجی سرپرست: اگر آرایه‌ی معتبر نبود، خالی. */
function safeMissions(plan: unknown): string[] {
  const workers =
    plan && typeof plan === 'object'
      ? (plan as { workers?: unknown }).workers
      : undefined;
  if (!Array.isArray(workers)) return [];
  return workers
    .map((w) => (typeof w === 'string' ? w.trim() : String(w ?? '').trim()))
    .filter((w) => w.length > 0);
}

/** منتقد سخت‌گیر: آیا متن با لحن برند می‌خواند و شعار از کلیشه، موعظه و ادعای بی‌پشتوانه پاک است؟ */
async function judgeWorkers(workersOutput: string): Promise<CriticVerdict> {
  const prompt = [
    'خروجی مجری‌ها:',
    workersOutput,
    '',
    'داوری کن و فقط JSON معتبر بده با کلیدهای: approved (بولین)، reason (یک جمله)، payload (متن نهایی تأییدشده یا اصلاح‌شده).',
    'تمرکز داوری: آیا متن با لحن برند می‌خواند و شعار از کلیشه، موعظه و ادعای بی‌پشتوانه پاک است؟',
  ].join('\n');
  return callLLMJson<CriticVerdict>(prompt, {
    system: 'تو منتقد سخت‌گیر تیم branding هستی. فقط JSON معتبر می‌دهی.',
    temperature: 0.2,
  });
}

/** یادگیری چرخه در حافظه با کلید learned:<runId>. */
async function remember(runId: string, lesson: string): Promise<void> {
  await writeMemory(TEAM, `learned:${runId}`, lesson);
}

/**
 * تبدیل دلیل ردِ منتقد قدیمی به دستور اجرایی (CriticVerdictV2.instruction).
 * امری و بلندتر از ۵۰ نویسه تا از اعتبارسنجی حلقه رد شود.
 */
function criticInstructionFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی ایراد دارد';
  return [
    `خروجی را بر اساس این نقد اصلاح کن: «${r}»`,
    'هر سه بخش را بازنویسی کن: فیلتر لحن را روی متن‌های زنده اعمال کن و به هر مغایرت حکم اصلاح بده؛',
    'واژه‌نامهٔ یوایکس‌رایتینگ را برای دکمه، فرم، خطا، حالت خالی و اعلان کامل و یکدست بنویس؛',
    '۳ گزینهٔ شعار را بدون کلیشه، موعظه و ادعای بی‌پشتوانه بازنویسی کن و برای هر کدام دلیل انتخاب بنویس.',
  ].join(' ');
}

/**
 * تبدیل دلیل رد به معیار قبولی (CriticVerdictV2.acceptance).
 */
function criticAcceptanceFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی ایراد دارد';
  return `وقتی درست است که نقد «${r}» دیگر دربارهٔ خروجی صدق نکند: متن با لحن برند می‌خواند و شعار از کلیشه، موعظه و ادعای بی‌پشتوانه پاک است.`;
}

export async function runTeam(input: TeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;
  await reportLive?.('سرپرست: طراحی مأموریت‌ها', 15);
  const plan = await makeSupervisorPlan(input);
  const tasks: QueuedTask[] = [];
  const blockers: string[] = [];

  const missions = safeMissions(plan);
  if (missions.length === 0) {
    const msg = 'سرپرست مأموریت معتبری نداد (خروجی JSON ناقص)؛ کار به چرخهٔ بعد موکول شد.';
    blockers.push(msg);
    return { team: TEAM, summary: msg, blockers, tasks, approved: false };
  }

  // ---------- توابع حلقه نقد ----------

  /**
   * runWorkers: مجری‌های ترکیبی هر دور.
   * دور ۱: همان مأموریت‌های سرپرست؛ دور ۲/۳: اصلاح با دستور منتقد.
   */
  const runWorkers = async (
    round: number,
    prevInstruction?: string,
  ): Promise<WorkerRoundOutput> => {
    await reportLive?.(
      round === 1 ? 'مجری‌ها: اجرای مأموریت‌ها' : `دور ${round}: اصلاح با دستور منتقد`,
      50,
    );
    const workersOutput = await executeWorkers(missions, prevInstruction);
    return { missions, workersOutput };
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
    const rawVerdict = await judgeWorkers(output.workersOutput);
    // حکم ناقص LLM نباید «undefined» چاپ کند یا مسیر اشتباه برود
    const verdict = {
      approved: rawVerdict?.approved === true,
      reason:
        typeof rawVerdict?.reason === 'string' && rawVerdict.reason.trim()
          ? rawVerdict.reason
          : '(دلیل ثبت نشد)',
      payload: typeof rawVerdict?.payload === 'string' ? rawVerdict.payload : '',
    };
    const reason = verdict.reason;

    if (round === 3) {
      return {
        approved: true,
        reason: '',
        instruction: '',
        acceptance: '',
        finalOpinion: reason,
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
        domain: 'لحن برند و شعار',
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
  let loopResult: CriticLoopResult<WorkerRoundOutput>;
  try {
    loopResult = await runCriticLoop<WorkerRoundOutput>({
      team: TEAM,
      runId: input.runId,
      runWorkers,
      runCritic,
      onRoundKnowledge,
      onProgress: (msg) => reportLive?.(msg, 70),
    });
  } catch (err) {
    const msg = `مجری خروجی معتبر نداد: ${err instanceof Error ? err.message : String(err)}؛ کار به چرخهٔ بعد موکول شد.`;
    blockers.push(msg);
    return { team: TEAM, summary: msg, blockers, tasks, approved: false };
  }

  const finalVerdict = loopResult.verdicts[loopResult.verdicts.length - 1];
  const reason = finalVerdict.reason || finalVerdict.finalOpinion || '(دلیل ثبت نشد)';

  if (!loopResult.approved) {
    blockers.push(`منتقد branding تأیید نکرد: ${reason}`);
  } else {
    tasks.push(
      {
        title: 'تأیید شعارهای پیشنهادی توسط مسعود',
        description:
          '۳ گزینهٔ شعار نهایی با دلیل انتخاب برای تأیید مسعود آماده است؛ بعد از انتخاب، در سند برند ثبت شود.',
        files_hint: 'brand/slogan.md',
        priority: 'high',
      },
      {
        title: 'به‌روزرسانی واژه‌نامهٔ یوایکس‌رایتینگ',
        description:
          'نمونه‌های استاندارد دکمه، فرم، خطا، حالت خالی و اعلان در واژه‌نامهٔ برند ثبت یا به‌روز شود.',
        files_hint: 'brand/ux-glossary.md',
        priority: 'medium',
      },
      {
        title: 'اعمال حکم‌های اصلاح لحن روی متن‌های سایت',
        description:
          'مغایرت‌های لحنی پیدا شده در متن‌های زندهٔ سایت اصلاح شود تا با سند لحن برند بخواند.',
        files_hint: 'site/content/**',
        priority: 'medium',
      },
    );
  }

  const lesson = loopResult.approved
    ? `چرخهٔ موفق: ${reason} (حلقه در دور ${loopResult.finalRound} تمام شد)`
    : `رد منتقد: ${reason} (حلقه در دور ${loopResult.finalRound} با نظر نهایی تمام شد)`;
  await remember(input.runId, lesson);

  const summary = loopResult.approved
    ? `تیم برندینگ این چرخه شعار، واژه‌نامهٔ یوایکس‌رایتینگ و فیلتر لحن را بازبینی و تولید کرد و منتقد آن را تأیید کرد. ${reason} ۳ گزینهٔ شعار نهایی برای تأیید مسعود آماده است و دو کار بعدی (واژه‌نامه و اصلاح لحن متن‌ها) در صف گذاشته شد. ${lastKnowledgeLog}`
    : `تیم برندینگ این چرخه خروجی تولید کرد ولی منتقد آن را تأیید نکرد و کار به چرخهٔ بعد موکول شد. دلیل: ${reason} حکم اصلاح لحن برای متن‌های زنده ثبت شده و بلوکر در گزارش درج شد. ${lastKnowledgeLog}`;

  return {
    team: TEAM,
    summary,
    blockers,
    tasks: tasks.slice(0, 3),
    approved: loopResult.approved,
  };
}
