/**
 * lib/teams/qa.ts : تیم qa (دروازهٔ کیفیت پیش از main)
 *
 * دروازهٔ کیفیت چرخه: هیچ تغییری بدون گذر از این تیم به main نزدیک نمی‌شود.
 * وابسته به خروجی تیم dev (موج ۴) است؛ همان نوبت توسعه را می‌آزماید.
 * خط لوله، اقتباس تمیز از نودهای ورک‌فلوی n8n ‏«thailandgard-all-teams» است:
 *   حلقه نقد ۳ دوره‌ای (lib/critic-loop.ts):
 *     دور ۱: پارام سرپرست (qa) ← سرپرست ← سه مجری موازی
 *     دور ۲: رد ← دستور دقیق منتقد ← سه مجری اصلاح می‌کنند
 *     دور ۳: فقط نظارت و نظر نهایی (حق رد ندارد)
 *   ← پارس منتقد ← ثبت حافظه (learned:<runId>) ← خروجی تیم / بلوکر
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
  combineReviewDirectives,
  parseCriticScore,
  CRITIC_SCORE_PROMPT_LINE,
  type CriticLoopResult,
  type CriticVerdictV2,
} from '../critic-loop';
import type { ProgressReporter,
  QueuedTask,
  TeamName,
  TeamResult,
} from '../types';

export const TEAM: TeamName = 'qa';

/** مأموریت یک‌خطی تیم. */
export const MISSION: string =
  'دروازهٔ کیفیت پیش از main است؛ هیچ باگی نباید به چشم کاربر برسد، هر تغییر این نوبت را می‌آزماید، تیک انتشار را صادر می‌کند و باگ بحرانی یعنی توقف.';

const SUPERVISOR_SYSTEM = 'تو سرپرست تیم qa تایلندگرد هستی.';
const EXECUTOR_SYSTEM = 'تو مجری تیم qa تایلندگرد هستی.';
const CRITIC_SYSTEM = 'تو منتقد سخت‌گیر تیم qa هستی.';

/** نقش‌های سه مجری؛ اقتباس تمیز از نودهای «پارام مجری ۱/۲/۳ (qa)» ورک‌فلو n8n. */
const EXECUTOR_ROLES: string[] = [
  'تغییرات نوبت قبل را تست می‌کند و گشت دوره‌ای روی کل سایت (لینک شکسته، فرم تماس، موبایل، سرعت) انجام می‌دهد. فقط واقعیت؛ بدون حدس.',
  'سناریوهای DB-driven (قطعی دیتابیس موقع بیلد، رکورد ناقص) را تست می‌کند. فقط واقعیت؛ بدون حدس.',
  'گزارش باگ با شدت و قدم‌های تکرار می‌نویسد و تیک انتشار («آماده است» یا «نیست») صادر می‌کند. فقط واقعیت؛ بدون حدس.',
];

/** ورودی اجرای تیم: شناسهٔ اجرا و خروجی موج‌های قبلی (به‌ویژه dev). */
export interface RunTeamInput {
  /** گزارش زنده‌ی پیشرفت به ارکستر؛ ارکستر همیشه آن را می‌دهد. */
  reportProgress?: ProgressReporter;
  runId: string;
  previousWavesOutput: Partial<Record<TeamName, TeamResult | null>>;
  /**
   * دستور مستقیم منتقد از حلقهٔ بیرونی ارکستراتور (همین چرخه)؛ بالاترین
   * اولویت را دارد و در ابتدای دستور مجری‌ها تزریق می‌شود.
   */
  reviewDirective?: string;
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

/** پارس خروجی منتقد مثل نود «پارس منتقد (qa)» در n8n: استخراج JSON از متن. */
function parseCriticVerdict(text: string): CriticVerdict {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text) as Partial<CriticVerdict>;
    return {
      approved: parsed.approved === true,
      score: parseCriticScore(parsed.score) ?? undefined,
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

/** زمینه برای سرپرست: خلاصهٔ خروجی تیم dev و بلوکرهایش. */
function buildContext(previousWavesOutput: RunTeamInput['previousWavesOutput']): string {
  const dev = previousWavesOutput['dev'];
  const lines: string[] = [];
  lines.push('خلاصهٔ خروجی تیم dev (موج قبلی، همان نوبتی که باید تست شود):');
  lines.push(dev && dev.summary ? dev.summary : 'خروجی ثبت نشده است.');
  if (dev && dev.blockers.length > 0) {
    lines.push('بلوکرهای تیم dev:');
    for (const b of dev.blockers) lines.push(`- ${b}`);
  }
  if (dev && dev.tasks.length > 0) {
    lines.push('تسک‌های باز تیم dev:');
    for (const t of dev.tasks.slice(0, 10)) lines.push(`- ${t.title}`);
  }
  return lines.join('\n');
}

/** نگاشت شدت فارسی/انگلیسی به اولویت صف وظایف. */
function priorityFromSeverity(severity: unknown): QueuedTask['priority'] {
  const s = typeof severity === 'string' ? severity.trim() : '';
  if (/بحرانی|critical/i.test(s)) return 'critical';
  if (/بالا|high/i.test(s)) return 'high';
  if (/متوسط|medium/i.test(s)) return 'medium';
  return 'low';
}

/** استخراج وظایف پیشنهادی از payload منتقد (باگ‌ها و تسک‌ها). */
function tasksFromPayload(payload: unknown): QueuedTask[] {
  if (!payload || typeof payload !== 'object') return [];
  const out: QueuedTask[] = [];
  const record = payload as Record<string, unknown>;

  const bugs = record.bugs;
  if (Array.isArray(bugs)) {
    for (const b of bugs.slice(0, 10)) {
      if (typeof b !== 'object' || b === null) continue;
      const bug = b as Record<string, unknown>;
      const steps = Array.isArray(bug.steps)
        ? bug.steps.filter((x) => typeof x === 'string').join('؛ ')
        : '';
      out.push({
        title: typeof bug.title === 'string' ? bug.title : 'باگ گزارش‌شدهٔ تیم qa',
        description: steps,
        files_hint: typeof bug.files_hint === 'string' ? bug.files_hint : '',
        priority: priorityFromSeverity(bug.severity),
      });
    }
  }

  const items = record.tasks;
  if (Array.isArray(items)) {
    const priorities = ['low', 'medium', 'high', 'critical'] as const;
    for (const t of items.slice(0, 10)) {
      if (typeof t !== 'object' || t === null) continue;
      const task = t as Record<string, unknown>;
      const p = typeof task.priority === 'string' ? task.priority : 'medium';
      out.push({
        title: typeof task.title === 'string' ? task.title : 'یافتهٔ تیم qa',
        description: typeof task.description === 'string' ? task.description : '',
        files_hint: typeof task.files_hint === 'string' ? task.files_hint : '',
        priority: (priorities as readonly string[]).includes(p)
          ? (p as QueuedTask['priority'])
          : 'medium',
      });
    }
  }
  return out;
}

/**
 * تبدیل دلیل ردِ منتقد قدیمی به دستور اجرایی (CriticVerdictV2.instruction).
 * امری و بلندتر از ۵۰ نویسه تا از اعتبارسنجی حلقه رد شود.
 */
function criticInstructionFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی ایراد دارد';
  return [
    `خروجی را بر اساس این نقد اصلاح کن: «${r}»`,
    'هر سه خروجی را بازنویسی کن: باگ بحرانی را مشخص کن و انتشار را متوقف نگه دار؛',
    'گزارش هر باگ را با شدت و قدم‌های تکرار قدم‌به‌قدم و قابل تکرار بنویس؛',
    'تیک انتشار را صادقانه صادر کن («آماده است» یا «نیست») و تست را روی دادهٔ واقعی کاربر انجام نده؛ فقط واقعیت بنویس.',
  ].join(' ');
}

/**
 * تبدیل دلیل رد به معیار قبولی (CriticVerdictV2.acceptance).
 */
function criticAcceptanceFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی ایراد دارد';
  return `وقتی درست است که نقد «${r}» دیگر دربارهٔ خروجی صدق نکند: باگ بحرانی انتشار را متوقف کرده، گزارش‌ها قدم‌به‌قدم قابل تکرارند و تست روی دادهٔ واقعی کاربر انجام نشده است.`;
}

/**
 * اجرای کامل تیم qa برای یک چرخه.
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
        'زمینه (خروجی تیم dev و دانش بازیابی‌شده):',
        ...(knowledgeSection ? [knowledgeSection, ''] : []),
        context,
        '',
        `مأموریت تیم qa: ${MISSION}`,
        '',
        'بر اساس زمینه، تصمیم بگیر این چرخه چه کاری باید انجام شود و آن را به سه مأموریت مجزا برای سه مجری بشکن.',
        'خروجی: فقط JSON معتبر با کلید workers شامل سه مأموریت متنی.',
      ].join('\n');

      await reportLive?.('سرپرست: طراحی مأموریت‌ها', 25);
      const supervisorText = await callLLM(supervisorPrompt, { system: SUPERVISOR_SYSTEM });
      const missions = parseSupervisorWorkers(supervisorText);
      cachedMissions = missions.length === 3 ? missions : EXECUTOR_ROLES.map((r) => r);
    } else {
      await reportLive?.(`دور ${round}: اصلاح با دستور منتقد`, 55);
    }
    const missions = cachedMissions;
    if (!missions) {
      throw new Error('مأموریت‌های سرپرست در کش پیدا نشد.');
    }

    // ۲. سه مجری، موازی، هر کدام با مأموریت خودش.
    // دستور مستقیم حلقهٔ بیرونی (reviewDirective) بالاترین اولویت را دارد.
    const instruction = combineReviewDirectives(input.reviewDirective, prevInstruction);
    const outputs = (await Promise.all(
      missions.map((mission, i) =>
        callLLM(
          [
            ...(instruction
              ? ['دستور منتقد برای اصلاح این دور (حتماً رعایت کن):', instruction, '']
              : []),
            'مأموریت سرپرست:',
            mission,
            '',
            `نقش تو: ${EXECUTOR_ROLES[i] ?? EXECUTOR_ROLES[0]}`,
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
      'داوری کن و فقط JSON معتبر بده با کلیدهای: approved (بولین)، score (عدد ۰ تا ۱۰۰)، reason (یک جمله)، payload.',
      CRITIC_SCORE_PROMPT_LINE,
      'در payload بیاور: release (تیک انتشار: «آماده است» یا «نیست»)، bugs (آرایه‌ای از {title, severity, steps}) و tasks.',
      'تمرکز داوری: آیا باگ بحرانی انتشار را متوقف کرده، گزارش قدم‌به‌قدم قابل تکرار است و تست روی دادهٔ واقعی کاربر انجام نشده؟',
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
        domain: 'کنترل کیفیت',
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

  // ثبت حافظه با کلید learned:<runId>؛ حکم دروازه (تیک انتشار) هم درس است.
  await writeMemory(TEAM, `learned:${runId}`, {
    content: String(lastCriticText).slice(0, 2000),
    approved: loopResult.approved,
    run_id: runId,
    finalRound: loopResult.finalRound,
    rounds: loopResult.verdicts.map((v, i) => ({
      round: i + 1,
      approved: v.approved,
      reason: v.reason || v.finalOpinion || '',
    })),
  });

  // خروجی استاندارد تیم.
  const release = loopResult.approved ? 'آماده است' : 'نیست';
  const summary = reason
    ? `تیک انتشار: ${release}. دروازهٔ کیفیت: ${reason} (حلقه در دور ${loopResult.finalRound} تمام شد)`
    : `تیک انتشار: ${release}. چرخهٔ تست انجام شد. (حلقه در دور ${loopResult.finalRound} تمام شد)`;

  const tasks = tasksFromPayload(verdict.payload);

  if (!loopResult.approved) {
    const blocker = `بلوکر تیم qa: ${reason || 'تیک انتشار صادر نشد.'}`;
    tasks.push({
      title: 'رفع بلوکر تیم qa',
      description: blocker,
      files_hint: '',
      priority: 'critical',
    });
    return {
      team: TEAM,
      summary: `${summary} ${lastKnowledgeLog}`,
      blockers: [blocker],
      tasks,
      approved: false,
    };
  }

  return {
    team: TEAM,
    summary: `${summary} ${lastKnowledgeLog}`,
    blockers: [],
    tasks,
    approved: true,
  };
}
