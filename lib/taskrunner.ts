/**
 * lib/taskrunner.ts: اجرای مستقیم و واقعی یک کار صف ساخت.
 *
 * وقتی مسعود برای یک کار «همین الان انجام شود» را انتخاب می‌کند، این ماژول
 * کار را با الگوی واقعی ساب‌ایجنت‌ها اجرا می‌کند: سرپرست (شکستن به سه
 * مأموریت) ← سه مجری ← منتقد. سوییچ «اجرای موازی» واقعاً به منطق اجرا وصل
 * است: true یعنی سه مجری با Promise.all هم‌زمان، false یعنی ترتیبی یکی‌یکی.
 *
 * مدل اجرا از زنجیرهٔ واقعی lib/llm.ts می‌آید: انتخاب خود کار (task.llm)،
 * بعد مدل تیم، بعد env؛ هیچ مقداری هاردکد نیست.
 */
import { callLLM, callLLMJson } from './llm';
import {
  approveTask,
  completeTask,
  getTask,
  getTaskPrefs,
  markTaskFailed,
  markTaskRunning,
} from './taskqueue';
import { TEAMS, type TeamName } from './types';

export interface DirectTaskInput {
  id: string;
  title: string;
  description: string;
  team: TeamName;
  files: string[];
  /** انتخاب مدل خود کار؛ خالی یعنی زنجیرهٔ پیش‌فرض (تیم ← env). */
  llm?: { endpointId: string; model: string } | null;
}

export interface DirectTaskOptions {
  /** true: مجری‌ها موازی؛ false: مجری‌ها ترتیبی. */
  parallel: boolean;
}

interface SupervisorPlan {
  workers: string[];
}

interface CriticVerdict {
  approved: boolean;
  reason: string;
  payload?: string;
}

const WORKER_SYSTEM =
  'تو مجری یک تیم فنی تایلندگرد هستی. فقط روی مأموریت داده‌شده کار کن؛ واقعیت، بدون حدس.';

function baseOpts(input: DirectTaskInput) {
  return {
    team: input.team,
    ...(input.llm ? { task: input.llm } : {}),
  };
}

function taskBrief(input: DirectTaskInput): string {
  const files = input.files.length > 0 ? `\nفایل‌های مرتبط:\n${input.files.join('\n')}` : '';
  return `کار: ${input.title}\nتوضیح: ${input.description || 'ثبت نشده'}${files}`;
}

/**
 * اجرای واقعی کار و برگرداندن خلاصهٔ فارسی نتیجه برای ثبت در build_queue.
 * در صورت خطای LLM، throw می‌کند تا فراخواننده وضعیت failed را ثبت کند.
 */
export async function runTaskDirect(
  input: DirectTaskInput,
  opts: DirectTaskOptions,
): Promise<string> {
  const llmOpts = baseOpts(input);
  const brief = taskBrief(input);

  // ۱) سرپرست: شکستن کار به سه مأموریت مجزا
  const plan = await callLLMJson<SupervisorPlan>(
    `تو سرپرست تیم ${input.team} تایلندگرد هستی.\n\n${brief}\n\n` +
      'این کار را به سه مأموریت مجزا و قابل‌اجرا برای سه مجری بشکن. ' +
      'خروجی فقط JSON معتبر با کلید workers شامل آرایه‌ای از سه رشته مأموریت.',
    { ...llmOpts, system: 'تو سرپرست فنی تایلندگرد هستی.', temperature: 0.3 },
  );
  const missions = Array.isArray(plan.workers)
    ? plan.workers.map((m) => String(m).trim()).filter(Boolean).slice(0, 3)
    : [];
  if (missions.length === 0) {
    throw new Error('سرپرست هیچ مأموریتی برای این کار برنگرداند.');
  }

  // ۲) مجری‌ها: موازی یا ترتیبی، طبق سوییچ واقعی کار
  const runWorker = (mission: string, i: number) =>
    callLLM(`مأموریت سرپرست:\n${mission}\n\nزمینهٔ کار:\n${brief}`, {
      ...llmOpts,
      system: `${WORKER_SYSTEM} (مجری ${i + 1})`,
      temperature: 0.5,
      maxTokens: 3000,
    });

  let workerTexts: string[];
  if (opts.parallel) {
    workerTexts = await Promise.all(missions.map((m, i) => runWorker(m, i)));
  } else {
    workerTexts = [];
    for (let i = 0; i < missions.length; i++) {
      workerTexts.push(await runWorker(missions[i], i));
    }
  }

  // ۳) منتقد: داوری خروجی مجری‌ها
  const verdict = await callLLMJson<CriticVerdict>(
    missions
      .map((m, i) => `خروجی مجری ${i + 1} (مأموریت: ${m}):\n${workerTexts[i] ?? ''}`)
      .join('\n\n') +
      '\n\nداوری کن و فقط JSON معتبر بده با کلیدهای: approved (بولین)، reason (یک جمله)، payload (متن نهایی تأییدشده یا اصلاح‌شده).',
    { ...llmOpts, system: 'تو منتقد سخت‌گیر تایلندگرد هستی.', temperature: 0.2 },
  );

  const mode = opts.parallel ? 'موازی' : 'ترتیبی';
  const lines = [
    `تیم ${input.team} کار «${input.title}» را مستقیم اجرا کرد (مجری‌ها: ${mode}).`,
    `حکم منتقد: ${verdict.approved ? 'تأیید' : 'نیاز به بازبینی'}؛ ${verdict.reason}`,
  ];
  if (verdict.payload) lines.push(`خروجی نهایی:\n${verdict.payload.slice(0, 2000)}`);
  return lines.join('\n');
}

/**
 * شروع واقعی اجرای یک کار («همین الان انجام شود»).
 *
 *  - کار pending اول تأیید می‌شود (انتخاب «همین الان» یعنی تأیید مسعود).
 *  - وضعیت به in_progress می‌رود (best-effort) و اجرا در پس‌زمینه ادامه می‌یابد.
 *  - موفق: done + خلاصهٔ واقعی. ناموفق: failed + دلیل واقعی.
 *  - سوییچ parallel کار واقعاً خوانده و به اجرا داده می‌شود.
 */
export async function triggerTaskRun(id: string): Promise<void> {
  const task = await getTask(id);
  if (!task) throw new Error('کار پیدا نشد.');
  if (!TEAMS.includes(task.team as TeamName)) {
    throw new Error(`تیم نامعتبر است: ${task.team}`);
  }
  if (!['pending', 'approved'].includes(task.status)) {
    throw new Error(`این کار در وضعیت «${task.status}» قابل اجرا نیست.`);
  }

  const prefs = await getTaskPrefs(id).catch(() => ({ execution_mode: 'cycle' as const, parallel: true }));

  if (task.status === 'pending') {
    await approveTask(id);
  }
  await markTaskRunning(id);

  const input: DirectTaskInput = {
    id,
    title: task.title,
    description: task.description ?? '',
    team: task.team as TeamName,
    files: (task.files_hint ?? '').split('\n').map((f) => f.trim()).filter(Boolean),
    llm: task.llmEndpointId && task.llmModel
      ? { endpointId: task.llmEndpointId, model: task.llmModel }
      : null,
  };

  // fire-and-forget: پاسخ 202 برمی‌گردد، اجرا در پس‌زمینه ادامه می‌یابد.
  void (async () => {
    try {
      const summary = await runTaskDirect(input, { parallel: prefs.parallel });
      await completeTask(id, summary);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[taskrunner] task ${id} failed:`, message);
      await markTaskFailed(id, message);
    }
  })();
}
