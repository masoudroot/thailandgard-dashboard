/**
 * lib/teams/design-ir.ts - تیم «چشم ایرانی» (design-ir)
 *
 * وابسته به خروجی تیم design است؛ طرح نمی‌کشد و کد نمی‌زند، می‌بیند و حکم می‌دهد.
 * خروجی‌های design را با سه لنز (فرهنگ دیداری ایرانی، زبان فارسی، نگاه مسافر ایرانی)
 * نقد می‌کند و حکم‌های لازم‌الاجرا صادر می‌کند.
 *
 * ساختار اجرا: سرپرست → ۳ مجری موازی → منتقد سخت‌گیر → ثبت یادگیری در حافظه.
 * اقتباس تمیز پرامپت‌های ورک‌فلو n8n «thailandgard-all-teams» (بخش design-ir).
 */

import { callLLM, callLLMJson } from '../llm';
import { writeMemory } from '../memory';
import { buildKnowledgePromptSection } from '../rag';
import { extractCriticKnowledge, criticKnowledgeLog } from '../knowledge/critic-knowledge';
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
  reason: string;
  payload?: unknown;
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
 * اجرای کامل تیم design-ir در یک چرخه.
 * ورودی: خروجی تیم design از موج‌های قبلی. خروجی: TeamResult استاندارد.
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
  const [mission1, mission2, mission3] = ensureThreeMissions(plan.workers);

  // ۲. سه مجری به‌صورت موازی
  const workerPrompt = (mission: string) =>
    [
      `مأموریت سرپرست:\n${mission}`,
      '',
      `زمینه (خروجی design):\n${designOutput}`,
      '',
      LENSES,
      'فقط واقعیت؛ بدون حدس. نقدها را مشخص بنویس: کدام صفحه یا سکشن، چه ایرادی، چه راه‌حلی.',
    ].join('\n');

  await reportLive?.('مجری‌ها: سه خروجی موازی', 50);
  const [text1, text2, text3] = await Promise.all([
    callLLM(
      `${workerPrompt(mission1)}\n\nنقش تو: خروجی‌های design را با سه لنز می‌خوانی و نقد روزانهٔ ۵ نقطهٔ سایت انجام می‌دهی.`,
      { system: WORKER_SYSTEM, maxTokens: 2500 },
    ),
    callLLM(
      `${workerPrompt(mission2)}\n\nنقش تو: یافته‌های دتکتور unslop روی فایل‌های صفحات را مرور می‌کنی و یافته‌های ماشینی را با سه محک می‌سنجی؛ یافتهٔ بی‌پایه را رد می‌کنی.`,
      { system: WORKER_SYSTEM, maxTokens: 2500 },
    ),
    callLLM(
      `${workerPrompt(mission3)}\n\nنقش تو: حکم‌های لازم‌الاجرا را مشخص (کدام صفحه یا سکشن، چه ایرادی، چه راه‌حلی) در قالب ورودی‌های فایل VERDICTS.md می‌نویسی.`,
      { system: WORKER_SYSTEM, maxTokens: 2500 },
    ),
  ]);

  // ۳. منتقد سخت‌گیر
  await reportLive?.('منتقد: داوری خروجی', 80);
  const verdict = await callLLMJson<CriticVerdict>(
    [
      `خروجی مجری ۱:\n${text1}`,
      '',
      `خروجی مجری ۲:\n${text2}`,
      '',
      `خروجی مجری ۳:\n${text3}`,
      '',
      'داوری کن و فقط JSON معتبر بده با کلیدهای: approved (بولین)، reason (یک جمله)، payload.',
      'تمرکز داوری: آیا نقد راه‌حل دارد، سلیقهٔ شخصی بدون استدلال فرهنگی نیست و طرح به مسافر حسی می‌دهد نه بی‌روح؟',
    ].join('\n'),
    { system: CRITIC_SYSTEM, temperature: 0.2 },
  );

  const approved = Boolean(verdict.approved);

  // ۴. ثبت یادگیری این اجرا در حافظه
  await writeMemory(
    TEAM,
    `learned:${input.runId}`,
    [
      `تیم design-ir در چرخه ${input.runId}:`,
      `سرپرست سه مأموریت داد؛ مجری‌ها نقد ۵ نقطه، سنجش یافته‌های unslop و حکم‌های VERDICTS.md را تولید کردند.`,
      `حکم منتقد: ${approved ? 'تأیید' : 'رد'}، ${verdict.reason}`,
      designOutput.includes('ثبت نشده')
        ? 'یادداشت: خروجی design در ورودی این چرخه نبود.'
        : 'یادداشت: خروجی design در ورودی این چرخه موجود بود.',
    ].join(' '),
  );

  // ۵. بسته‌بندی خروجی استاندارد
  const tasks = payloadToTasks(verdict.payload);
  if (!approved) {
    tasks.unshift({
      title: 'رفع ایراد حکم منتقد design-ir',
      description: `منتقد خروجی را رد کرد: ${verdict.reason}`,
      files_hint: 'thailandgard site',
      priority: 'high',
    });
  }

  const summary = approved
    ? `چشم ایرانی تأیید شد: ${verdict.reason} مجری‌ها ۵ نقطهٔ سایت را با سه لنز نقد کردند، یافته‌های unslop را سنجیدند و حکم‌های لازم‌الاجرا را در قالب VERDICTS.md نوشتند.`
    : `چشم ایرانی رد شد: ${verdict.reason} مجری‌ها خروجی تولید کردند ولی منتقد آن را ناکافی دانست؛ کار پیگیری در صف قرار گرفت.`;

  // استخراج دانش از حکم منتقد
  const knowledgeResult = await extractCriticKnowledge(
    TEAM,
    { approved, reason: verdict.reason, domain: 'دیزاین ایرانی' },
    input.runId,
  );
  const knowledgeLog = criticKnowledgeLog(knowledgeResult);

  return {
    team: TEAM,
    summary: `${summary} ${knowledgeLog}`,
    blockers: approved ? [] : [verdict.reason],
    tasks,
    approved,
  };
}
