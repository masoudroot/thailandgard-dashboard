/**
 * lib/teams/content.ts: تیم content داشبورد ایجنتیک تایلندگرد
 *
 * اقتباس از ورک‌فلو n8n ‏thailandgard-all-teams‏ (v1tgtGJnLhAic4X6):
 * نودهای «پارام سرپرست (content)»‏، «پارام مجری ۱ (content)»‏، «پارام مجری ۲ (content)»‏،
 * «پارام مجری ۳ (content)» و «پارام منتقد (content)».
 *
 * خط لوله در سه فراخوانی LLM:
 *   ۱. سرپرست: زمینه را می‌خواند و سه مأموریت مجزا برای سه مجری می‌سازد.
 *   ۲. مجری‌ها: واقعیت‌های تازه (KNOWLEDGE.md)‏، رکوردهای tours و guides با فراداده کامل،
 *      و متن نهایی با رجیستر «شما» و فارسی تمیز.
 *   ۳. منتقد: داوری سخت‌گیرانه؛ هر ادعای عددی باید سند و لینک منبع داشته باشد،
 *      متن کپی نباشد و برای انسان نوشته شده باشد نه موتور جست‌وجو.
 *
 * قانون همیشگی تیم: هیچ عددی بدون سند نوشته نمی‌شود؛ فقط واقعیت، بدون حدس.
 */

import { callLLMJson } from '../llm';
import { writeMemory } from '../memory';
import type { ProgressReporter, QueuedTask, TeamName, TeamResult } from '../types';

export const TEAM: TeamName = 'content';

export const MISSION =
  'عمیق‌ترین محتوای فارسی سفر به تایلند را می‌نویسد (راهنما، ویزا، هزینه‌ها)؛ هیچ عددی بدون سند نوشته نمی‌شود.';

export interface TeamInput {
  /** گزارش زنده‌ی پیشرفت به ارکستر؛ ارکستر همیشه آن را می‌دهد. */
  reportProgress?: ProgressReporter;
  /** شناسه اجرای فعلی */
  runId: string;
  /** شناسه چرخه ارکستر */
  cycleId?: string;
  /** زمینه بازیابی‌شده از دانش (چانک‌های RAG) */
  context?: string;
  /** ورودی خام ارکستر */
  input?: string;
}

/** خروجی سرپرست: سه مأموریت مجزا */
interface SupervisorPlan {
  workers: string[];
}

/** خروجی تجمیعی سه مجری */
interface WorkersOutput {
  /** مجری ۱: واقعیت‌های تازه تایلند برای ثبت در KNOWLEDGE.md */
  facts: string;
  /** مجری ۲: مشخصات رکوردهای جدول‌های tours و guides */
  records: Array<{
    table: 'tours' | 'guides';
    title: string;
    source: string;
    keyword: string;
    angle: string;
  }>;
  /** مجری ۳: متن نهایی با رجیستر «شما» */
  finalText: string;
}

/** رأی منتقد */
interface CriticVerdict {
  approved: boolean;
  reason: string;
  payload: string;
}

const SYSTEM_SUPERVISOR = 'تو سرپرست تیم content تایلندگرد هستی.';
const SYSTEM_WORKER = 'تو مجری تیم content تایلندگرد هستی.';
const SYSTEM_CRITIC = 'تو منتقد سخت‌گیر تیم content هستی.';

const PERSIAN_DIGITS = ['۱', '۲', '۳'];

/**
 * اجرای یک نوبت تیم content.
 * سه فراخوانی LLM: سرپرست، مجری‌ها، منتقد.
 */
export async function runTeam(input: TeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;
  const context = input.context ?? input.input ?? '';
  const blockers: string[] = [];

  // فراخوانی ۱: سرپرست؛ شکستن کار چرخه به سه مأموریت مجزا
  await reportLive?.('سرپرست: طراحی مأموریت‌ها', 15);
  const plan = await callLLMJson<SupervisorPlan>(
    [
      'زمینه',
      context || '(زمینه‌ای داده نشد)',
      '',
      `مأموریت تیم content: ${MISSION}`,
      '',
      'بر اساس زمینه و دانش، تصمیم بگیر این چرخه چه کاری باید انجام شود و آن را به سه مأموریت مجزا برای سه مجری بشکن.',
      'فقط JSON معتبر بده با کلید workers شامل سه رشته مأموریت.',
    ].join('\n'),
    { system: SYSTEM_SUPERVISOR },
  );
  const missions: string[] = (Array.isArray(plan.workers) ? plan.workers : []).slice(0, 3);

  // فراخوانی ۲: سه مجری در یک نشست؛ نقش‌های هر سه از پرامپت n8n
  const missionLines = PERSIAN_DIGITS.map(
    (digit, i) => `${digit}. ${missions[i] ?? '(مأموریت مشخص نشد)'}`,
  ).join('\n');
  await reportLive?.('مجری‌ها: استخراج واقعیت‌ها و رکوردها', 50);
  const workers = await callLLMJson<WorkersOutput>(
    [
      'مأموریت‌های سرپرست',
      missionLines,
      '',
      'مجری ۱: تازه‌های تایلند را از زمینه می‌خواند و واقعیت‌های قابل ثبت در KNOWLEDGE.md را استخراج می‌کند؛ فقط واقعیت، بدون حدس.',
      'مجری ۲: برای جدول‌های tours و guides رکورد می‌سازد؛ هر رکورد فراداده کامل دارد: عنوان، منبع، کلمه اصلی، زاویه؛ فقط واقعیت، بدون حدس.',
      'مجری ۳: متن نهایی را با رجیستر «شما»، فارسی تمیز و قرارداد نوشتاری طبیعی نهایی می‌کند؛ فقط واقعیت، بدون حدس.',
      '',
      'فقط JSON معتبر بده با کلیدهای facts (رشته)، records (آرایه‌ای از {table، title، source، keyword، angle}) و finalText (رشته).',
    ].join('\n'),
    { system: SYSTEM_WORKER, maxTokens: 3000 },
  );

  // فراخوانی ۳: منتقد؛ داوری با معیارهای n8n
  await reportLive?.('منتقد: داوری خروجی', 80);
  const verdict = await callLLMJson<CriticVerdict>(
    [
      'خروجی مجری ۱',
      workers.facts ?? '',
      '',
      'خروجی مجری ۲',
      JSON.stringify(workers.records ?? []),
      '',
      'خروجی مجری ۳',
      workers.finalText ?? '',
      '',
      'داوری کن و فقط JSON معتبر بده با کلیدهای approved (بولین)، reason (یک جمله) و payload (خلاصه یک‌خطی نتیجه).',
      'تمرکز داوری: آیا هر ادعای عددی سند و لینک منبع دارد، کپی نیست و متن برای انسان نوشته شده نه موتور جست‌وجو؟',
    ].join('\n'),
    { system: SYSTEM_CRITIC },
  );

  if (!verdict.approved) {
    blockers.push(`منتقد خروجی را رد کرد: ${verdict.reason}`);
  }

  // ثبت آموخته‌ها در حافظه با کلید learned:<runId>
  const learned = {
    missions,
    approved: verdict.approved,
    reason: verdict.reason,
    payload: verdict.payload,
    factsLength: (workers.facts ?? '').length,
    recordsCount: (workers.records ?? []).length,
    records: workers.records ?? [],
  };
  await writeMemory({
    team: TEAM,
    key: `learned:${input.runId}`,
    value: JSON.stringify(learned),
  });

  // حداکثر سه کار در صف
  const tasks: QueuedTask[] = [];
  const records = workers.records ?? [];
  if (records.length > 0) {
    const titles = records
      .slice(0, 3)
      .map((r) => r.title)
      .join('، ');
    tasks.push({
      title: 'ثبت رکوردهای tours و guides در دیتابیس',
      description: `${records.length} رکورد آماده ثبت است: ${titles}${records.length > 3 ? ' و موارد دیگر' : ''}. هر رکورد فراداده کامل (عنوان، منبع، کلمه اصلی، زاویه) دارد و بدون سند عددی ثبت نمی‌شود.`,
      files_hint: 'site/lib، جدول‌های tours و guides',
      priority: 'high',
    });
  }
  if (verdict.payload) {
    tasks.push({
      title: 'بازبینی و انتشار خروجی content',
      description: verdict.payload,
      files_hint: 'KNOWLEDGE.md',
      priority: verdict.approved ? 'medium' : 'high',
    });
  }

  return {
    team: TEAM,
    summary: verdict.reason,
    blockers,
    tasks: tasks.slice(0, 3),
    approved: true,
  };
}
