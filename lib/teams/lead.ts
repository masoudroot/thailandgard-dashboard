/**
 * lib/teams/lead.ts: تیم «عملیات لید و SLA» تایلندگرد
 *
 * اقتباس از ورک‌فلو n8n: سرپرست ← ۳ مجری موازی ← منتقد سخت‌گیر.
 * قانون حریم خصوصی: در هیچ خروجی (خلاصه، هشدار، تسک، حافظه) شماره تماس یا
 * اطلاعات شخصی نمی‌آید؛ فقط شناسهٔ لید. تابع sanitizePII این را در کد تضمین می‌کند.
 */

import { callLLM, callLLMJson } from '../llm';
import { buildKnowledgePromptSection } from '../rag';
import { extractCriticKnowledge, criticKnowledgeLog } from '../knowledge/critic-knowledge';
import type { ProgressReporter, MemoryEntry, QueuedTask, TeamName, TeamResult } from '../types';

export const TEAM: TeamName = 'lead';

export const MISSION =
  'صاحب عملیات نیمهٔ دوم قیف است (از کلیک تماس تا تماس موفق): لیدهای تازه را پایش می‌کند، SLA را کنترل می‌کند و هشدار می‌دهد؛ خودش تماس نمی‌گیرد.';

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

interface CriticPayload {
  summary: string;
  alerts: string[];
  tasks: string[];
}

interface CriticVerdict {
  approved: boolean;
  reason: string;
  payload: CriticPayload;
}

/**
 * حذف شماره تماس (لاتین و فارسی) از هر متنی که به گزارش یا حافظه می‌رود.
 * قانون تیم: در گزارش فقط شناسهٔ لید می‌آید، نه شماره تماس.
 */
function sanitizePII(text: string): string {
  return text
    .replace(/\b09\d{9}\b/g, '(شمارهٔ مخفی)')
    .replace(/\b۰۹[۰-۹]{9}\b/g, '(شمارهٔ مخفی)');
}

/** سرپرست: از زمینه، سه مأموریت مجزا برای سه مجری می‌سازد. */
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
  const priorLines = Object.entries(input.previousWavesOutput)
    .map(([team, out]) => `- ${team}: ${out}`)
    .join('\n');
  const prompt = [
    'زمینه:',
    ...(knowledgeSection ? [knowledgeSection, ''] : []),
    input.ragContext || '(زمینه‌ای نیست)',
    '',
    memoryLines ? `یادگیری‌های قبلی:\n${memoryLines}` : '',
    priorLines ? `خروجی تیم‌های موج‌های قبلی:\n${priorLines}` : '',
    '',
    'مأموریت تیم lead: صاحب عملیات نیمهٔ دوم قیف است (از کلیک تماس تا تماس موفق)؛ لیدهای تازه را پایش می‌کند، SLA را کنترل می‌کند و هشدار می‌دهد. خودش تماس نمی‌گیرد.',
    '',
    'بر اساس زمینه و دانش بازیابی‌شده، تصمیم بگیر این چرخه چه کاری باید انجام شود و آن را به سه مأموریت مجزا برای سه مجری بشکن: مجری ۱ (پایش جدول leads: لیدهای تازه و وضعیت‌ها)، مجری ۲ (کنترل SLA: هشدار فوری اگر لیدی بیش از ۶ ساعت «تازه» بماند و به‌روزرسانی وضعیت‌ها)، مجری ۳ (بازخورد بهبود تبدیل: فرم، دکمه، مسیر تماس).',
    'فقط JSON معتبر بده با کلید workers شامل سه رشتهٔ مأموریت.',
  ]
    .filter((l) => l !== '')
    .join('\n');
  return callLLMJson<SupervisorPlan>(prompt, {
    system: 'تو سرپرست تیم lead تایلندگرد هستی. فقط JSON معتبر می‌دهی؛ بدون حدس.',
    temperature: 0.3,
  });
}

/** مجری ۱: پایش لیدهای تازه و وضعیت‌ها. فقط واقعیت؛ بدون حدس. */
async function runWorkerMonitor(mission: string): Promise<string> {
  const prompt = [
    'مأموریت سرپرست:',
    mission || '(مأموریتی تعیین نشده؛ جدول leads را پایش کن)',
    '',
    'نقش تو: جدول leads را در این چرخه پایش می‌کنی؛ لیدهای تازه و وضعیت‌ها را فهرست می‌کنی. فقط واقعیت؛ بدون حدس.',
  ].join('\n');
  return callLLM(prompt, {
    system: 'تو مجری تیم lead تایلندگرد هستی. فارسی تمیز، بدون ادعای بی‌پشتوانه.',
    temperature: 0.5,
  });
}

/** مجری ۲: کنترل SLA و هشدار فوری برای لیدهای «تازه»ی بالای ۶ ساعت. */
async function runWorkerSla(mission: string): Promise<string> {
  const prompt = [
    'مأموریت سرپرست:',
    mission || '(مأموریتی تعیین نشده؛ SLA لیدها را کنترل کن)',
    '',
    'نقش تو: SLA را کنترل می‌کنی؛ اگر لیدی بیش از ۶ ساعت در وضعیت «تازه» بماند، هشدار فوری می‌دهی و وضعیت‌ها را به‌روز می‌کنی. فقط واقعیت؛ بدون حدس.',
  ].join('\n');
  return callLLM(prompt, {
    system: 'تو مجری تیم lead تایلندگرد هستی. فارسی تمیز، بدون ادعای بی‌پشتوانه.',
    temperature: 0.2,
  });
}

/** مجری ۳: بازخورد بهبود تبدیل. هرگز شماره تماس در گزارش نمی‌آید. */
async function runWorkerConversion(mission: string): Promise<string> {
  const prompt = [
    'مأموریت سرپرست:',
    mission || '(مأموریتی تعیین نشده؛ بازخورد بهبود تبدیل بنویس)',
    '',
    'نقش تو: بازخورد بهبود تبدیل می‌نویسی (فرم، دکمه، مسیر تماس). قانون حریم خصوصی: در گزارش فقط شناسهٔ لید می‌آید، هرگز شماره تماس یا اطلاعات شخصی. فقط واقعیت؛ بدون حدس.',
  ].join('\n');
  return callLLM(prompt, {
    system: 'تو مجری تیم lead تایلندگرد هستی. فارسی تمیز، بدون ادعای بی‌پشتوانه.',
    temperature: 0.7,
  });
}

/** منتقد سخت‌گیر: هیچ لیدی گم نشده؟ هشدار SLA به‌موقع بود؟ اطلاعات شخصی نیامده؟ */
async function runCritic(outputs: [string, string, string]): Promise<CriticVerdict> {
  const prompt = [
    'خروجی مجری ۱:',
    outputs[0],
    '',
    'خروجی مجری ۲:',
    outputs[1],
    '',
    'خروجی مجری ۳:',
    outputs[2],
    '',
    'داوری کن و فقط JSON معتبر بده با کلیدهای: approved (بولین)، reason (یک جمله)، payload (شیئی با کلیدهای summary رشته‌ای، alerts آرایه‌ای از هشدارهای SLA، tasks آرایه‌ای از پیشنهادهای بهبود تبدیل).',
    'تمرکز داوری: آیا هیچ لیدی گم نشده، هشدار SLA به‌موقع صادر شده و اطلاعات شخصی در گزارش نیامده؟',
  ].join('\n');
  return callLLMJson<CriticVerdict>(prompt, {
    system: 'تو منتقد سخت‌گیر تیم lead هستی. فقط JSON معتبر می‌دهی.',
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
  const [mission1 = '', mission2 = '', mission3 = ''] = plan.workers ?? [];

  await reportLive?.('مجری‌ها: پایش، SLA و تبدیل', 50);
  const outputs = await Promise.all([
    runWorkerMonitor(mission1),
    runWorkerSla(mission2),
    runWorkerConversion(mission3),
  ]);
  await reportLive?.('منتقد: داوری خروجی', 80);
  const verdict = await runCritic(outputs as [string, string, string]);

  const safeReason = sanitizePII(verdict.reason ?? '');
  const payload: CriticPayload = {
    summary: sanitizePII(verdict.payload?.summary ?? ''),
    alerts: (verdict.payload?.alerts ?? []).map(sanitizePII),
    tasks: (verdict.payload?.tasks ?? []).map(sanitizePII),
  };

  const blockers: string[] = [];
  const tasks: QueuedTask[] = [];

  if (!verdict.approved) {
    blockers.push(`منتقد lead تأیید نکرد: ${safeReason}`);
    blockers.push(...payload.alerts);
  } else {
    blockers.push(...payload.alerts);
    for (const taskText of payload.tasks.slice(0, 3)) {
      tasks.push({
        title: taskText.length > 80 ? `${taskText.slice(0, 77)}...` : taskText,
        description: taskText,
        files_hint: 'site/components/**',
        priority: 'medium',
      });
    }
  }

  const lesson = verdict.approved
    ? `چرخهٔ موفق: ${safeReason} | هشدار SLA: ${payload.alerts.length} مورد`
    : `رد منتقد: ${safeReason} | هشدار SLA: ${payload.alerts.length} مورد`;
  await remember(input.runId, sanitizePII(lesson));

  // استخراج دانش حرفه‌ای از حکم منتقد و ایندکس در RAG
  const knowledgeResult = await extractCriticKnowledge(
    TEAM,
    { approved: verdict.approved, reason: verdict.reason, domain: 'جذب لید' },
    input.runId,
  );
  const knowledgeLog = criticKnowledgeLog(knowledgeResult);

  const summary = verdict.approved
    ? `تیم لید این چرخه لیدهای تازه و وضعیت‌ها را پایش کرد، SLA را کنترل کرد و ${payload.alerts.length} هشدار ثبت شد؛ منتقد تأیید کرد. دلیل: ${safeReason} ${knowledgeLog}`
    : `تیم لید این چرخه خروجی تولید کرد ولی منتقد آن را تأیید نکرد و کار به چرخهٔ بعد موکول شد. دلیل: ${safeReason} ${knowledgeLog}`;

  return {
    team: TEAM,
    summary: sanitizePII(summary),
    blockers,
    tasks,
    approved: verdict.approved,
  };
}
