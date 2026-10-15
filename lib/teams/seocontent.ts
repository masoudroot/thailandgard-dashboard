/**
 * lib/teams/seocontent.ts : تیم سئوی محتوا (seocontent)
 *
 * پل بین تولید محتوا و سئوست؛ فقط روی محتواها کار می‌کند، نه سئوی تکنیکال.
 * به خروجی تیم content وابسته است و آن را از previousWavesOutput می‌خواند.
 *
 * خط لوله (اقتباس تمیز از ورک‌فلو n8n ‏thailandgard-all-teams):
 *   سرپرست (analyze) ← سه مجری موازی (analyze / code / write) ← منتقد (analyze)
 * تایید ← writeMemory با کلید learned:<runId> / رد ← بسته‌بندی بلوکر
 */

import { callLLM, callLLMJson } from '../llm';
import { writeMemory } from '../memory';
import type { ProgressReporter, QueuedTask, TeamName, TeamResult } from '../types';

export const TEAM: TeamName = 'seocontent';

export const MISSION =
  'پل بین تولید محتوا و سئوست؛ هر محتوایی که منتشر می‌شود از زیر دست این تیم رد می‌شود تا شانس رتبه‌اش حداکثر شود.';

const SYSTEM_SUPERVISOR = 'تو سرپرست تیم seocontent تایلندگرد هستی.';
const SYSTEM_WORKER = 'تو مجری تیم seocontent تایلندگرد هستی.';
const SYSTEM_CRITIC = 'تو منتقد سخت‌گیر تیم seocontent هستی.';

/** ورودی اجرای تیم: خروجی موج‌های قبلی (کلید team به TeamResult). */
export interface RunTeamInput {
  /** گزارش زنده‌ی پیشرفت به ارکستر؛ ارکستر همیشه آن را می‌دهد. */
  reportProgress?: ProgressReporter;
  /** شناسهٔ اجرای چرخه؛ در کلید حافظه به شکل learned:<runId> می‌نشیند. */
  runId: string;
  /** شمارهٔ موج اجرایی این تیم. */
  wave: number;
  /** خروجی تیم‌های موج‌های قبلی؛ seocontent به تیم content وابسته است. */
  previousWavesOutput: Record<string, TeamResult | undefined>;
}

interface SupervisorPlan {
  workers: [string, string, string] | string[];
}

interface CriticVerdict {
  approved: boolean;
  reason: string;
  payload?: unknown;
}

const WORKER_ROLES = [
  {
    // مجری ۱ : شکار فرصت رتبه (analyze)
    temperature: 0.7,
    maxTokens: 2500,
    missionLine:
      'نقش تو: محتواهای موجود را می‌خوانی و فرصت‌های رتبه (کنیبالیزیشن، محتوای کهنه) را پیدا می‌کنی. فقط واقعیت؛ بدون حدس.',
  },
  {
    // مجری ۲ : نگاشت کلمه‌کلیدی و لینک‌سازی داخلی (code)
    temperature: 0.3,
    maxTokens: 3000,
    missionLine:
      'نقش تو: نگاشت کلمه‌کلیدی به صفحه را نگه می‌داری و لینک‌سازی داخلی بین محتواها را اجرا می‌کنی. فقط واقعیت؛ بدون حدس.',
  },
  {
    // مجری ۳ : بهینه‌سازی عنوان و متا و بریف سئو (write)
    temperature: 0.7,
    maxTokens: 3000,
    missionLine:
      'نقش تو: عنوان، متا، تیترها و FAQ هر محتوا را بهینه می‌کنی و بریف سئو برای درفت‌های تیم محتوا می‌نویسی. فقط واقعیت؛ بدون حدس.',
  },
] as const;

function summarizeContentOutput(result: TeamResult | undefined): string {
  if (!result) {
    return 'خروجی تیم content در این چرخه یافت نشد؛ بر اساس مأموریت تیم و دانش عمومی پیش برو.';
  }
  const parts = [`خلاصه: ${result.summary}`];
  if (result.blockers.length > 0) parts.push(`بلوکرهای تیم content: ${result.blockers.join('؛ ')}`);
  if (result.tasks.length > 0) {
    parts.push(
      `کارهای باز تیم content: ${result.tasks.map((t) => t.title).join('؛ ')}`,
    );
  }
  return parts.join('\n');
}

async function runSupervisor(contentSummary: string): Promise<string[]> {
  const prompt = [
    `زمینه (خروجی تیم content):\n${contentSummary}`,
    '',
    `مأموریت تیم seocontent: ${MISSION} فقط روی محتواها کار می‌کند نه سئوی تکنیکال.`,
    '',
    'بر اساس زمینه، تصمیم بگیر این چرخه چه کاری باید انجام شود و آن را به سه مأموریت مجزا برای سه مجری بشکن:',
    'مجری ۱: شکار فرصت رتبه در محتواهای موجود (کنیبالیزیشن، محتوای کهنه).',
    'مجری ۲: نگاشت کلمه‌کلیدی به صفحه و لینک‌سازی داخلی بین محتواها.',
    'مجری ۳: بهینه‌سازی عنوان، متا، تیترها و FAQ و نوشتن بریف سئو برای درفت‌های تیم محتوا.',
    '',
    'خروجی: فقط JSON معتبر با کلید workers شامل سه مأموریت رشته‌ای.',
  ].join('\n');

  const plan = await callLLMJson<SupervisorPlan>(prompt, {
    system: SYSTEM_SUPERVISOR,
    temperature: 0.5,
    maxTokens: 2000,
  });

  const workers = Array.isArray(plan?.workers) ? plan.workers : [];
  const missions = workers.filter((w): w is string => typeof w === 'string' && w.trim().length > 0);
  if (missions.length < 3) {
    throw new Error('سرپرست کمتر از سه مأموریت معتبر برای مجری‌ها برگرداند.');
  }
  return missions.slice(0, 3);
}

async function runWorker(index: number, mission: string, contentSummary: string): Promise<string> {
  const role = WORKER_ROLES[index];
  const prompt = [
    `مأموریت سرپرست:\n${mission}`,
    '',
    `زمینه (خروجی تیم content):\n${contentSummary}`,
    '',
    role.missionLine,
  ].join('\n');

  return callLLM(prompt, {
    system: SYSTEM_WORKER,
    temperature: role.temperature,
    maxTokens: role.maxTokens,
  });
}

async function runCritic(outputs: [string, string, string]): Promise<CriticVerdict> {
  const prompt = [
    `خروجی مجری ۱:\n${outputs[0]}`,
    '',
    `خروجی مجری ۲:\n${outputs[1]}`,
    '',
    `خروجی مجری ۳:\n${outputs[2]}`,
    '',
    'داوری کن و فقط JSON معتبر بده با کلیدهای: approved (بولین)، reason (یک جمله)، payload.',
    'تمرکز داوری: آیا بهینه‌سازی برای انسان هم بهتر شده (نه فقط موتور) و صفحه از کلمهٔ کلیدی پر نشده؟',
    'در payload این‌ها را بگذار: summary (خلاصهٔ یک‌پاراگرافی خروجی تیم)، tasks (آرایه‌ای از کارهای قابل اجرا با title، description، files_hint و priority یکی از low/medium/high/critical)، و learned (یک تا سه درس ماندگار این چرخه).',
  ].join('\n');

  const verdict = await callLLMJson<CriticVerdict>(prompt, {
    system: SYSTEM_CRITIC,
    temperature: 0.3,
    maxTokens: 3000,
  });

  if (typeof verdict?.approved !== 'boolean' || typeof verdict?.reason !== 'string') {
    throw new Error('منتقد حکم معتبر (approved/reason) برنگرداند.');
  }
  return verdict;
}

function coerceTasks(raw: unknown): QueuedTask[] {
  if (!Array.isArray(raw)) return [];
  const priorities = ['low', 'medium', 'high', 'critical'] as const;
  return raw
    .filter(
      (t): t is Record<string, unknown> =>
        typeof t === 'object' && t !== null && typeof (t as Record<string, unknown>).title === 'string',
    )
    .map((t) => ({
      title: String(t.title),
      description: typeof t.description === 'string' ? t.description : '',
      files_hint: typeof t.files_hint === 'string' ? t.files_hint : '',
      priority: priorities.includes(t.priority as (typeof priorities)[number])
        ? (t.priority as QueuedTask['priority'])
        : 'medium',
    }));
}

function coercePayload(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  return { result: typeof raw === 'string' ? raw : JSON.stringify(raw ?? null) };
}

/**
 * اجرای کامل تیم seocontent در یک چرخه:
 * سرپرست ← سه مجری موازی ← منتقد ← (تایید: حافظه + خروجی استاندارد) / (رد: بستهٔ بلوکر)
 */
export async function runTeam(input: RunTeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;
  const contentSummary = summarizeContentOutput(input.previousWavesOutput['content']);

  try {
    await reportLive?.('سرپرست: طراحی مأموریت‌ها', 20);
    const missions = await runSupervisor(contentSummary);

    await reportLive?.('مجری‌ها: سه خروجی موازی', 55);
    const [out1, out2, out3] = await Promise.all(
      missions.map((mission, i) => runWorker(i, mission, contentSummary)),
    );

    await reportLive?.('منتقد: داوری خروجی', 80);
    const verdict = await runCritic([out1, out2, out3]);
    const payload = coercePayload(verdict.payload);

    if (verdict.approved) {
      await writeMemory(TEAM, `learned:${input.runId}`, payload);

      const summary =
        typeof payload.summary === 'string' && payload.summary.trim().length > 0
          ? payload.summary
          : 'تیم seocontent چرخه را با موفقیت پشت سر گذاشت.';

      return {
        team: TEAM,
        summary,
        blockers: [],
        tasks: coerceTasks(payload.tasks),
        approved: true,
      };
    }

    // بسته‌بندی بلوکر: دلیل منتقد + یک کار رفع برای چرخهٔ بعد
    return {
      team: TEAM,
      summary: `منتقد خروجی تیم seocontent را رد کرد: ${verdict.reason}`,
      blockers: [verdict.reason],
      tasks: [
        {
          title: 'رفع ایراد منتقد seocontent',
          description: verdict.reason,
          files_hint: 'lib/teams/seocontent.ts',
          priority: 'medium',
        },
      ],
      approved: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      team: TEAM,
      summary: `اجرای تیم seocontent با خطا متوقف شد: ${message}`,
      blockers: [message],
      tasks: [],
      approved: false,
    };
  }
}
