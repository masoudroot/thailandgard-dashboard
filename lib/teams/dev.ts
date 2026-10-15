/**
 * lib/teams/dev.ts : تیم توسعه (dev)
 *
 * تصمیم‌های مدیر و طرح‌های تیم طراحی را به کد تمیز روی شاخهٔ dev تبدیل می‌کند.
 * چرخهٔ اجرا، اقتباس از ورک‌فلو n8n ‏«thailandgard-all-teams» است:
 * سرپرست ← سه مجری ← منتقد ← (تأیید: ثبت حافظه) یا (رد: بستهٔ بلوکر).
 * ورودی اصلی، خروجی تیم طراحی از موج قبلی است: ‏previousWavesOutput['design'].
 */

import { callLLM, callLLMJson } from '../llm';
import { writeMemory } from '../memory';
import type { ProgressReporter, QueuedTask, TeamName, TeamResult } from '../types';

export const TEAM: TeamName = 'dev';

/** مأموریت یک‌خطی تیم. */
export const MISSION =
  'تصمیم‌های مدیر و طرح‌های تیم طراحی را به کد تمیز روی شاخهٔ dev تبدیل می‌کند؛ نیازهای سئو و محتوا را هم کد می‌کند و هرگز مستقیم روی main کار نمی‌کند.';

/** ورودی runTeam: شناسهٔ اجرا و خروجی تیم‌های موج‌های قبلی. */
export interface DevTeamInput {
  /** گزارش زنده‌ی پیشرفت به ارکستر؛ ارکستر همیشه آن را می‌دهد. */
  reportProgress?: ProgressReporter;
  runId: string;
  previousWavesOutput: Partial<Record<TeamName, TeamResult>>;
}

const SUPERVISOR_SYSTEM = 'تو سرپرست تیم dev تایلندگرد هستی.';
const WORKER_SYSTEM = 'تو مجری تیم dev تایلندگرد هستی.';
const CRITIC_SYSTEM = 'تو منتقد سخت‌گیر تیم dev هستی.';

/** نقش‌های سه مجری؛ اقتباس از نودهای «پارام مجری» ورک‌فلو n8n. */
const WORKER_ROLES = [
  'بریف‌ها و باگ‌های گزارش‌شدهٔ تیم qa را می‌خواند و تسک‌های ابلاغ‌شده را اولویت‌بندی می‌کند. فقط واقعیت؛ بدون حدس.',
  'پیاده‌سازی را روی dev انجام می‌دهد؛ کد باید با جدول خالی هم نسوزد (فالبک همیشه). فقط واقعیت؛ بدون حدس.',
  'هر تغییر را با توضیح کوتاه «چه شد و چرا» تحویل می‌دهد و بیلد سبز می‌گیرد. فقط واقعیت؛ بدون حدس.',
];

interface SupervisorPlan {
  workers: string[];
}

interface CriticVerdict {
  approved: boolean;
  reason: string;
  payload?: unknown;
}

/**
 * سه مأموریت را از خروجی سرپرست بیرون می‌کشد.
 * اگر JSON معتبر نبود، از سطرهای متن مأموریت می‌سازد.
 */
function normalizeMissions(raw: string): string[] {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  try {
    const parsed = JSON.parse(text) as SupervisorPlan;
    if (Array.isArray(parsed.workers)) {
      const missions = parsed.workers
        .map((m) => String(m).trim())
        .filter((m) => m.length > 0);
      if (missions.length > 0) return missions.slice(0, 3);
    }
  } catch {
    // JSON نبود؛ از سطرها ادامه می‌دهیم
  }

  return text
    .split('\n')
    .map((line) => line.replace(/^[\s\-*•\d۰-۹.)\]]+/, '').trim())
    .filter((line) => line.length > 10)
    .slice(0, 3);
}

/**
 * یک چرخهٔ کامل تیم dev را اجرا می‌کند و TeamResult استاندارد برمی‌گرداند.
 * اگر منتقد رد کند، خروجی بلوکر است و حافظه نوشته نمی‌شود.
 */
export async function runTeam(input: DevTeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;
  const { runId, previousWavesOutput } = input;
  const design = previousWavesOutput['design'];
  const designSummary =
    design?.summary?.trim() || 'خروجی تیم طراحی در این چرخه در دسترس نیست.';

  // ۱) سرپرست: تصمیم این چرخه و شکستن به سه مأموریت مجزا
  const supervisorPrompt =
    `زمینه (خروجی تیم طراحی):\n${designSummary}\n\n` +
    `مأموریت تیم dev: ${MISSION}\n\n` +
    'بر اساس زمینه، تصمیم بگیر این چرخه چه کاری باید انجام شود و آن را به سه مأموریت مجزا برای سه مجری بشکن. ' +
    'خروجی فقط JSON معتبر با کلید workers شامل آرایه‌ای از سه مأموریت رشته‌ای.';
  await reportLive?.('سرپرست: طراحی مأموریت‌ها', 15);
  const supervisorRaw = await callLLM(supervisorPrompt, {
    system: SUPERVISOR_SYSTEM,
    temperature: 0.3,
  });
  const missions = normalizeMissions(supervisorRaw);
  if (missions.length === 0) {
    throw new Error('سرپرست تیم dev هیچ مأموریتی برنگرداند.');
  }

  // ۲) سه مجری: هر کدام مأموریت خودش را اجرا می‌کند
  await reportLive?.('مجری‌ها: اجرای موازی مأموریت‌ها', 55);
  const workerTexts = await Promise.all(
    missions.map((mission, i) =>
      callLLM(`مأموریت سرپرست:\n${mission}\n\nنقش تو: ${WORKER_ROLES[i] ?? WORKER_ROLES[0]}`, {
        system: WORKER_SYSTEM,
        temperature: 0.5,
      }),
    ),
  );

  // ۳) منتقد: داوری با خروجی JSON ساخت‌یافته
  const criticPrompt =
    `خروجی مجری ۱:\n${workerTexts[0] ?? ''}\n\n` +
    `خروجی مجری ۲:\n${workerTexts[1] ?? ''}\n\n` +
    `خروجی مجری ۳:\n${workerTexts[2] ?? ''}\n\n` +
    'داوری کن و فقط JSON معتبر بده با کلیدهای: approved (بولین)، reason (یک جمله)، payload. ' +
    'تمرکز داوری: آیا کد راست‌چین با logical CSS است، روی main دست نرفته و فایل محیطی کامیت نشده؟';
  await reportLive?.('منتقد: داوری خروجی', 85);
  const verdict = await callLLMJson<CriticVerdict>(criticPrompt, {
    system: CRITIC_SYSTEM,
    temperature: 0.2,
  });
  const approved = verdict.approved === true;
  const reason = String(verdict.reason ?? '').trim() || 'منتقد دلیلی ثبت نکرد.';

  // ۴) تأیید؟ ثبت حافظه : بستهٔ بلوکر
  const summary = approved
    ? `تیم dev مأموریت‌های این چرخه را اجرا کرد و منتقد تأیید کرد: ${reason}`
    : `تیم dev این چرخه تأیید نشد؛ بلوکر: ${reason}`;

  if (approved) {
    await writeMemory(TEAM, `learned:${runId}`, {
      content: summary.slice(0, 2000),
      approved,
      run_id: runId,
    });
  }

  const tasks: QueuedTask[] = missions.map((mission) => ({
    title: mission.length > 120 ? `${mission.slice(0, 120)}…` : mission,
    description: mission,
    files_hint: '',
    priority: 'medium',
  }));

  return {
    team: TEAM,
    summary,
    blockers: approved ? [] : [reason],
    tasks,
    approved,
  };
}
