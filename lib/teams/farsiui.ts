/**
 * lib/teams/farsiui.ts: تیم ۱۱، farsiui
 *
 * ممیز فارسی‌نویسی و راست‌چین تایلندگرد.
 * خروجی موج‌های قبلی (متن‌های تیم content) را می‌گیرد؛ حلقه نقد ۳ دوره‌ای
 * (lib/critic-loop.ts):
 *   دور ۱: سرپرست کار را به سه مأموریت می‌شکند ← سه مجری موازی (متن رابط،
 *          قاعدهٔ عدد و لیبل و جهت، سند پیام‌ها)
 *   دور ۲: رد ← دستور دقیق منتقد ← سه مجری اصلاح می‌کنند
 *   دور ۳: فقط نظارت و نظر نهایی (حق رد ندارد)
 * منتقد داوری می‌کند و نتیجه با کلید learned:<runId> در حافظهٔ تیم ثبت می‌شود.
 *
 * اقتباس از ورک‌فلو «thailandgard-all-teams،» بخش farsiui:
 * نودهای «پارام سرپرست (farsiui)»، «پارام مجری ۱ تا ۳ (farsiui)» و
 * «پارام منتقد (farsiui)».
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
import type { ProgressReporter, QueuedTask, TeamName, TeamResult } from '../types';
import { faDigits as faNum } from '../format';

/** نام تیم در رجیستری سراسری (lib/types.ts). */
export const TEAM: TeamName = 'farsiui';

/** مأموریت یک‌خطی تیم. */
export const MISSION =
  'ممیز فارسی‌نویسی و راست‌چین؛ قرارداد نوشتاری فارسی و قواعد راست‌چین را روی هر رشتهٔ روبه‌کاربر سایت نگه می‌دارد.';

/** تیم‌هایی که ورودی این تیم از خروجی آن‌ها می‌آید. */
export const INPUTS: TeamName[] = ['content'];

/** ورودی runTeam. */
export interface RunTeamInput {
  /** گزارش زنده‌ی پیشرفت به ارکستر؛ ارکستر همیشه آن را می‌دهد. */
  reportProgress?: ProgressReporter;
  /** شناسهٔ اجرای چرخه؛ کلید حافظهٔ learned:<runId> از آن ساخته می‌شود. */
  runId: string;
  /** خروجی موج‌های قبلی؛ کلیدها نام تیم‌اند. این تیم previousWavesOutput['content'] را می‌خواند. */
  previousWavesOutput: Record<string, unknown>;
  /**
   * دستور مستقیم منتقد از حلقهٔ بیرونی ارکستراتور (همین چرخه)؛ بالاترین
   * اولویت را دارد و در ابتدای دستور مجری‌ها تزریق می‌شود.
   */
  reviewDirective?: string;
}

/** یک یافتهٔ ممیزی از زبان منتقد. */
export interface AuditFinding {
  /** منبع قاعده (مثلاً کدام قرارداد یا مهارت). */
  rule: string;
  /** کدام رشته، کجا. */
  location: string;
  /** متن فعلی. */
  current: string;
  /** جایگزینی پیشنهادی. */
  replacement: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

/** داوری منتقد. */
export interface CriticVerdict {
  approved: boolean;
  /** امتیاز کیفی منتقد (۰ تا ۱۰۰)؛ تعیین‌کننده نهایی: تأیید فقط با ≥ ۸۰. */
  score?: number;
  reason: string;
  payload: {
    findings: AuditFinding[];
    notes: string;
  };
}

/** خروجی یک دور از مجری‌های حلقه نقد: مأموریت‌ها + خروجی هر سه مجری */
interface WorkerRoundOutput {
  missions: [string, string, string];
  outputs: [string, string, string];
}

const SUPERVISOR_SYSTEM = 'تو سرپرست تیم farsiui تایلندگرد هستی.';
const WORKER_SYSTEM = 'تو مجری تیم farsiui تایلندگرد هستی.';
const CRITIC_SYSTEM = 'تو منتقد سخت‌گیر تیم farsiui هستی.';

/** مأموریت‌های پیش‌فرض؛ اگر سرپرست JSON معتبر نداد به کار می‌روند. */
const DEFAULT_MISSIONS: [string, string, string] = [
  'ممیزی متن‌های رابط (دکمه، فرم، پیام خطا، حالت خالی) با قرارداد نوشتاری فارسی و قواعد مهارت persian-ui-copy؛ برای هر ایراد: کدام رشته، کجا، کدام قاعده، چه جایگزینی.',
  'اعمال و راستی‌آزمایی قاعدهٔ عدد و لیبل، ارقام فارسی و dir صریح روی هر ردیف راست‌چین؛ برای هر مورد: کجا، چه وضعیتی، چه اصلاحی.',
  'به‌روزرسانی سند پیام‌ها (MESSAGES-DOC.md) با پیام‌های تازه و نوشتن دستور اصلاح دقیق هر رشته: کدام رشته، کجا، چه جایگزینی.',
];

function supervisorPrompt(contentText: string, knowledgeSection = ''): string {
  const content =
    contentText.trim() ||
    '(در این چرخه متنی از تیم محتوا نرسیده؛ فقط بر اساس مأموریت کار کن)';
  return `متن‌های تحویل‌شدهٔ تیم محتوا:
${content}
${knowledgeSection ? `\n${knowledgeSection}` : ''}

مأموریت تیم farsiui: ممیز فارسی‌نویسی و راست‌چین است؛ قرارداد نوشتاری فارسی و قواعد راست‌چین را روی هر رشتهٔ روبه‌کاربر سایت نگه می‌دارد. تخصصش متن و جهت است نه انتخاب کامپوننت.

بر اساس متن‌ها تصمیم بگیر این چرخه چه کاری باید انجام شود و آن را به سه مأموریت مجزا بشکن:
۱. متن‌های رابط (دکمه، فرم، پیام خطا، حالت خالی)
۲. قاعدهٔ عدد و لیبل، ارقام فارسی و dir صریح روی ردیف‌های راست‌چین
۳. به‌روزرسانی سند پیام‌ها و دستور اصلاح دقیق هر رشته

خروجی فقط JSON معتبر با همین شکل باشد و هیچ متن دیگری نداشته باشد:
{"workers": ["مأموریت مجری ۱", "مأموریت مجری ۲", "مأموریت مجری ۳"]}

فقط واقعیت؛ بدون حدس.`;
}

function worker1Prompt(mission: string): string {
  return `مأموریت سرپرست:
${mission}

نقش تو: متن‌های رابط (دکمه، فرم، پیام خطا، حالت خالی) را با قرارداد نوشتاری فارسی و قواعد مهارت persian-ui-copy می‌خوانی و ایرادها را فهرست می‌کنی.

برای هر ایراد این چهار را بنویس: کدام رشته، کجا دیده شده، کدام قاعده شکسته شده، جایگزینی دقیق چیست.
فقط واقعیت؛ بدون حدس. چیزی را که ندیده‌ای از خودت نساز.`;
}

function worker2Prompt(mission: string): string {
  return `مأموریت سرپرست:
${mission}

نقش تو: قاعدهٔ عدد و لیبل، ارقام فارسی و dir صریح را روی هر ردیف راست‌چین اعمال و راستی‌آزمایی می‌کنی.

قاعده‌ها:
۱. در چیدمان راست‌چین، لیبل سمت راست و عدد سمت چپ می‌نشیند.
۲. ارقام فارسی‌اند (۰۱۲۳۴۵۶۷۸۹)؛ رقم لاتین در متن فارسی نمی‌آید.
۳. هر بلوک جهت‌دار dir صریح دارد.
۴. خط تیرهٔ بلند در هیچ متنی نمی‌آید.

برای هر مورد بنویس: کجا، چه وضعیتی دارد، چه اصلاحی لازم است.
فقط واقعیت؛ بدون حدس.`;
}

function worker3Prompt(mission: string): string {
  return `مأموریت سرپرست:
${mission}

نقش تو: سند پیام‌ها (MESSAGES-DOC.md) را با پیام‌های تازه به‌روز نگه می‌داری و برای هر اصلاح دستور دقیق می‌نویسی.

خروجی‌ات دو بخش دارد:
۱. متن به‌روزشدهٔ سند، یا بخش‌های تازه‌ای که به سند اضافه می‌شود
۲. فهرست دستورهای اصلاح؛ هر دستور: کدام رشته، کجا، جایگزینی چیست

فقط واقعیت؛ بدون حدس.`;
}

function criticPrompt(w1: string, w2: string, w3: string): string {
  return `خروجی مجری ۱:
${w1}

خروجی مجری ۲:
${w2}

خروجی مجری ۳:
${w3}

داوری کن و فقط JSON معتبر بده با همین کلیدها: approved (بولین)، score (عدد ۰ تا ۱۰۰)، reason (یک جمله)، payload.

${CRITIC_SCORE_PROMPT_LINE}

تمرکز داوری:
۱. آیا در متن هیچ‌یک از مجری‌ها خط تیرهٔ بلند نیست؟
۲. آیا رجیستر «شما» در همهٔ متن‌های پیشنهادی یکدست است؟
۳. آیا هر یافته منبع قاعده‌اش را دارد یا حدس است؟

شکل payload:
{
  "findings": [
    {"rule": "منبع قاعده", "location": "کدام رشته، کجا", "current": "متن فعلی", "replacement": "جایگزینی پیشنهادی", "severity": "low|medium|high|critical"}
  ],
  "notes": "یادداشت کوتاه برای چرخهٔ بعد"
}`;
}

/** متن‌سازی از ورودی ناشناخته. */
function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** پارس JSON با تحمل فنس ```json. */
function parseJson<T>(raw: string): T {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  return JSON.parse(text) as T;
}



/** سرپرست: شکستن کار چرخه به سه مأموریت. */
async function planMissions(contentText: string): Promise<[string, string, string]> {
  // تزریق best-effort دانش تیم در ابتدای بخش زمینه (تیم ۱۳)؛
  // بدون دانش، پرامپت دقیقاً مثل قبل می‌ماند.
  let knowledgeSection = '';
  try {
    knowledgeSection = await buildKnowledgePromptSection(TEAM, MISSION);
  } catch {
    knowledgeSection = '';
  }
  try {
    const raw = await callLLM(supervisorPrompt(contentText, knowledgeSection), {
      system: SUPERVISOR_SYSTEM,
      temperature: 0.2,
      maxTokens: 1500,
    });
    const parsed = parseJson<{ workers?: unknown }>(raw);
    const workers = Array.isArray(parsed.workers) ? parsed.workers : [];
    const missions = [0, 1, 2].map((i) => {
      const m = workers[i];
      return typeof m === 'string' && m.trim() ? m.trim() : DEFAULT_MISSIONS[i];
    });
    return missions as [string, string, string];
  } catch {
    return DEFAULT_MISSIONS;
  }
}

function normalizeFinding(raw: unknown): AuditFinding | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const f = raw as Record<string, unknown>;
  const severity =
    f.severity === 'critical' || f.severity === 'high' || f.severity === 'low'
      ? f.severity
      : 'medium';
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  if (!str(f.location) && !str(f.rule)) return null;
  return {
    rule: str(f.rule),
    location: str(f.location),
    current: str(f.current),
    replacement: str(f.replacement),
    severity,
  };
}

/** منتقد: داوری خروجی سه مجری. */
async function judge(w1: string, w2: string, w3: string): Promise<CriticVerdict> {
  const raw = await callLLM(criticPrompt(w1, w2, w3), {
    system: CRITIC_SYSTEM,
    temperature: 0.2,
    maxTokens: 3000,
  });
  const parsed = parseJson<{
    approved?: unknown;
    score?: unknown;
    reason?: unknown;
    payload?: { findings?: unknown; notes?: unknown };
  }>(raw);
  const findings = Array.isArray(parsed.payload?.findings)
    ? parsed.payload.findings
        .map(normalizeFinding)
        .filter((f): f is AuditFinding => f !== null)
    : [];
  const notes =
    typeof parsed.payload?.notes === 'string' ? parsed.payload.notes : '';
  const reason =
    typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim()
      : 'منتقد دلیلی ثبت نکرد.';
  return {
    approved: parsed.approved === true,
    score: parseCriticScore(parsed.score) ?? undefined,
    reason,
    payload: { findings, notes },
  };
}

function severityToPriority(
  severity: AuditFinding['severity'],
): QueuedTask['priority'] {
  return severity;
}

function buildTasks(verdict: CriticVerdict): QueuedTask[] {
  return verdict.payload.findings.map((f) => ({
    title: `اصلاح فارسی‌نویسی: ${f.location}`,
    description: `قاعده: ${f.rule}؛ متن فعلی: «${f.current}»؛ جایگزینی: «${f.replacement}»`,
    files_hint: f.location,
    priority: severityToPriority(f.severity),
  }));
}

function buildBlockers(verdict: CriticVerdict): string[] {
  const blockers: string[] = [];
  if (!verdict.approved) blockers.push(verdict.reason);
  for (const f of verdict.payload.findings) {
    if (f.severity === 'critical') {
      blockers.push(`یافتهٔ بحرانی در ${f.location}: ${f.rule}`);
    }
  }
  return blockers;
}

function buildSummary(verdict: CriticVerdict): string {
  const n = verdict.payload.findings.length;
  const important = verdict.payload.findings.filter(
    (f) => f.severity === 'high' || f.severity === 'critical',
  ).length;
  const judgeWord = verdict.approved ? 'تأیید شد' : 'تأیید نشد';
  return `ممیزی فارسی‌نویسی و راست‌چین انجام شد؛ ${faNum(n)} یافته در متن‌های روبه‌کاربر که ${faNum(important)} تای آن مهم یا بحرانی است. داوری منتقد: ${judgeWord}.`;
}

/**
 * تبدیل دلیل ردِ منتقد قدیمی به دستور اجرایی (CriticVerdictV2.instruction).
 * امری و بلندتر از ۵۰ نویسه تا از اعتبارسنجی حلقه رد شود.
 */
function criticInstructionFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی ایراد دارد';
  return [
    `خروجی را بر اساس این نقد اصلاح کن: «${r}»`,
    'هر سه خروجی را بازنویسی کن: خط تیرهٔ بلند را از همهٔ متن‌ها حذف کن؛',
    'رجیستر «شما» را در همهٔ متن‌های پیشنهادی یکدست نگه دار؛',
    'به هر یافته منبع قاعده‌اش را اضافه کن و حدس نزن؛ فقط واقعیت بنویس.',
  ].join(' ');
}

/**
 * تبدیل دلیل رد به معیار قبولی (CriticVerdictV2.acceptance).
 */
function criticAcceptanceFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی ایراد دارد';
  return `وقتی درست است که نقد «${r}» دیگر دربارهٔ خروجی صدق نکند: هیچ خط تیرهٔ بلندی در متن‌ها نیست، رجیستر «شما» یکدست است و هر یافته منبع قاعده دارد.`;
}

/**
 * اجرای تیم farsiui در یک چرخه.
 * متن‌هایی را می‌خواند که تیم محتوا در previousWavesOutput['content'] گذاشته است.
 * (مهاجرت به حلقه نقد ۳ دوره‌ای lib/critic-loop.ts)
 */
export async function runTeam(input: RunTeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;
  const { runId, previousWavesOutput } = input;
  const contentText = toText(previousWavesOutput['content']);

  // ---------- توابع حلقه نقد ----------

  // کش دور ۱: مأموریت‌های سرپرست در هر چرخه یک بار ساخته می‌شوند؛
  // دورهای ۲ و ۳ همان مأموریت‌ها را با دستور منتقد اصلاح می‌کنند.
  let cachedMissions: [string, string, string] | null = null;
  // داوری خام آخرین دور (برای تسک‌ها، بلوکرها و خلاصه)
  let lastVerdict: CriticVerdict | null = null;

  /** سه مجری، موازی (منطق فعلی، بدون تغییر). */
  const executeWorkers = async (
    missions: [string, string, string],
    prevInstruction?: string,
  ): Promise<[string, string, string]> => {
    const withInstruction = (prompt: string) =>
      prevInstruction
        ? ['دستور منتقد برای اصلاح این دور (حتماً رعایت کن):', prevInstruction, '', prompt].join('\n')
        : prompt;
    return (await Promise.all([
      callLLM(withInstruction(worker1Prompt(missions[0])), {
        system: WORKER_SYSTEM,
        temperature: 0.5,
        maxTokens: 3000,
      }),
      callLLM(withInstruction(worker2Prompt(missions[1])), {
        system: WORKER_SYSTEM,
        temperature: 0.5,
        maxTokens: 3000,
      }),
      callLLM(withInstruction(worker3Prompt(missions[2])), {
        system: WORKER_SYSTEM,
        temperature: 0.5,
        maxTokens: 3000,
      }),
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
      // ۱. سرپرست: شکستن کار به سه مأموریت
      await reportLive?.('سرپرست: طراحی مأموریت‌ها', 15);
      cachedMissions = await planMissions(contentText);
    } else {
      await reportLive?.(`دور ${round}: اصلاح با دستور منتقد`, 50);
    }
    const missions = cachedMissions;
    if (!missions) {
      throw new Error('مأموریت‌های سرپرست در کش پیدا نشد.');
    }

    // ۲. سه مجری، موازی
    await reportLive?.('مجری‌ها: سه خروجی موازی', 55);
    const outputs = await executeWorkers(
      missions,
      combineReviewDirectives(input.reviewDirective, prevInstruction),
    );
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
    await reportLive?.(`منتقد: داوری خروجی (دور ${round})`, 85);
    const verdict = await judge(output.outputs[0], output.outputs[1], output.outputs[2]);
    lastVerdict = verdict;
    const reason = verdict.reason;

    if (verdict.approved) {
      return {
        approved: true,
        score: verdict.score,
        reason: '',
        instruction: '',
        acceptance: '',
        finalOpinion: reason || undefined,
      };
    }
    return {
      approved: false,
      score: verdict.score,
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
        domain: 'رابط فارسی',
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

  const verdict = lastVerdict ?? {
    approved: false,
    reason: 'داوری ثبت نشد.',
    payload: { findings: [], notes: '' },
  };

  // ثبت در حافظهٔ تیم با کلید learned:<runId> (غنی‌شده با تاریخچه دورهای حلقه)
  const summary = `${buildSummary(verdict)} حلقه در دور ${loopResult.finalRound} تمام شد.`;
  await writeMemory(TEAM, `learned:${runId}`, {
    content: summary.slice(0, 2000),
    approved: verdict.approved,
    notes: verdict.payload.notes,
    run_id: runId,
    finalRound: loopResult.finalRound,
    rounds: loopResult.verdicts.map((v, i) => ({
      round: i + 1,
      approved: v.approved,
      reason: v.reason || v.finalOpinion || '',
    })),
  });

  return {
    team: TEAM,
    summary: `${summary} ${lastKnowledgeLog}`,
    blockers: buildBlockers(verdict),
    tasks: buildTasks(verdict),
    approved: loopResult.approved,
  };
}
