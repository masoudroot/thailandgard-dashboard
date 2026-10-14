/**
 * lib/teams/inspector.ts: تیم inspector (بازرس سایت زنده)
 *
 * آخرین تیم چرخه (موج ۶) و وابسته به خروجی موج‌های قبلی، به‌ویژه qa.
 * خط لوله، اقتباس تمیز از ورک‌فلوی n8n است:
 *   سرپرست (تقسیم کار به سه مأموریت) ← سه مجری موازی ← منتقد سخت‌گیر
 *   ← ثبت حافظه (learned:<runId>) ← خروجی تیم / بلوکر
 *
 * با qa فرق دارد: qa خروجی همان اجراست، بازرس سلامت کل سایت است.
 */

import { callLLM } from '../llm';
import { writeMemory } from '../memory';
import type {
  QueuedTask,
  TeamName,
  TeamResult,
} from '../types';

export const TEAM: TeamName = 'inspector';

/** مأموریت یک‌خطی تیم. */
export const MISSION: string =
  'چشم همیشه‌باز روی سایت زنده و بیلدشده است؛ رندر را می‌بیند، اسکرین‌شات را وارسی می‌کند، رگرسیون شکار می‌کند و یافتهٔ لازم‌الاجرا به تیم مالک می‌دهد.';

const SUPERVISOR_SYSTEM = 'تو سرپرست تیم inspector تایلندگرد هستی.';
const EXECUTOR_SYSTEM = 'تو مجری تیم inspector تایلندگرد هستی.';
const CRITIC_SYSTEM = 'تو منتقد سخت‌گیر تیم inspector هستی.';

/** مأموریت‌های سه‌گانهٔ مجری‌ها، اقتباس‌شده از پرامپت‌های n8n. */
const EXECUTOR_MISSIONS: string[] = [
  'گشت چرخشی روی مسیرهای اصلی با نردبان نگاه انجام بده: رندر نه سورس، اسکرین‌شات، چشم زنده. فقط واقعیت؛ بدون حدس.',
  'یافته‌ها را با شاهد (اسکرین‌شات/HTML/URL) با شدت و ضرب‌الاجل (SLA) ثبت کن. فقط واقعیت؛ بدون حدس.',
  '«بازبینی بست» انجام بده: یافته فقط با راستی‌آزمایی مجدد خود بازرس بسته می‌شود. فقط واقعیت؛ بدون حدس.',
];

/** ورودی اجرای تیم: شناسهٔ اجرا و خروجی موج‌های قبلی. */
export interface RunTeamInput {
  runId: string;
  previousWavesOutput: Partial<Record<TeamName, TeamResult | null>>;
}

interface CriticVerdict {
  approved: boolean;
  reason: string;
  payload?: unknown;
}

/** پارس خروجی منتقد مثل نود «پارس منتقد» در n8n: استخراج JSON از متن. */
function parseCriticVerdict(text: string): CriticVerdict {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text) as Partial<CriticVerdict>;
    return {
      approved: parsed.approved === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      payload: parsed.payload,
    };
  } catch {
    return { approved: false, reason: 'JSON نامعتبر', payload: text.slice(0, 500) };
  }
}

/** پارس پاسخ سرپرست: آرایه‌ای از سه مأموریت متنی. */
function parseSupervisorWorkers(text: string): string[] {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text) as {
      workers?: Array<string | { mission?: string }>;
    };
    const workers = Array.isArray(parsed.workers) ? parsed.workers : [];
    return workers
      .map((w) => (typeof w === 'string' ? w : w?.mission ?? ''))
      .filter((w) => w.length > 0);
  } catch {
    return [];
  }
}

/** زمینه برای سرپرست: خلاصهٔ خروجی qa و بقیهٔ موج‌های قبلی. */
function buildContext(previousWavesOutput: RunTeamInput['previousWavesOutput']): string {
  const qa = previousWavesOutput['qa'];
  const lines: string[] = [];
  lines.push('خلاصهٔ خروجی تیم qa (موج قبلی):');
  lines.push(qa ? qa.summary : 'خروجی ثبت نشده است.');
  if (qa && qa.blockers.length > 0) {
    lines.push('بلوکرهای qa:');
    for (const b of qa.blockers) lines.push(`- ${b}`);
  }
  return lines.join('\n');
}

/** استخراج وظایف پیشنهادی از payload منتقد، در صورت وجود. */
function tasksFromPayload(payload: unknown): QueuedTask[] {
  if (!payload || typeof payload !== 'object') return [];
  const items = (payload as { tasks?: unknown }).tasks;
  if (!Array.isArray(items)) return [];
  const priorities = ['low', 'medium', 'high', 'critical'] as const;
  return items
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
    .slice(0, 10)
    .map((t) => {
      const p = typeof t.priority === 'string' ? t.priority : 'medium';
      return {
        title: typeof t.title === 'string' ? t.title : 'یافتهٔ بازرس',
        description: typeof t.description === 'string' ? t.description : '',
        files_hint: typeof t.files_hint === 'string' ? t.files_hint : '',
        priority: (priorities as readonly string[]).includes(p)
          ? (p as QueuedTask['priority'])
          : 'medium',
      };
    });
}

/**
 * اجرای کامل تیم inspector برای یک چرخه.
 */
export async function runTeam(input: RunTeamInput): Promise<TeamResult> {
  const { runId, previousWavesOutput } = input;
  const context = buildContext(previousWavesOutput);

  // ۱. سرپرست: شکستن کار این چرخه به سه مأموریت مجزا برای سه مجری.
  const supervisorPrompt = [
    'زمینه (خروجی موج‌های قبلی و دانش بازیابی‌شده):',
    context,
    '',
    `مأموریت تیم inspector: ${MISSION}`,
    'با qa فرق دارد: qa خروجی همان اجراست، بازرس سلامت کل سایت است.',
    '',
    'بر اساس زمینه، تصمیم بگیر این چرخه چه کاری باید انجام شود و آن را به سه مأموریت مجزا برای سه مجری بشکن.',
    'خروجی: فقط JSON معتبر با کلید workers شامل سه مأموریت متنی.',
  ].join('\n');

  const supervisorText = await callLLM(supervisorPrompt, { system: SUPERVISOR_SYSTEM });
  const missions = parseSupervisorWorkers(supervisorText);
  const resolvedMissions =
    missions.length === 3 ? missions : EXECUTOR_MISSIONS;

  // ۲. سه مجری، موازی، هر کدام با مأموریت خودش.
  const executorOutputs = await Promise.all(
    resolvedMissions.map((mission, i) =>
      callLLM(
        [
          'مأموریت سرپرست:',
          mission,
          '',
          `نقش تو: ${EXECUTOR_MISSIONS[i]}`,
        ].join('\n'),
        { system: EXECUTOR_SYSTEM },
      ),
    ),
  );

  // ۳. منتقد سخت‌گیر: داوری هر سه خروجی.
  const criticPrompt = [
    'خروجی مجری ۱:',
    executorOutputs[0],
    '',
    'خروجی مجری ۲:',
    executorOutputs[1],
    '',
    'خروجی مجری ۳:',
    executorOutputs[2],
    '',
    'داوری کن و فقط JSON معتبر بده با کلیدهای: approved (بولین)، reason (یک جمله)، payload.',
    'تمرکز داوری: آیا هر یافته شاهد دارد، شدت و ضرب‌الاجل درست خورده و ادعای «حل شد» تیم مالک بدون بازبینی پذیرفته نشده؟',
  ].join('\n');

  const criticText = await callLLM(criticPrompt, {
    system: CRITIC_SYSTEM,
    temperature: 0.2,
  });
  const verdict = parseCriticVerdict(criticText);

  // ۴. ثبت حافظه با کلید learned:<runId>.
  const memoryValue = {
    content: String(criticText).slice(0, 2000),
    approved: verdict.approved,
    run_id: runId,
  };
  await writeMemory(TEAM, `learned:${runId}`, memoryValue);

  // ۵. خروجی استاندارد تیم.
  const summary = verdict.reason
    ? `بازرس سایت زنده: ${verdict.reason}`
    : 'بازرس سایت زنده: چرخهٔ بازرسی انجام شد.';

  if (!verdict.approved) {
    const tasks = tasksFromPayload(verdict.payload);
    tasks.push({
      title: 'رفع بلوکر تیم inspector',
      description: `بلوکر تیم inspector: ${verdict.reason}`,
      files_hint: '',
      priority: 'critical',
    });
    return {
      team: TEAM,
      summary,
      blockers: [`بلوکر تیم inspector: ${verdict.reason}`],
      tasks,
      approved: false,
    };
  }

  return {
    team: TEAM,
    summary,
    blockers: [],
    tasks: tasksFromPayload(verdict.payload),
    approved: true,
  };
}
