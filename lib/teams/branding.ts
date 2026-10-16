/**
 * lib/teams/branding.ts : تیم «صدای برند» تایلندگرد
 *
 * اقتباس از ورک‌فلو n8n: سه خروجی برند (لحن، واژه‌نامهٔ یوایکس‌رایتینگ، شعار)
 * در سه فراخوانی LLM: سرپرست ← مجری‌ها (یکجا) ← منتقد.
 */

import { callLLM, callLLMJson } from '../llm';
import { writeMemory } from '../memory';
import { buildKnowledgePromptSection } from '../rag';
import { extractCriticKnowledge, criticKnowledgeLog } from '../knowledge/critic-knowledge';
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
async function runWorkers(missions: string[]): Promise<string> {
  const prompt = [
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
  const tasks: QueuedTask[] = [];
  const blockers: string[] = [];

  const missions = safeMissions(plan);
  if (missions.length === 0) {
    const msg = 'سرپرست مأموریت معتبری نداد (خروجی JSON ناقص)؛ کار به چرخهٔ بعد موکول شد.';
    blockers.push(msg);
    return { team: TEAM, summary: msg, blockers, tasks, approved: false };
  }

  await reportLive?.('مجری‌ها: اجرای مأموریت‌ها', 50);
  let workersOutput: string;
  try {
    workersOutput = await runWorkers(missions);
  } catch (err) {
    const msg = `مجری خروجی معتبر نداد: ${err instanceof Error ? err.message : String(err)}؛ کار به چرخهٔ بعد موکول شد.`;
    blockers.push(msg);
    return { team: TEAM, summary: msg, blockers, tasks, approved: false };
  }

  await reportLive?.('منتقد: داوری خروجی', 80);
  const rawVerdict = await runCritic(workersOutput);
  // حکم ناقص LLM نباید «undefined» چاپ کند یا مسیر اشتباه برود
  const verdict = {
    approved: rawVerdict?.approved === true,
    reason:
      typeof rawVerdict?.reason === 'string' && rawVerdict.reason.trim()
        ? rawVerdict.reason
        : '(دلیل ثبت نشد)',
    payload: typeof rawVerdict?.payload === 'string' ? rawVerdict.payload : '',
  };

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
  const knowledgeResult = await extractCriticKnowledge(
    TEAM,
    { approved: verdict.approved, reason: verdict.reason, domain: 'لحن برند و شعار' },
    input.runId,
  );
  const knowledgeLog = criticKnowledgeLog(knowledgeResult);
  const summary = verdict.approved
    ? `تیم برندینگ این چرخه شعار، واژه‌نامهٔ یوایکس‌رایتینگ و فیلتر لحن را بازبینی و تولید کرد و منتقد آن را تأیید کرد. ${verdict.reason} ۳ گزینهٔ شعار نهایی برای تأیید مسعود آماده است و دو کار بعدی (واژه‌نامه و اصلاح لحن متن‌ها) در صف گذاشته شد. ${knowledgeLog}`
    : `تیم برندینگ این چرخه خروجی تولید کرد ولی منتقد آن را تأیید نکرد و کار به چرخهٔ بعد موکول شد. دلیل: ${verdict.reason} حکم اصلاح لحن برای متن‌های زنده ثبت شده و بلوکر در گزارش درج شد. ${knowledgeLog}`;

  return {
    team: TEAM,
    summary,
    blockers,
    tasks: tasks.slice(0, 3),
    approved: verdict.approved,
  };
}
