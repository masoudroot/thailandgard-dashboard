/**
 * lib/teams/branding.ts : تیم «صدای برند» تایلندگرد
 *
 * اقتباس از ورک‌فلو n8n: سه خروجی برند (لحن، واژه‌نامهٔ یوایکس‌رایتینگ، شعار)
 * در سه فراخوانی LLM: سرپرست ← مجری‌ها (یکجا) ← منتقد.
 */

import { callLLM, callLLMJson } from '../llm';
import { writeMemory } from '../memory';
import { buildKnowledgePromptSection, indexKnowledge } from '../rag';
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

/** سرپرست: از زمینه، سه مأموریت مجزا برای مجری‌ها می‌سازد. */
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

/**
 * هر سه مجری در یک فراخوانی: تحلیل + تولید.
 * (فشرده‌سازی آگاهانه برای سقف ۳ فراخوانی هر چرخه)
 */
async function runWorkers(plan: SupervisorPlan): Promise<string> {
  const prompt = [
    'مأموریت سرپرست:',
    plan.workers.map((w, i) => `${i + 1}. ${w}`).join('\n'),
    '',
    'نقش تو: مجری تیم branding تایلندگرد. هر سه خروجی زیر را بده؛ فقط واقعیت، بدون حدس:',
    'الف) فیلتر لحن برند: چند متن زندهٔ فرضی سایت را از فیلتر لحن رد کن و به مغایرت‌ها حکم اصلاح بده.',
    'ب) واژه‌نامهٔ یوایکس‌رایتینگ: نمونهٔ استاندارد برای دکمه، فرم، خطا، حالت خالی و اعلان.',
    'پ) شعار: ۳ گزینهٔ نهایی بر اساس اصول مصوب، هر کدام با دلیل انتخاب، برای تأیید مسعود.',
  ].join('\n');
  return callLLM(prompt, {
    system: 'تو مجری تیم branding تایلندگرد هستی. فارسی تمیز، بدون ادعای بی‌پشتوانه.',
    temperature: 0.7,
  });
}

/** منتقد سخت‌گیر: آیا متن با لحن برند می‌خواند و شعار از کلیشه، موعظه و ادعای بی‌پشتوانه پاک است؟ */
async function runCritic(workersOutput: string): Promise<CriticVerdict> {
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

export async function runTeam(input: TeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;
  await reportLive?.('سرپرست: طراحی مأموریت‌ها', 15);
  const plan = await runSupervisor(input);
  await reportLive?.('مجری‌ها: اجرای مأموریت‌ها', 50);
  const workersOutput = await runWorkers(plan);
  await reportLive?.('منتقد: داوری خروجی', 80);
  const verdict = await runCritic(workersOutput);

  const tasks: QueuedTask[] = [];
  const blockers: string[] = [];

  if (!verdict.approved) {
    blockers.push(`منتقد branding تأیید نکرد: ${verdict.reason}`);
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

  const lesson = verdict.approved
    ? `چرخهٔ موفق: ${verdict.reason}`
    : `رد منتقد: ${verdict.reason}`;
  await remember(input.runId, lesson);

  // استخراج دانش حرفه‌ای از حکم منتقد و ایندکس در RAG
  // تا چرخه‌های بعد از این درس استفاده کنند، نه اینکه دوباره همان خطا تکرار شود.
  try {
    const knowledgeTitle = verdict.approved
      ? `درس موفق برندینگ (${input.runId.slice(0, 8)})`
      : `رد منتقد برندینگ (${input.runId.slice(0, 8)})`;
    const knowledgeContent = [
      `حکم منتقد: ${verdict.approved ? 'تأیید شد' : 'رد شد'}.`,
      `دلیل: ${verdict.reason}`,
      verdict.approved
        ? 'این الگو موفق بود؛ در چرخه‌های بعد تکرار شود.'
        : 'این الگو مردود است؛ در چرخه‌های بعد از آن پرهیز شود.',
    ].join('\n');
    await indexKnowledge(
      `branding-lesson-${input.runId}`,
      TEAM,
      knowledgeTitle,
      knowledgeContent,
    );
  } catch {
    // fail-soft: اگر ایندکس دانش شکست خورد، چرخه نباید بایستد
  }

  const summary = verdict.approved
    ? `تیم برندینگ این چرخه شعار، واژه‌نامهٔ یوایکس‌رایتینگ و فیلتر لحن را بازبینی و تولید کرد و منتقد آن را تأیید کرد. ${verdict.reason} ۳ گزینهٔ شعار نهایی برای تأیید مسعود آماده است و دو کار بعدی (واژه‌نامه و اصلاح لحن متن‌ها) در صف گذاشته شد.`
    : `تیم برندینگ این چرخه خروجی تولید کرد ولی منتقد آن را تأیید نکرد و کار به چرخهٔ بعد موکول شد. دلیل: ${verdict.reason} حکم اصلاح لحن برای متن‌های زنده ثبت شده و بلوکر در گزارش درج شد.`;

  return {
    team: TEAM,
    summary,
    blockers,
    tasks: tasks.slice(0, 3),
    approved: verdict.approved,
  };
}
