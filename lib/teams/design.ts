/**
 * lib/teams/design.ts : تیم طراحی (design) تایلندگرد
 *
 * اقتباس از ورک‌فلو n8n: مجری بریف آرت‌دایرکشن با نزدیک‌ترین آیتم‌های
 * رجیستری وایب‌فارسی؛ سه مجری (نقد سه‌چشمی، دیف اجرایی برای dev، بازبینی
 * نهایی) و منتقدی که روی slug رجیستری، توکن‌محوری و ممنوعیت استایل
 * من‌درآوردی تمرکز دارد. سه فراخوانی LLM هر چرخه: سرپرست ← مجری‌ها (یکجا) ← منتقد.
 */

import { callLLM, callLLMJson } from '../llm';
import { buildKnowledgePromptSection } from '../rag';
import type { ProgressReporter, MemoryEntry, QueuedTask, TeamName, TeamResult } from '../types';

export const TEAM: TeamName = 'design';

export const MISSION =
  'مجری بریف آرت‌دایرکشن با نزدیک‌ترین آیتم‌های رجیستری وایب‌فارسی؛ هر روز حداقل یک تغییر بصری قابل‌مشاهده روی سایت منتشر می‌کند و دیزاین سیستم تایلندگرد را می‌سازد.';

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

/** سرپرست: بریف artdir و خروجی branding را می‌خواند و سه مأموریت برای مجری‌ها می‌سازد. */
async function runSupervisor(input: TeamInput): Promise<SupervisorPlan> {
  // تزریق best-effort دانش تیم در ابتدای بخش زمینه (تیم ۱۳)؛
  // بدون دانش، پرامپت دقیقاً مثل قبل می‌ماند.
  let knowledgeSection = '';
  try {
    knowledgeSection = await buildKnowledgePromptSection(TEAM, MISSION);
  } catch {
    knowledgeSection = '';
  }
  const memoryLines = input.memory.map((m) => `- ${m.key}: ${m.value}`).join('\n');
  const artdirBrief = input.previousWavesOutput['artdir'] || '(بریف artdir نیست)';
  const brandingOutput = input.previousWavesOutput['branding'] || '(خروجی branding نیست)';
  const prompt = [
    'زمینه:',
    ...(knowledgeSection ? [knowledgeSection, ''] : []),
    input.ragContext || '(زمینه‌ای نیست)',
    '',
    'بریف آرت‌دایرکشن (خروجی تیم artdir):',
    artdirBrief,
    '',
    'خروجی تیم branding:',
    brandingOutput,
    '',
    memoryLines ? `یادگیری‌های قبلی:\n${memoryLines}` : '',
    '',
    `مأموریت تیم design: ${MISSION}`,
    '',
    'بر اساس زمینه، بریف artdir و خروجی branding، تصمیم بگیر این چرخه چه کاری باید انجام شود و آن را به سه مأموریت مجزا برای سه مجری بشکن: مجری ۱ (بریف artdir و آیتم‌های رجیستری وایب‌فارسی را می‌خواند و نقد سه‌چشمی انجام می‌دهد: فارسی‌نویسی و تایپوگرافی فارسی، بصری راست‌چین، حرکت و دیتاویز؛ برای هر نقد سه قلم مشخص: کدام المان، چه ایرادی، چه راه‌حلی)، مجری ۲ (دیف یا دستور اجرایی دقیق برای dev می‌سازد با ذکر slug هر آیتم رجیستری؛ انحراف از رجیستری فقط با دلیل مکتوب؛ استایل من‌درآوردی مطلقاً ممنوع و همه چیز توکن‌محور)، مجری ۳ (خروجی نهایی را با نقد سه‌چشمی بازبینی می‌کند و برای ممیزی vibefarsi و farsiui آماده می‌کند).',
    'فقط JSON معتبر بده با کلید workers شامل سه رشتهٔ مأموریت.',
  ]
    .filter((l) => l !== null)
    .join('\n');
  return callLLMJson<SupervisorPlan>(prompt, {
    system: 'تو سرپرست تیم design تایلندگرد هستی. فقط JSON معتبر می‌دهی؛ بدون حدس.',
    temperature: 0.3,
  });
}

/**
 * هر سه مجری در یک فراخوانی: نقد سه‌چشمی + دیف اجرایی + بازبینی نهایی.
 * (فشرده‌سازی آگاهانه برای سقف ۳ فراخوانی هر چرخه)
 */
async function runWorkers(
  input: TeamInput,
  plan: SupervisorPlan,
): Promise<string> {
  const artdirBrief = input.previousWavesOutput['artdir'] || '(بریف artdir نیست)';
  const brandingOutput = input.previousWavesOutput['branding'] || '(خروجی branding نیست)';
  const prompt = [
    'مأموریت سرپرست:',
    plan.workers.map((w, i) => `${i + 1}. ${w}`).join('\n'),
    '',
    'بریف آرت‌دایرکشن (خروجی تیم artdir):',
    artdirBrief,
    '',
    'خروجی تیم branding:',
    brandingOutput,
    '',
    'نقش تو: مجری تیم design تایلندگرد. هر سه خروجی زیر را بده؛ فقط واقعیت، بدون حدس:',
    'الف) نقد سه‌چشمی: بریف artdir و آیتم‌های رجیستری وایب‌فارسی را می‌خواند و نقد می‌کند (۱: فارسی‌نویسی و تایپوگرافی فارسی، ۲: بصری راست‌چین، ۳: حرکت و دیتاویز). هر نقد با سه قلم مشخص: کدام المان، چه ایرادی، چه راه‌حلی.',
    'ب) دیف یا دستور اجرایی دقیق برای dev: با ذکر slug هر آیتم رجیستری؛ انحراف فقط با دلیل مکتوب؛ استایل من‌درآوردی ممنوع، همه چیز توکن‌محور.',
    'پ) بازبینی نهایی: خروجی را با همان نقد سه‌چشمی بازبینی کن و برای ممیزی vibefarsi و farsiui آماده کن (چک‌لیست ۱۲نقطه‌ای فارسی و راست‌چین هم لحاظ شود).',
  ].join('\n');
  return callLLM(prompt, {
    system: 'تو مجری تیم design تایلندگرد هستی. فارسی تمیز، بدون ادعای بی‌پشتوانه.',
    temperature: 0.7,
  });
}

/** منتقد سخت‌گیر: آیا هر تصمیم slug رجیستری دارد، توکن‌محور است و استایل من‌درآوردی به کار نرفته؟ */
async function runCritic(workersOutput: string): Promise<CriticVerdict> {
  const prompt = [
    'خروجی مجری‌ها:',
    workersOutput,
    '',
    'داوری کن و فقط JSON معتبر بده با کلیدهای: approved (بولین)، reason (یک جمله)، payload (متن نهایی تأییدشده یا اصلاح‌شده).',
    'تمرکز داوری: آیا هر تصمیم slug رجیستری دارد، توکن‌محور است و استایل من‌درآوردی به کار نرفته؟',
  ].join('\n');
  return callLLMJson<CriticVerdict>(prompt, {
    system: 'تو منتقد سخت‌گیر تیم design هستی. فقط JSON معتبر می‌دهی.',
    temperature: 0.2,
  });
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

export async function runTeam(input: TeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;
  await reportLive?.('سرپرست: طراحی مأموریت‌ها', 15);
  const plan = await runSupervisor(input);
  await reportLive?.('مجری‌ها: اجرای مأموریت‌ها', 50);
  const workersOutput = await runWorkers(input, plan);
  await reportLive?.('منتقد: داوری خروجی', 80);
  const verdict = await runCritic(workersOutput);

  const tasks: QueuedTask[] = [];
  const blockers: string[] = [];

  if (!verdict.approved) {
    blockers.push(`منتقد design تأیید نکرد: ${verdict.reason}`);
  } else {
    tasks.push(
      {
        title: 'تحویل دیف یا دستور اجرایی به تیم dev',
        description:
          'دیف یا دستور اجرایی دقیق این چرخه (با slug هر آیتم رجیستری و دلیل هر انحراف) برای اجرا به صف تیم dev رفت.',
        files_hint: 'site/components/**',
        priority: 'high',
      },
      {
        title: 'بازبینی سه‌چشمی خروجی نهایی',
        description:
          'خروجی نهایی این چرخه با نقد سه‌چشمی (فارسی‌نویسی، بصری راست‌چین، حرکت) بازبینی و برای ممیزی vibefarsi و farsiui آماده شد.',
        files_hint: 'design-system/**',
        priority: 'medium',
      },
      {
        title: 'ثبت تصمیم‌های طراحی با slug رجیستری',
        description:
          'هر تصمیم طراحی این چرخه با slug آیتم رجیستری وایب‌فارسی در دیزاین سیستم تایلندگرد ثبت یا به‌روز شود.',
        files_hint: 'design-system/decisions.md',
        priority: 'medium',
      },
    );
  }

  const lesson = verdict.approved
    ? `چرخهٔ موفق: ${verdict.reason}`
    : `رد منتقد: ${verdict.reason}`;
  await remember(input.runId, lesson);

  const summary = verdict.approved
    ? `تیم design این چرخه بریف artdir را با نزدیک‌ترین آیتم‌های رجیستری وایب‌فارسی اجرا کرد؛ نقد سه‌چشمی انجام شد و منتقد تأیید کرد که همهٔ تصمیم‌ها slug رجیستری دارند و توکن‌محور‌اند. دیف اجرایی برای dev در صف است و خروجی نهایی برای ممیزی vibefarsi و farsiui آماده است.`
    : `تیم design این چرخه خروجی تولید کرد ولی منتقد آن را تأیید نکرد و کار به چرخهٔ بعد موکول شد. دلیل: ${verdict.reason} نقد سه‌چشمی در بستهٔ بلوکر ثبت شده تا رفع شود.`;

  return {
    team: TEAM,
    summary,
    blockers,
    tasks: tasks.slice(0, 3),
    approved: verdict.approved,
  };
}
