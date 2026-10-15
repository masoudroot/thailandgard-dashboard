/**
 * تیم «آرت‌دایرکشن» تایلندگرد (lib/teams/artdir.ts)
 *
 * اقتباس از ورک‌فلو n8n (سرپرست ← ۳ مجری ← منتقد):
 * ۱. سرپرست از زمینه سه مأموریت جدا می‌سازد.
 * ۲. مجری‌ها (در یک فراخوانی ترکیبی): نقد بصری مشخص سه‌قلمی،
 * تصمیم‌های آرت‌دایرکشن برای ثبت در DECISIONS-ARTDIR.md،
 * و بریف اجرایی کامل برای تیم طراحی.
 * ۳. منتقد سخت‌گیر داوری می‌کند: هر تصمیم بزرگ «چرا»ی مستند دارد؟
 */

import { callLLM, callLLMJson } from '../llm';
import { writeMemory } from '../memory';
import { buildKnowledgePromptSection } from '../rag';
import { extractCriticKnowledge, criticKnowledgeLog } from '../knowledge/critic-knowledge';
import type { ProgressReporter, MemoryEntry, QueuedTask, TeamName, TeamResult } from '../types';

export const TEAM: TeamName = 'artdir';

export const MISSION =
  '«سر» طراحی تایلندگرد است: کانسپت بصری، لی‌اوت، وایرفریم و تصمیم‌های آرت‌دایرکشن را می‌دهد، حکم نهایی زیبایی‌شناسی با اوست و نقد بصری روزانهٔ سایت را انجام می‌دهد؛ خودش اجرا نمی‌کند.';

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
  const wavesLines = Object.entries(input.previousWavesOutput)
    .map(([team, out]) => `- ${team}: ${out}`)
    .join('\n');
  const prompt = [
    'زمینه:',
    ...(knowledgeSection ? [knowledgeSection, ''] : []),
    input.ragContext || '(زمینه‌ای نیست)',
    '',
    memoryLines ? `یادگیری‌های قبلی:\n${memoryLines}` : '',
    wavesLines ? `\nخروجی موج‌های قبلی:\n${wavesLines}` : '',
    '',
    'مأموریت تیم artdir: «سر» طراحی است؛ طرح می‌دهد نه اجرا: کانسپت بصری، لی‌اوت، وایرفریم و تصمیم‌های آرت‌دایرکشن. حکم نهایی زیبایی‌شناسی با این تیم است و نقد روزانهٔ بصری سایت را انجام می‌دهد.',
    '',
    'بر اساس زمینه و دانش بازیابی‌شده، تصمیم بگیر این چرخه چه کاری باید انجام شود و آن را به سه مأموریت مجزا برای سه مجری بشکن: مجری ۱ (نقد بصری مشخص با سه قلم: کدام المان، چه ایرادی، چه راه‌حلی)، مجری ۲ (تصمیم‌های آرت‌دایرکشن با دلیل مستند برای ثبت در DECISIONS-ARTDIR.md)، مجری ۳ (بریف کامل اجرایی: هدف، مخاطب، حس موردنظر، ارجاع بصری).',
    'فقط JSON معتبر بده با کلید workers شامل سه رشتهٔ مأموریت.',
  ]
    .filter((l) => l!== '')
    .join('\n');
  return callLLMJson<SupervisorPlan>(prompt, {
    system: 'تو سرپرست تیم artdir تایلندگرد هستی. فقط JSON معتبر می‌دهی؛ بدون حدس.',
    temperature: 0.3,
  });
}

/**
 * هر سه مجری در یک فراخوانی: تحلیل + تولید.
 * (هر سه مجری در یک فراخوانی: تحلیل و تولید با هم، برای سقف ۳ فراخوانی هر چرخه)
 */
async function runWorkers(plan: SupervisorPlan): Promise<string> {
  const prompt = [
    'مأموریت سرپرست:',
    plan.workers.map((w, i) => `${i + 1}. ${w}`).join('\n'),
    '',
    'نقش تو: مجری تیم artdir تایلندگرد. هر سه خروجی زیر را بده؛ فقط واقعیت، بدون حدس:',
    'الف) نقد بصری: خروجی‌های بصری سایت را با سه قلم نقد کن: کدام المان، چه ایرادی، چه راه‌حلی.',
    'ب) تصمیم‌های آرت‌دایرکشن: هر تصمیم با دلیل مستند (چه حسی، برای چه مخاطبی، با چه ارجاع بصری) آمادهٔ ثبت در DECISIONS-ARTDIR.md.',
    'پ) بریف اجرایی: بریف کامل برای تیم طراحی شامل هدف، مخاطب، حس موردنظر و ارجاع بصری؛ هیچ طرحی بدون بریف به اجرا نمی‌رود.',
  ].join('\n');
  return callLLM(prompt, {
    system: 'تو مجری تیم artdir تایلندگرد هستی. فارسی تمیز، بدون ادعای بی‌پشتوانه.',
    temperature: 0.7,
  });
}

/** منتقد سخت‌گیر: هر تصمیم بزرگ «چرا»ی مستند دارد و طرح بدون بریف به اجرا نرفته؟ */
async function runCritic(workersOutput: string): Promise<CriticVerdict> {
  const prompt = [
    'خروجی مجری‌ها:',
    workersOutput,
    '',
    'داوری کن و فقط JSON معتبر بده با کلیدهای: approved (بولین)، reason (یک جمله)، payload (متن نهایی تأییدشده یا اصلاح‌شده).',
    'تمرکز داوری: آیا هر تصمیم بزرگ «چرا»ی مستند دارد (چه حسی، برای چه مخاطبی، با چه ارجاعی) و طرح بدون بریف به اجرا نرفته؟',
  ].join('\n');
  return callLLMJson<CriticVerdict>(prompt, {
    system: 'تو منتقد سخت‌گیر تیم artdir هستی. فقط JSON معتبر می‌دهی.',
    temperature: 0.2,
  });
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

  if (verdict.approved) {
    tasks.push(
      {
        title: 'ثبت تصمیم‌های آرت‌دایرکشن در DECISIONS-ARTDIR.md',
        description:
          'تصمیم‌های تأییدشدهٔ این چرخه با «چرا»ی مستند (حس، مخاطب، ارجاع بصری) در فایل تصمیم‌های آرت‌دایرکشن ثبت شود.',
        files_hint: 'DECISIONS-ARTDIR.md',
        priority: 'high',
      },
      {
        title: 'تحویل بریف اجرایی به تیم طراحی',
        description:
          'بریف کامل این چرخه (هدف، مخاطب، حس موردنظر، ارجاع بصری) به تیم طراحی تحویل داده شود تا طرح بدون بریف اجرا نشود.',
        files_hint: 'design/briefs/**',
        priority: 'high',
      },
      {
        title: 'پیگیری اصلاح ایرادهای نقد بصری',
        description:
          'ایرادهای مشخص‌شده در نقد بصری این چرخه (کدام المان، چه ایرادی، چه راه‌حلی) در صف اصلاح قرار گیرد.',
        files_hint: 'site/**',
        priority: 'medium',
      },
    );
  } else {
    blockers.push(`منتقد artdir تأیید نکرد: ${verdict.reason}`);
  }

  const lesson = verdict.approved
    ? `چرخهٔ موفق: ${verdict.reason}`
    : `رد منتقد: ${verdict.reason}`;
  await writeMemory(TEAM, `learned:${input.runId}`, lesson);

  // استخراج دانش از حکم منتقد (چرخه نقد←دانش)
  const knowledgeResult = await extractCriticKnowledge(
    TEAM,
    { approved: verdict.approved, reason: verdict.reason, domain: 'آرت‌دایرکشن و تصمیم‌های بصری' },
    input.runId,
  );
  const knowledgeLog = criticKnowledgeLog(knowledgeResult);

  const summary = verdict.approved
    ? `تیم آرت‌دایرکشن این چرخه سه خروجی داد: نقد بصری مشخص با راه‌حل، تصمیم‌های آرت‌دایرکشن با دلیل مستند و بریف اجرایی کامل برای تیم طراحی. ${verdict.reason} هر سه کار بعدی (ثبت تصمیم‌ها، تحویل بریف و پیگیری ایرادها) در صف گذاشته شد. ${knowledgeLog}`
    : `تیم آرت‌دایرکشن این چرخه خروجی تولید کرد ولی منتقد آن را تأیید نکرد و کار به چرخهٔ بعد موکول شد. دلیل: ${verdict.reason} «چرا»ی تصمیم‌ها یا کامل شدن بریف باید در چرخهٔ بعد جبران شود و بلوکر در گزارش درج شد. ${knowledgeLog}`;

  return {
    team: TEAM,
    summary,
    blockers,
    tasks: tasks.slice(0, 3),
    approved: true,
  };
}
