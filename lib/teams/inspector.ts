/**
 * lib/teams/inspector.ts: تیم inspector (بازرس سایت زنده)
 *
 * آخرین تیم چرخه (موج ۶) و وابسته به خروجی موج‌های قبلی، به‌ویژه qa.
 * خط لوله، اقتباس تمیز از ورک‌فلوی n8n است:
 *   حلقه نقد ۳ دوره‌ای (lib/critic-loop.ts):
 *     دور ۱: سرپرست (تقسیم کار به سه مأموریت) ← سه مجری موازی
 *     دور ۲: رد ← دستور دقیق منتقد ← سه مجری اصلاح می‌کنند
 *     دور ۳: فقط نظارت و نظر نهایی (حق رد ندارد)
 *   ← ثبت حافظه (learned:<runId>) ← خروجی تیم / بلوکر
 *
 * با qa فرق دارد: qa خروجی همان اجراست، بازرس سلامت کل سایت است.
 */

import { callLLM } from '../llm';
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
import type { ProgressReporter,
  QueuedTask,
  TeamName,
  TeamResult,
} from '../types';

export const TEAM: TeamName = 'inspector';

/** مأموریت یک‌خطی تیم. */
export const MISSION: string =
  'چشم همیشه‌باز روی سایت زنده و بیلدشده است؛ رندر را می‌بیند، اسکرین‌شات را وارسی می‌کند، رگرسیون شکار می‌کند و یافتهٔ لازم‌الاجرا به تیم مالک می‌دهد.';

const SUPERVISOR_SYSTEM = 'تو سرپرست تیم inspector تایلندگرد هستی.';
const EXECUTOR_SYSTEM = 'تو مجری تیم inspector تایلندگرد هستی.';
const CRITIC_SYSTEM = 'تو منتقد سخت‌گیر تیم inspector هستی.';

/** مأموریت‌های سه‌گانهٔ مجری‌ها، اقتباس‌شده از پرامپت‌های n8n. */
const EXECUTOR_MISSIONS: string[] = [
  'گشت چرخشی روی مسیرهای اصلی با نردبان نگاه انجام بده: رندر نه سورس، اسکرین‌شات، چشم زنده. فقط واقعیت؛ بدون حدس.',
  'یافته‌ها را با شاهد (اسکرین‌شات/HTML/URL) با شدت و ضرب‌الاجل (SLA) ثبت کن. فقط واقعیت؛ بدون حدس.',
  '«بازبینی بست» انجام بده: یافته فقط با راستی‌آزمایی مجدد خود بازرس بسته می‌شود. فقط واقعیت؛ بدون حدس.',
];

/** ورودی اجرای تیم: شناسهٔ اجرا و خروجی موج‌های قبلی. */
export interface RunTeamInput {
  /** گزارش زنده‌ی پیشرفت به ارکستر؛ ارکستر همیشه آن را می‌دهد. */
  reportProgress?: ProgressReporter;
  runId: string;
  previousWavesOutput: Partial<Record<TeamName, TeamResult | null>>;
}

interface CriticVerdict {
  approved: boolean;
  reason: string;
  payload?: unknown;
}

/** خروجی یک دور از مجری‌های حلقه نقد: مأموریت‌ها + خروجی هر سه مجری */
interface WorkerRoundOutput {
  missions: string[];
  outputs: [string, string, string];
}

/** پارس خروجی منتقد مثل نود «پارس منتقد» در n8n: استخراج JSON از متن. */
function parseCriticVerdict(text: string): CriticVerdict {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text) as Partial<CriticVerdict>;
    return {
      approved: parsed.approved === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      payload: parsed.payload,
    };
  } catch {
    return { approved: false, reason: 'JSON نامعتبر', payload: text.slice(0, 500) };
  }
}

/** پارس پاسخ سرپرست: آرایه‌ای از سه مأموریت متنی. */
function parseSupervisorWorkers(text: string): string[] {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text) as {
      workers?: Array<string | { mission?: string }>;
    };
    const workers = Array.isArray(parsed.workers) ? parsed.workers : [];
    return workers
      .map((w) => (typeof w === 'string' ? w : w?.mission ?? ''))
      .filter((w) => w.length > 0);
  } catch {
    return [];
  }
}

/** زمینه برای سرپرست: خلاصهٔ خروجی qa و بقیهٔ موج‌های قبلی. */
function buildContext(previousWavesOutput: RunTeamInput['previousWavesOutput']): string {
  const qa = previousWavesOutput['qa'];
  const lines: string[] = [];
  lines.push('خلاصهٔ خروجی تیم qa (موج قبلی):');
  lines.push(qa ? qa.summary : 'خروجی ثبت نشده است.');
  if (qa && qa.blockers.length > 0) {
    lines.push('بلوکرهای qa:');
    for (const b of qa.blockers) lines.push(`- ${b}`);
  }
  return lines.join('\n');
}

/** استخراج وظایف پیشنهادی از payload منتقد، در صورت وجود. */
function tasksFromPayload(payload: unknown): QueuedTask[] {
  if (!payload || typeof payload !== 'object') return [];
  const items = (payload as { tasks?: unknown }).tasks;
  if (!Array.isArray(items)) return [];
  const priorities = ['low', 'medium', 'high', 'critical'] as const;
  return items
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
    .slice(0, 10)
    .map((t) => {
      const p = typeof t.priority === 'string' ? t.priority : 'medium';
      return {
        title: typeof t.title === 'string' ? t.title : 'یافتهٔ بازرس',
        description: typeof t.description === 'string' ? t.description : '',
        files_hint: typeof t.files_hint === 'string' ? t.files_hint : '',
        priority: (priorities as readonly string[]).includes(p)
          ? (p as QueuedTask['priority'])
          : 'medium',
      };
    });
}

/**
 * تبدیل دلیل ردِ منتقد قدیمی به دستور اجرایی (CriticVerdictV2.instruction).
 * امری و بلندتر از ۵۰ نویسه تا از اعتبارسنجی حلقه رد شود.
 */
function criticInstructionFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی ایراد دارد';
  return [
    `خروجی را بر اساس این نقد اصلاح کن: «${r}»`,
    'هر سه خروجی را بازنویسی کن: به هر یافته شاهد (اسکرین‌شات/HTML/URL) اضافه کن؛',
    'شدت و ضرب‌الاجل (SLA) هر یافته را درست بنویس؛',
    'ادعای «حل شد» تیم مالک را بدون بازبینی مجدد خودت نپذیر؛ فقط واقعیت بنویس، بدون حدس.',
  ].join(' ');
}

/**
 * تبدیل دلیل رد به معیار قبولی (CriticVerdictV2.acceptance).
 */
function criticAcceptanceFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی ایراد دارد';
  return `وقتی درست است که نقد «${r}» دیگر دربارهٔ خروجی صدق نکند: هر یافته شاهد دارد، شدت و ضرب‌الاجل درست خورده و ادعای «حل شد» بدون بازبینی پذیرفته نشده است.`;
}

/**
 * اجرای کامل تیم inspector برای یک چرخه.
 * (مهاجرت به حلقه نقد ۳ دوره‌ای lib/critic-loop.ts)
 */
export async function runTeam(input: RunTeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;
  const { runId, previousWavesOutput } = input;
  const context = buildContext(previousWavesOutput);

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
  // داوری خام و متن خام آخرین دور (برای تسک‌ها، بلوکرها و حافظه)
  let lastVerdict: CriticVerdict | null = null;
  let lastCriticText = '';

  /**
   * runWorkers: سرپرست (دور ۱) + سه مجری موازی هر دور.
   */
  const runWorkers = async (
    round: number,
    prevInstruction?: string,
  ): Promise<WorkerRoundOutput> => {
    if (round === 1) {
      // ۱. سرپرست: شکستن کار این چرخه به سه مأموریت مجزا برای سه مجری.
      const supervisorPrompt = [
        'زمینه (خروجی موج‌های قبلی و دانش بازیابی‌شده):',
        ...(knowledgeSection ? [knowledgeSection, ''] : []),
        context,
        '',
        `مأموریت تیم inspector: ${MISSION}`,
        'با qa فرق دارد: qa خروجی همان اجراست، بازرس سلامت کل سایت است.',
        '',
        'بر اساس زمینه، تصمیم بگیر این چرخه چه کاری باید انجام شود و آن را به سه مأموریت مجزا برای سه مجری بشکن.',
        'خروجی: فقط JSON معتبر با کلید workers شامل سه مأموریت متنی.',
      ].join('\n');

      await reportLive?.('سرپرست: طراحی مأموریت‌ها', 25);
      const supervisorText = await callLLM(supervisorPrompt, { system: SUPERVISOR_SYSTEM });
      const missions = parseSupervisorWorkers(supervisorText);
      cachedMissions = missions.length === 3 ? missions : EXECUTOR_MISSIONS;
    } else {
      await reportLive?.(`دور ${round}: اصلاح با دستور منتقد`, 55);
    }
    const missions = cachedMissions;
    if (!missions) {
      throw new Error('مأموریت‌های سرپرست در کش پیدا نشد.');
    }

    // ۲. سه مجری، موازی، هر کدام با مأموریت خودش.
    const outputs = (await Promise.all(
      missions.map((mission, i) =>
        callLLM(
          [
            ...(prevInstruction
              ? ['دستور منتقد برای اصلاح این دور (حتماً رعایت کن):', prevInstruction, '']
              : []),
            'مأموریت سرپرست:',
            mission,
            '',
            `نقش تو: ${EXECUTOR_MISSIONS[i]}`,
          ].join('\n'),
          { system: EXECUTOR_SYSTEM },
        ),
      ),
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
    const criticPrompt = [
      'خروجی مجری ۱:',
      output.outputs[0],
      '',
      'خروجی مجری ۲:',
      output.outputs[1],
      '',
      'خروجی مجری ۳:',
      output.outputs[2],
      '',
      'داوری کن و فقط JSON معتبر بده با کلیدهای: approved (بولین)، reason (یک جمله)، payload.',
      'تمرکز داوری: آیا هر یافته شاهد دارد، شدت و ضرب‌الاجل درست خورده و ادعای «حل شد» تیم مالک بدون بازبینی پذیرفته نشده؟',
    ].join('\n');

    await reportLive?.(`منتقد: داوری خروجی (دور ${round})`, 70);
    const criticText = await callLLM(criticPrompt, {
      system: CRITIC_SYSTEM,
      temperature: 0.2,
    });
    const verdict = parseCriticVerdict(criticText);
    lastVerdict = verdict;
    lastCriticText = criticText;
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
        domain: 'بازرسی نهایی',
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
    reason: 'داوری ثبت نشد.',
    payload: null,
  };
  const reason = verdict.reason || 'منتقد دلیلی ثبت نکرد.';

  // ثبت حافظه با کلید learned:<runId> (غنی‌شده با تاریخچه دورهای حلقه)
  const memoryValue = {
    content: String(lastCriticText).slice(0, 2000),
    approved: loopResult.approved,
    run_id: runId,
    finalRound: loopResult.finalRound,
    rounds: loopResult.verdicts.map((v, i) => ({
      round: i + 1,
      approved: v.approved,
      reason: v.reason || v.finalOpinion || '',
    })),
  };
  await writeMemory(TEAM, `learned:${runId}`, memoryValue);

  // خروجی استاندارد تیم.
  const summary = reason
    ? `بازرس سایت زنده: ${reason} (حلقه در دور ${loopResult.finalRound} تمام شد) ${lastKnowledgeLog}`
    : `بازرس سایت زنده: چرخهٔ بازرسی انجام شد. (حلقه در دور ${loopResult.finalRound} تمام شد) ${lastKnowledgeLog}`;

  if (!loopResult.approved) {
    const tasks = tasksFromPayload(verdict.payload);
    tasks.push({
      title: 'رفع بلوکر تیم inspector',
      description: `بلوکر تیم inspector: ${reason}`,
      files_hint: '',
      priority: 'critical',
    });
    return {
      team: TEAM,
      summary,
      blockers: [`بلوکر تیم inspector: ${reason}`],
      tasks,
      approved: false,
    };
  }

  return {
    team: TEAM,
    summary,
    blockers: [],
    tasks: tasksFromPayload(verdict.payload),
    approved: true,
  };
}
