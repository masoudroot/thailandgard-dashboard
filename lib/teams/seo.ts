/**
 * lib/teams/seo.ts : تیم سئو (seo)
 *
 * مأموریت: دیده شدن تایلندگرد در گوگل فارسی برای جست‌وجوهای تور تایلند.
 * به خروجی موج‌های قبلی وابسته است؛ خلاصه تیم محتوا از
 * previousWavesOutput['content'] خوانده می‌شود.
 *
 * الگوی اجرا (اقتباس تمیز از ورک‌فلو n8n):
 *   سرپرست ← سه مجری موازی ← منتقد سخت‌گیر ← ثبت حافظه
 * دانش بازیابی‌شده (RAG) در صورت وجود از طریق input.knowledge تزریق می‌شود.
 */

import type { ProgressReporter, QueuedTask, TeamName, TeamResult } from '../types';
import { callLLM, callLLMJson } from '../llm';
import { writeMemory } from '../memory';
import { buildKnowledgePromptSection } from '../rag';

export const TEAM: TeamName = 'seo';

/** یک خط فارسی: مأموریت تیم سئو */
export const MISSION =
  'تایلندگرد در گوگل فارسی برای جست‌وجوهای تور تایلند دیده شود؛ اول ایندکس کامل، بعد نقشهٔ کلمات با منطق «اول بردهای کوچک».';

/** ورودی runTeam */
export interface SeoTeamInput {
  /** گزارش زنده‌ی پیشرفت به ارکستر؛ ارکستر همیشه آن را می‌دهد. */
  reportProgress?: ProgressReporter;
  /** شناسه اجرای جاری (برای کلید حافظه: learned:<runId>) */
  runId: string;
  /** خروجی تیم‌های موج‌های قبلی؛ تیم سئو خلاصه تیم محتوا را از ['content'] می‌خواند */
  previousWavesOutput?: Record<string, TeamResult | string>;
  /** دانش بازیابی‌شده از RAG (اختیاری) */
  knowledge?: string;
}

/** نقش‌های ثابت سه مجری (از نودهای پارام مجری n8n، فارسی تمیز) */
const WORKER_ROLES = [
  'وضعیت ایندکس روزانه (سایت‌مپ و robots)، ساختار صفحه‌ها و لینک داخلی را بررسی می‌کند.',
  'بریف‌های فنی تک‌قانونی برای تیم dev می‌سازد و اسکیماها را با محتوای دیتابیسی همگام نگه می‌دارد.',
  'نقشهٔ کلمات کلیدی را نسخه‌به‌نسخه به‌روز می‌کند و پیشنهاد محتوایی می‌دهد (چه صفحه‌ای، با چه عبارتی).',
] as const;

/** شکل JSON خروجی منتقد */
interface CriticVerdict {
  approved: boolean;
  reason: string;
  payload?: {
    summary?: string;
    tasks?: Array<{
      title?: string;
      description?: string;
      files_hint?: string;
      priority?: string;
    }>;
    blockers?: string[];
  };
}

const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
type Priority = (typeof VALID_PRIORITIES)[number];

/** خلاصه تیم محتوا را از خروجی موج‌های قبلی بیرون می‌کشد */
function getContentSummary(
  previousWavesOutput: SeoTeamInput['previousWavesOutput'],
): string {
  const content = previousWavesOutput?.['content'];
  if (!content) return '(خلاصه‌ای از تیم محتوا در دسترس نیست)';
  if (typeof content === 'string') return content;
  return content.summary || '(خلاصه‌ای از تیم محتوا در دسترس نیست)';
}

/** نرمال‌سازی خروجی سرپرست به سه مأموریت متنی */
function normalizeMissions(raw: unknown): [string, string, string] {
  const fallback: [string, string, string] = [
    'بررسی وضعیت ایندکس روزانه و ساختار صفحه‌ها و لینک داخلی',
    'ساخت بریف‌های فنی تک‌قانونی برای تیم dev و همگام‌سازی اسکیماها با محتوای دیتابیسی',
    'به‌روزرسانی نقشهٔ کلمات کلیدی و ارائه پیشنهاد محتوایی',
  ];
  try {
    const workers = (raw as { workers?: unknown })?.workers;
    if (!Array.isArray(workers)) return fallback;
    const missions = workers
      .map((w) =>
        typeof w === 'string'
          ? w
          : typeof w === 'object' && w !== null
            ? String(
                (w as { mission?: unknown; text?: unknown }).mission ??
                  (w as { mission?: unknown; text?: unknown }).text ??
                  '',
              )
            : '',
      )
      .filter((m) => m.length > 0);
    if (missions.length < 3) return fallback;
    return [missions[0], missions[1], missions[2]];
  } catch {
    return fallback;
  }
}

/** پرامپت سرپرست: تصمیم چرخه و شکستن به سه مأموریت (از «پارام سرپرست (seo)») */
function supervisorPrompt(knowledge: string, contentSummary: string): string {
  return `زمینه (دانش بازیابی‌شده):
${knowledge}

خلاصه خروجی تیم محتوا در موج قبلی:
${contentSummary}

مأموریت تیم سئو: ${MISSION}

بر اساس زمینه و خلاصه تیم محتوا، تصمیم بگیر این چرخه چه کاری باید انجام شود و آن را به سه مأموریت مجزا و مشخص برای سه مجری بشکن:
یک مأموریت برای وضعیت ایندکس و ساختار، یک مأموریت برای بریف‌های فنی و اسکیما، یک مأموریت برای نقشه کلمات کلیدی و پیشنهاد محتوایی.
فقط JSON معتبر بده، بدون هیچ متن اضافه:
{"workers": ["مأموریت مجری ۱", "مأموریت مجری ۲", "مأموریت مجری ۳"]}`;
}

/** پرامپت مجری (از «پارام مجری ۱/۲/۳ (seo)») */
function workerPrompt(mission: string, role: string): string {
  return `مأموریت سرپرست برای تو:
${mission}

نقش ثابت تو: ${role}

فقط واقعیت را بنویس؛ حدس نزن. خروجی کوتاه، مشخص و قابل اجرا باشد.`;
}

/** پرامپت منتقد سخت‌گیر (از «پارام منتقد (seo)») */
function criticPrompt(text1: string, text2: string, text3: string): string {
  return `تو منتقد سخت‌گیر تیم سئو هستی.

خروجی مجری ۱:
${text1}

خروجی مجری ۲:
${text2}

خروجی مجری ۳:
${text3}

داوری کن. تمرکز داوری: آیا هر ادعای رتبه سند دارد و هیچ تکنیک خاکستری (خرید لینک، متن پنهان یا هر ترفند گمراه‌کننده) به کار نرفته؟
فقط JSON معتبر بده، بدون هیچ متن اضافه:
{
  "approved": true,
  "reason": "یک جمله",
  "payload": {
    "summary": "خلاصه یک‌خطی نتیجه تیم",
    "tasks": [
      {"title": "...", "description": "...", "files_hint": "...", "priority": "low"}
    ],
    "blockers": ["..."]
  }
}
اگر تأیید نشد، approved را false بگذار، دلیل را در reason بنویس و tasks را آرایه خالی بگذار.`;
}

/** tasks خروجی منتقد را به QueuedTask معتبر تبدیل می‌کند */
function coerceTasks(raw: CriticVerdict['payload']): QueuedTask[] {
  const list = raw?.tasks;
  if (!Array.isArray(list)) return [];
  const out: QueuedTask[] = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const title = typeof t.title === 'string' ? t.title.trim() : '';
    if (!title) continue;
    const priority: Priority = VALID_PRIORITIES.includes(t.priority as Priority)
      ? (t.priority as Priority)
      : 'medium';
    out.push({
      title,
      description: typeof t.description === 'string' ? t.description : '',
      files_hint: typeof t.files_hint === 'string' ? t.files_hint : '',
      priority,
    });
  }
  return out;
}

/**
 * اجرای تیم سئو برای یک چرخه.
 * خلاصه تیم محتوا از previousWavesOutput['content'] خوانده می‌شود.
 */
export async function runTeam(input: SeoTeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;
  const { runId, previousWavesOutput, knowledge } = input;

  try {
    const contentSummary = getContentSummary(previousWavesOutput);
    const knowledgeText = knowledge?.trim() || '(دانش بازیابی‌شده‌ای در دسترس نیست)';

    // تزریق best-effort دانش تیم در ابتدای بخش زمینه (تیم ۱۳)؛
    // بدون دانش، پرامپت دقیقاً مثل قبل می‌ماند.
    let knowledgeSection = '';
    try {
      knowledgeSection = await buildKnowledgePromptSection(TEAM, MISSION);
    } catch {
      knowledgeSection = '';
    }
    const combinedKnowledge = [knowledgeSection, knowledgeText].filter(Boolean).join('\n\n');

    // ۱. سرپرست: تصمیم چرخه و سه مأموریت
    await reportLive?.('سرپرست: طراحی مأموریت‌ها', 20);
    const supervisorRaw = await callLLM(supervisorPrompt(combinedKnowledge, contentSummary), {
      system: 'تو سرپرست تیم سئوی تایلندگرد هستی.',
      temperature: 0.4,
    });
    const missions = normalizeMissions(parseLooseJson(supervisorRaw));

    // ۲. سه مجری، موازی
    const [text1, text2, text3] = await Promise.all(
      WORKER_ROLES.map((role, i) =>
        callLLM(workerPrompt(missions[i], role), {
          system: 'تو مجری تیم سئوی تایلندگرد هستی.',
          temperature: 0.5,
        }),
      ),
    );

    // ۳. منتقد سخت‌گیر
    await reportLive?.('منتقد: داوری خروجی', 70);
    const verdict = await callLLMJson<CriticVerdict>(criticPrompt(text1, text2, text3), {
      system: 'تو منتقد سخت‌گیر تیم سئو هستی. فقط JSON معتبر برمی‌گردانی.',
      temperature: 0.2,
    });
    const approved = verdict.approved === true;
    const reason = typeof verdict.reason === 'string' ? verdict.reason : '';
    const payload = verdict.payload ?? {};

    const tasks = approved ? coerceTasks(payload) : [];
    const blockers: string[] = Array.isArray(payload.blockers)
      ? payload.blockers.filter((b): b is string => typeof b === 'string' && b.length > 0)
      : [];
    if (!approved && reason) blockers.unshift(reason);

    const summary =
      (typeof payload.summary === 'string' && payload.summary.trim()) ||
      (approved ? 'خروجی تیم سئو تأیید شد.' : `خروجی تیم سئو تأیید نشد: ${reason}`);

    // ۴. ثبت حافظه با کلید learned:<runId>
    const memoryValue = JSON.stringify({
      content: summary.slice(0, 2000),
      reason: reason.slice(0, 500),
      approved,
      run_id: runId,
    });
    await writeMemory(TEAM, `learned:${runId}`, memoryValue);

    return { team: TEAM, summary, blockers, tasks, approved };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      team: TEAM,
      summary: `اجرای تیم سئو با خطا متوقف شد: ${message}`,
      blockers: [message],
      tasks: [],
      approved: false,
    };
  }
}

/** تلاش برای پارس JSON حتی با نویز دورش (برای خروجی سرپرست) */
function parseLooseJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
