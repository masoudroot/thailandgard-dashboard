/**
 * lib/planning.ts (Backend 11: planning service)
 *
 * Turns finished team results into development goals and phased build plans.
 * Both functions are failure-safe: any LLM problem (empty answer, bad JSON,
 * provider error) produces a valid, possibly empty result instead of throwing.
 */

import { callLLM, callLLMJson } from './llm';
import type { QueuedTask, TeamResult } from './types';

export interface Phase {
  title: string;
  tasks: QueuedTask[];
}

const MAX_GOALS = 5;
const MAX_PHASES = 3;
const MAX_TASKS_PER_PHASE = 4;

const PRIORITIES: QueuedTask['priority'][] = ['low', 'medium', 'high', 'critical'];

/** One-line Persian digest of a team result, used as prompt context. */
function digestTeamResult(r: TeamResult): string {
  const parts: string[] = [`تیم ${r.team}`];
  if (r.summary?.trim()) {
    parts.push(`خلاصه: ${r.summary.trim().slice(0, 400)}`);
  }
  if (r.blockers.length > 0) {
    parts.push(`گیرها: ${r.blockers.join('؛ ').slice(0, 300)}`);
  }
  const taskTitles = r.tasks
    .map((t) => t.title)
    .filter((t) => t && t.trim().length > 0)
    .slice(0, 5);
  if (taskTitles.length > 0) {
    parts.push(`کارهای پیشنهادی: ${taskTitles.join('؛ ')}`);
  }
  return parts.join('. ');
}

/**
 * Proposes 3 to 5 development goals for the next cycle from the teams' output.
 * Returns an empty array (never throws) when the LLM gives nothing usable.
 */
export async function generateGoals(teamResults: TeamResult[]): Promise<string[]> {
  if (teamResults.length === 0) return [];

  const context = teamResults.map(digestTeamResult).join('\n');
  const prompt = [
    'تو یک مدیر محصول فنی هستی. ۱۵ تیم هوش مصنوعی یک چرخه توسعه روی سایت «تایلندگرد» (آژانس مسافرتی آنلاین) کار کردند و خروجی‌شان پایین آمده.',
    'از روی همین خروجی‌ها، ۳ تا ۵ هدف توسعه برای چرخه بعدی پیشنهاد بده.',
    'قوانین:',
    '۱. هر هدف فقط یک جمله کوتاه و مشخص باشد.',
    '۲. هدف‌ها باید از داده‌های همین چرخه بیرون بیایند، نه حرف کلی.',
    '۳. فقط هدف‌ها را بنویس؛ هر هدف در یک خط جدا.',
    '۴. شماره، نقطه یا توضیح اضافه نکن.',
    '',
    'خروجی تیم‌ها:',
    context,
  ].join('\n');

  let raw: string;
  try {
    raw = await callLLM(prompt, { temperature: 0.6, maxTokens: 800 });
  } catch {
    return [];
  }

  const goals = raw
    .split('\n')
    .map((line) => line.trim().replace(/^[\d\-*.\s\u06F0-\u06F9]+/, '').trim())
    .filter((line) => line.length > 3);

  return Array.from(new Set(goals)).slice(0, MAX_GOALS);
}

/**
 * Breaks the goals into at most 3 phases, each with at most 4 tasks.
 * Returns an empty array (never throws) when the LLM gives nothing usable.
 */
export async function buildPhases(
  goals: string[],
  teamResults: TeamResult[],
): Promise<Phase[]> {
  if (goals.length === 0) return [];

  const goalsText = goals.map((g, i) => `${i + 1}. ${g}`).join('\n');
  const context = teamResults.map(digestTeamResult).join('\n');
  const prompt = [
    'تو یک مدیر محصول فنی هستی. این هدف‌های توسعه برای چرخه بعدی سایت «تایلندگرد» تصویب شده‌اند:',
    goalsText,
    '',
    'خروجی تیم‌های چرخه قبلی (برای زمینه):',
    context,
    '',
    'این هدف‌ها را در حداکثر ۳ فاز اجرایی بریز؛ هر فاز حداکثر ۴ کار.',
    'خروجی فقط یک JSON معتبر باشد، بدون متن اضافه و بدون بلاک کد:',
    '[{"title":"عنوان فاز","tasks":[{"title":"عنوان کار","description":"شرح کوتاه","files_hint":"مسیر فایل‌های احتمالی","priority":"low|medium|high|critical"}]}]',
  ].join('\n');

  let raw: unknown;
  try {
    raw = await callLLMJson(prompt, { temperature: 0.3, maxTokens: 2500 });
  } catch {
    return [];
  }

  return sanitizePhases(raw);
}

/** Clamps and validates raw LLM JSON into Phase[], dropping invalid entries. */
function sanitizePhases(raw: unknown): Phase[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_PHASES)
    .map(sanitizePhase)
    .filter((p): p is Phase => p !== null);
}

function sanitizePhase(p: unknown): Phase | null {
  if (typeof p !== 'object' || p === null) return null;
  const rec = p as { title?: unknown; tasks?: unknown };
  if (typeof rec.title !== 'string' || rec.title.trim().length === 0) return null;
  if (!Array.isArray(rec.tasks)) return null;

  const tasks = rec.tasks
    .slice(0, MAX_TASKS_PER_PHASE)
    .map(sanitizeTask)
    .filter((t): t is QueuedTask => t !== null);

  if (tasks.length === 0) return null;
  return { title: rec.title.trim(), tasks };
}

function sanitizeTask(t: unknown): QueuedTask | null {
  if (typeof t !== 'object' || t === null) return null;
  const rec = t as Record<string, unknown>;
  if (typeof rec.title !== 'string' || rec.title.trim().length === 0) return null;

  const priority = PRIORITIES.includes(rec.priority as QueuedTask['priority'])
    ? (rec.priority as QueuedTask['priority'])
    : 'medium';

  return {
    title: rec.title.trim(),
    description: typeof rec.description === 'string' ? rec.description : '',
    files_hint: typeof rec.files_hint === 'string' ? rec.files_hint : '',
    priority,
  };
}
