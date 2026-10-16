/**
 * lib/teams/lead.ts: تیم «عملیات لید و SLA» تایلندگرد
 *
 * اقتباس از ورک‌فلو n8n:
 * حلقه نقد ۳ دوره‌ای (lib/critic-loop.ts):
 *   دور ۱: سرپرست ← ۳ مجری موازی (پایش، SLA، تبدیل)
 *   دور ۲: رد ← دستور دقیق منتقد ← ۳ مجری اصلاح می‌کنند
 *   دور ۳: فقط نظارت و نظر نهایی (حق رد ندارد)
 * قانون حریم خصوصی: در هیچ خروجی (خلاصه، هشدار، تسک، حافظه) شماره تماس یا
 * اطلاعات شخصی نمی‌آید؛ فقط شناسهٔ لید. تابع sanitizePII این را در کد تضمین می‌کند.
 */

import { callLLM, callLLMJson } from '../llm';
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

export const TEAM: TeamName = 'lead';

export const MISSION =
  'صاحب عملیات نیمهٔ دوم قیف است (از کلیک تماس تا تماس موفق): لیدهای تازه را پایش می‌کند، SLA را کنترل می‌کند و هشدار می‌دهد؛ خودش تماس نمی‌گیرد.';

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

interface CriticPayload {
  summary: string;
  alerts: string[];
  tasks: string[];
}

interface CriticVerdict {
  approved: boolean;
  reason: string;
  payload: CriticPayload;
}

/** خروجی یک دور از مجری‌های حلقه نقد: مأموریت‌ها + خروجی هر سه مجری */
interface WorkerRoundOutput {
  missions: [string, string, string];
  outputs: [string, string, string];
}

/**
 * حذف شماره تماس (لاتین و فارسی) از هر متنی که به گزارش یا حافظه می‌رود.
 * قانون تیم: در گزارش فقط شناسهٔ لید می‌آید، نه شماره تماس.
 * ورودی غیررشته‌ای (خروجی ناقص LLM) به رشته‌ی امن تبدیل می‌شود تا
 * فراخوانی‌های بعدی (.slice و .replace) روی undefined نیفتند.
 */
function sanitizePII(text: unknown): string {
  const s = typeof text === 'string' ? text : String(text ?? '');
  return s
    .replace(/\b09\d{9}\b/g, '(شمارهٔ مخفی)')
    .replace(/\b۰۹[۰-۹]{9}\b/g, '(شمارهٔ مخفی)');
}

/** آرایه‌ی امن از خروجی LLM: اگر آرایه نبود، آرایه‌ی خالی. */
function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === 'string' ? v : String(v ?? '')));
}

/** سرپرست: از زمینه، سه مأموریت مجزا برای سه مجری می‌سازد. */
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
  const priorLines = Object.entries(input.previousWavesOutput)
    .map(([team, out]) => `- ${team}: ${out}`)
    .join('\n');
  const prompt = [
    'زمینه:',
    ...(knowledgeSection ? [knowledgeSection, ''] : []),
    input.ragContext || '(زمینه‌ای نیست)',
    '',
    memoryLines ? `یادگیری‌های قبلی:\n${memoryLines}` : '',
    priorLines ? `خروجی تیم‌های موج‌های قبلی:\n${priorLines}` : '',
    '',
    'مأموریت تیم lead: صاحب عملیات نیمهٔ دوم قیف است (از کلیک تماس تا تماس موفق)؛ لیدهای تازه را پایش می‌کند، SLA را کنترل می‌کند و هشدار می‌دهد. خودش تماس نمی‌گیرد.',
    '',
    'بر اساس زمینه و دانش بازیابی‌شده، تصمیم بگیر این چرخه چه کاری باید انجام شود و آن را به سه مأموریت مجزا برای سه مجری بشکن: مجری ۱ (پایش جدول leads: لیدهای تازه و وضعیت‌ها)، مجری ۲ (کنترل SLA: هشدار فوری اگر لیدی بیش از ۶ ساعت «تازه» بماند و به‌روزرسانی وضعیت‌ها)، مجری ۳ (بازخورد بهبود تبدیل: فرم، دکمه، مسیر تماس).',
    'فقط JSON معتبر بده با کلید workers شامل سه رشتهٔ مأموریت.',
  ]
    .filter((l) => l !== '')
    .join('\n');
  return callLLMJson<SupervisorPlan>(prompt, {
    system: 'تو سرپرست تیم lead تایلندگرد هستی. فقط JSON معتبر می‌دهی؛ بدون حدس.',
    temperature: 0.3,
  });
}

const WORKER_SYSTEM = 'تو مجری تیم lead تایلندگرد هستی. فارسی تمیز، بدون ادعای بی‌پشتوانه.';

/** سه مجری موازی (منطق فعلی، بدون تغییر). */
async function executeWorkers(
  missions: [string, string, string],
  prevInstruction?: string,
): Promise<[string, string, string]> {
  const instructionBlock = prevInstruction
    ? ['دستور منتقد برای اصلاح این دور (حتماً رعایت کن):', prevInstruction, '']
    : [];
  return (await Promise.all([
    callLLM(
      [
        ...instructionBlock,
        'مأموریت سرپرست:',
        missions[0] || '(مأموریتی تعیین نشده؛ جدول leads را پایش کن)',
        '',
        'نقش تو: جدول leads را در این چرخه پایش می‌کنی؛ لیدهای تازه و وضعیت‌ها را فهرست می‌کنی. فقط واقعیت؛ بدون حدس.',
      ].join('\n'),
      { system: WORKER_SYSTEM, temperature: 0.5 },
    ),
    callLLM(
      [
        ...instructionBlock,
        'مأموریت سرپرست:',
        missions[1] || '(مأموریتی تعیین نشده؛ SLA لیدها را کنترل کن)',
        '',
        'نقش تو: SLA را کنترل می‌کنی؛ اگر لیدی بیش از ۶ ساعت در وضعیت «تازه» بماند، هشدار فوری می‌دهی و وضعیت‌ها را به‌روز می‌کنی. فقط واقعیت؛ بدون حدس.',
      ].join('\n'),
      { system: WORKER_SYSTEM, temperature: 0.2 },
    ),
    callLLM(
      [
        ...instructionBlock,
        'مأموریت سرپرست:',
        missions[2] || '(مأموریتی تعیین نشده؛ بازخورد بهبود تبدیل بنویس)',
        '',
        'نقش تو: بازخورد بهبود تبدیل می‌نویسی (فرم، دکمه، مسیر تماس). قانون حریم خصوصی: در گزارش فقط شناسهٔ لید می‌آید، هرگز شماره تماس یا اطلاعات شخصی. فقط واقعیت؛ بدون حدس.',
      ].join('\n'),
      { system: WORKER_SYSTEM, temperature: 0.7 },
    ),
  ])) as [string, string, string];
}

/** منتقد سخت‌گیر: هیچ لیدی گم نشده؟ هشدار SLA به‌موقع بود؟ اطلاعات شخصی نیامده؟ */
async function judgeWorkers(outputs: [string, string, string]): Promise<CriticVerdict> {
  const prompt = [
    'خروجی مجری ۱:',
    outputs[0],
    '',
    'خروجی مجری ۲:',
    outputs[1],
    '',
    'خروجی مجری ۳:',
    outputs[2],
    '',
    'داوری کن و فقط JSON معتبر بده با کلیدهای: approved (بولین)، reason (یک جمله)، payload (شیئی با کلیدهای summary رشته‌ای، alerts آرایه‌ای از هشدارهای SLA، tasks آرایه‌ای از پیشنهادهای بهبود تبدیل).',
    'تمرکز داوری: آیا هیچ لیدی گم نشده، هشدار SLA به‌موقع صادر شده و اطلاعات شخصی در گزارش نیامده؟',
  ].join('\n');
  return callLLMJson<CriticVerdict>(prompt, {
    system: 'تو منتقد سخت‌گیر تیم lead هستی. فقط JSON معتبر می‌دهی.',
    temperature: 0.2,
  });
}

/** نرمال‌سازی حکم منتقد: خروجی ناقص/نامعتبر LLM هرگز نباید تیم را بیندازد. */
function normalizeVerdict(v: unknown): CriticVerdict {
  const o =
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Partial<CriticVerdict>) : {};
  const payload =
    o.payload && typeof o.payload === 'object' && !Array.isArray(o.payload)
      ? (o.payload as Partial<CriticPayload>)
      : {};
  return {
    approved: o.approved === true,
    reason: typeof o.reason === 'string' ? o.reason : '',
    payload: {
      summary: typeof payload.summary === 'string' ? payload.summary : '',
      alerts: Array.isArray(payload.alerts) ? payload.alerts : [],
      tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
    },
  };
}

/** یادگیری چرخه در حافظه؛ اگر ماژول حافظه هنوز ساخته نشده باشد، بی‌صدا رد می‌شود. */
async function remember(runId: string, lesson: string): Promise<void> {
  try {
    const mod = (await import('../memory')) as {
      writeMemory?: (team: TeamName, key: string, value: string) => Promise<unknown>;
    };
    await mod.writeMemory?.(TEAM, `learned:${runId}`, lesson);
  } catch {
    // ماژول حافظه هنوز در این ریپو ساخته نشده؛ چیزی گم نمی‌شود.
  }
}

/**
 * تبدیل دلیل ردِ منتقد قدیمی به دستور اجرایی (CriticVerdictV2.instruction).
 * امری و بلندتر از ۵۰ نویسه تا از اعتبارسنجی حلقه رد شود.
 */
function criticInstructionFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی ایراد دارد';
  return [
    `خروجی را بر اساس این نقد اصلاح کن: «${r}»`,
    'هر سه خروجی را بازنویسی کن: هیچ لیدی را گم نکن؛',
    'هشدار SLA را برای هر لید بالای ۶ ساعت «تازه» به‌موقع صادر کن؛',
    'در گزارش فقط شناسهٔ لید بنویس و هرگز شماره تماس یا اطلاعات شخصی نیاور؛ فقط واقعیت بنویس.',
  ].join(' ');
}

/**
 * تبدیل دلیل رد به معیار قبولی (CriticVerdictV2.acceptance).
 */
function criticAcceptanceFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی ایراد دارد';
  return `وقتی درست است که نقد «${r}» دیگر دربارهٔ خروجی صدق نکند: هیچ لیدی گم نشده، هشدار SLA به‌موقع صادر شده و اطلاعات شخصی در گزارش نیامده است.`;
}

export async function runTeam(input: TeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;

  // ---------- توابع حلقه نقد ----------

  // کش دور ۱: مأموریت‌های سرپرست در هر چرخه یک بار ساخته می‌شوند؛
  // دورهای ۲ و ۳ همان مأموریت‌ها را با دستور منتقد اصلاح می‌کنند.
  let cachedMissions: [string, string, string] | null = null;
  // داوری خام آخرین دور (برای تسک‌ها، بلوکرها و خلاصه)
  let lastVerdict: CriticVerdict | null = null;

  /**
   * runWorkers: سرپرست (دور ۱) + سه مجری موازی هر دور.
   */
  const runWorkers = async (
    round: number,
    prevInstruction?: string,
  ): Promise<WorkerRoundOutput> => {
    if (round === 1) {
      await reportLive?.('سرپرست: طراحی مأموریت‌ها', 15);
      const plan = await makeSupervisorPlan(input);
      const rawWorkers =
        plan && typeof plan === 'object' && Array.isArray(plan.workers) ? plan.workers : [];
      const [mission1 = '', mission2 = '', mission3 = ''] = rawWorkers.map((w) =>
        typeof w === 'string' ? w : String(w ?? ''),
      );
      cachedMissions = [mission1, mission2, mission3];
    } else {
      await reportLive?.(`دور ${round}: اصلاح با دستور منتقد`, 50);
    }
    const missions = cachedMissions;
    if (!missions) {
      throw new Error('مأموریت‌های سرپرست در کش پیدا نشد.');
    }

    await reportLive?.('مجری‌ها: پایش، SLA و تبدیل', 55);
    // دستور صریح حلقهٔ بیرونی (ارکستراتور) در همین چرخه — اولویت بالا، جدا از ragContext.
    const outerDirective = input.reviewDirective?.trim()
      ? `دستور مستقیم منتقد از حلقهٔ بیرونی (همین چرخه — بالاترین اولویت، حتماً اعمال کن):\n${input.reviewDirective.trim()}`
      : undefined;
    const combinedInstruction = [outerDirective, prevInstruction]
      .filter(Boolean)
      .join('\n\n');
    const outputs = await executeWorkers(missions, combinedInstruction || undefined);
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
    await reportLive?.(`منتقد: داوری خروجی (دور ${round})`, 80);
    const verdict = normalizeVerdict(await judgeWorkers(output.outputs));
    lastVerdict = verdict;
    const reason = verdict.reason || 'منتقد دلیلی ثبت نکرد.';

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
        domain: 'جذب لید',
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

  const verdict = lastVerdict ?? normalizeVerdict(null);

  const safeReason = sanitizePII(verdict.reason ?? '');
  const payload: CriticPayload = {
    summary: sanitizePII(verdict.payload?.summary ?? ''),
    alerts: safeStringArray(verdict.payload?.alerts).map(sanitizePII),
    tasks: safeStringArray(verdict.payload?.tasks).map(sanitizePII),
  };

  const blockers: string[] = [];
  const tasks: QueuedTask[] = [];

  if (!loopResult.approved) {
    blockers.push(`منتقد lead تأیید نکرد: ${safeReason}`);
    blockers.push(...payload.alerts);
  } else {
    blockers.push(...payload.alerts);
    for (const taskText of payload.tasks.slice(0, 3)) {
      tasks.push({
        title: taskText.length > 80 ? `${taskText.slice(0, 77)}...` : taskText,
        description: taskText,
        files_hint: 'site/components/**',
        priority: 'medium',
      });
    }
  }

  const lesson = loopResult.approved
    ? `چرخهٔ موفق: ${safeReason} | هشدار SLA: ${payload.alerts.length} مورد (حلقه در دور ${loopResult.finalRound} تمام شد)`
    : `رد منتقد: ${safeReason} | هشدار SLA: ${payload.alerts.length} مورد (حلقه در دور ${loopResult.finalRound} با نظر نهایی تمام شد)`;
  await remember(input.runId, sanitizePII(lesson));

  const summary = loopResult.approved
    ? `تیم لید این چرخه لیدهای تازه و وضعیت‌ها را پایش کرد، SLA را کنترل کرد و ${payload.alerts.length} هشدار ثبت شد؛ منتقد تأیید کرد. دلیل: ${safeReason} ${lastKnowledgeLog}`
    : `تیم لید این چرخه خروجی تولید کرد؛ منتقد در ${loopResult.finalRound} دور همین چرخه تأیید نکرد و نظر نهایی داد. دلیل: ${safeReason} دانش به‌روز شد و بلوکر در گزارش همین چرخه درج شد. ${lastKnowledgeLog}`;

  return {
    team: TEAM,
    summary: sanitizePII(summary),
    blockers,
    tasks,
    approved: loopResult.approved,
  };
}
