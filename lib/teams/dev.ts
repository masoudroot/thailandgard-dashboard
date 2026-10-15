/**
 * lib/teams/dev.ts : تیم توسعه (dev) — کدنویس واقعی
 *
 * این تیم گزارش نمی‌نویسد؛ کد واقعی تولید می‌کند:
 * سرپرست (تصمیم + انتخاب فایل‌ها) ← خواندن فایل‌های واقعی ریپو ←
 * مجری‌ها (تولید محتوای کامل هر فایل) ← منتقد کد ← پچ نهایی
 *
 * خروجی: PatchFile[] در TeamResult.patch — یعنی [{path, content}]
 * اعمال پچ (کامیت روی شاخه) کار این تیم نیست؛ لایهٔ اعمال جداگانه انجامش می‌دهد.
 */

import { callLLM, callLLMJson } from '../llm';
import { writeMemory } from '../memory';
import { buildKnowledgePromptSection } from '../rag';
import { extractCriticKnowledge, criticKnowledgeLog } from '../knowledge/critic-knowledge';
import { readRepoFile } from '../github';
import type {
  PatchFile,
  ProgressReporter,
  QueuedTask,
  TeamName,
  TeamResult,
} from '../types';

export const TEAM: TeamName = 'dev';

/** مأموریت یک‌خطی تیم. */
export const MISSION =
  'کد واقعی برای سایت تایلندگرد می‌نویسد: فایل‌های ریپو را می‌خواند، محتوای کامل جدید تولید می‌کند و به فرمت پچ تحویل می‌دهد؛ هرگز روی main کار نمی‌کند و هرگز گزارشِ به‌جای کد نمی‌دهد.';

/** ورودی runTeam: شناسهٔ اجرا و خروجی تیم‌های موج‌های قبلی. */
export interface DevTeamInput {
  /** گزارش زنده‌ی پیشرفت به ارکستر؛ ارکستر همیشه آن را می‌دهد. */
  reportProgress?: ProgressReporter;
  runId: string;
  previousWavesOutput: Partial<Record<TeamName, TeamResult>>;
}

const SUPERVISOR_SYSTEM = 'تو سرپرست فنی تیم توسعهٔ تایلندگرد هستی. دقیق و عمل‌گرا.';
const WORKER_SYSTEM =
  'تو برنامه‌نویس ارشد تایلندگرد هستی. خروجی تو فقط کد واقعی است، نه توضیح، نه گزارش، نه خلاصه. ' +
  'اگر به‌جای کد، توضیح بنویسی، کارت رد می‌شود.';
const CRITIC_SYSTEM =
  'تو بازبین کد سخت‌گیر تایلندگرد هستی. کد را خط‌به‌خط می‌خوانی و فقط ایراد واقعی می‌گیری؛ ایرادِ سلیقه‌ای نه.';

/** سقف تعداد فایل در هر پچ پیشنهادی (مصوبهٔ پچ‌اسپک). */
const MAX_PATCH_FILES = 3;
/** سقف حجم محتوای هر فایل در پچ پیشنهادی: ۲۰ کیلوبایت. */
const MAX_PATCH_BYTES = 20 * 1024;

/** حجم بایت UTF-8 یک رشته. */
function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** یک تسک فایلی که سرپرست تعریف می‌کند. */
interface FileTask {
  /** مسیر نسبی فایل در ریپو، مثل site/components/Header.tsx */
  path: string;
  /** ساخت فایل تازه یا اصلاح فایل موجود */
  action: 'create' | 'modify';
  /** دستور دقیق و فنی به مجری: چه چیزی باید در فایل باشد یا عوض شود */
  instruction: string;
}

interface SupervisorPlan {
  /** هدف یک‌خطی این چرخه */
  goal: string;
  /** حداکثر ۳ فایل */
  tasks: FileTask[];
}

/** خروجی مجری: محتوای کامل یک فایل. */
interface WorkerPatch {
  path: string;
  content: string;
}

interface FileVerdict {
  path: string;
  approved: boolean;
  reason: string;
}

interface CriticVerdict {
  approved: boolean;
  reason: string;
  files: FileVerdict[];
}

/** نقشهٔ کلی ریپو برای کمک به سرپرست در انتخاب فایل. */
const REPO_MAP = [
  'site/ : کد سایت اصلی (Next.js) — کامپوننت‌ها در site/components، صفحات در site/app',
  'site/lib/ : منطق کمکی سایت',
  'site/app/api/ : روت‌های API سایت',
].join('\n');

/**
 * خروجی سرپرست را به پلن ساخت‌یافته تبدیل می‌کند.
 */
function normalizePlan(raw: string): SupervisorPlan | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  try {
    const parsed = JSON.parse(text) as SupervisorPlan;
    if (typeof parsed.goal === 'string' && Array.isArray(parsed.tasks)) {
      const tasks = parsed.tasks
        .filter(
          (t) =>
            t &&
            typeof t.path === 'string' &&
            t.path.trim().length > 0 &&
            typeof t.instruction === 'string' &&
            t.instruction.trim().length > 0,
        )
        .map((t) => ({
          path: t.path.trim().replace(/^\/+/, ''),
          action: t.action === 'create' ? ('create' as const) : ('modify' as const),
          instruction: t.instruction.trim(),
        }))
        .slice(0, 3);
      if (tasks.length > 0) return { goal: parsed.goal.trim(), tasks };
    }
  } catch {
    // JSON نامعتبر
  }
  return null;
}

/**
 * خروجی مجری را به پچ تبدیل می‌کند.
 */
function normalizePatch(raw: string, expectedPath: string): WorkerPatch | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  try {
    const parsed = JSON.parse(text) as WorkerPatch;
    const content = String(parsed.content ?? '');
    // محتوا باید کد واقعی باشد، نه چند خط توضیح
    if (content.trim().length < 20) return null;
    return {
      path: String(parsed.path ?? expectedPath).trim().replace(/^\/+/, '') || expectedPath,
      content,
    };
  } catch {
    return null;
  }
}

/**
 * مرحلهٔ نهایی بعد از منتقد: تبدیل خروجی تأییدشده به PatchFileهای واقعی.
 * سقف‌ها: حداکثر ۳ فایل، هر فایل حداکثر ۲۰ کیلوبایت.
 * فایل بزرگ‌تر از سقف حذف می‌شود (کد برش‌خورده بدتر از نبودنش است) و در
 * آرایهٔ dropped گزارش می‌شود.
 */
function finalizePatches(
  approved: WorkerPatch[],
  dropped: string[],
): PatchFile[] {
  const out: PatchFile[] = [];
  for (const p of approved.slice(0, MAX_PATCH_FILES)) {
    const size = utf8Bytes(p.content);
    if (size > MAX_PATCH_BYTES) {
      dropped.push(`${p.path} (${Math.round(size / 1024)}KB، سقف ۲۰KB)`);
      continue;
    }
    out.push({ path: p.path, content: p.content });
  }
  return out;
}

/**
 * یک چرخهٔ کامل تیم dev را اجرا می‌کند و TeamResult با patch واقعی برمی‌گرداند.
 */
export async function runTeam(input: DevTeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;
  const { runId, previousWavesOutput } = input;
  const design = previousWavesOutput['design'];
  const qa = previousWavesOutput['qa'];
  const designSummary =
    design?.summary?.trim() || 'خروجی تیم طراحی در این چرخه در دسترس نیست.';
  const qaSummary =
    qa?.summary?.trim() || 'گزارش باگ از تیم qa در دسترس نیست.';

  let knowledgeSection = '';
  try {
    knowledgeSection = await buildKnowledgePromptSection(TEAM, MISSION);
  } catch {
    knowledgeSection = '';
  }
  const knowledgePrefix = knowledgeSection ? `${knowledgeSection}\n\n` : '';

  // ۱) سرپرست: هدف این چرخه + انتخاب حداکثر ۳ فایل
  const supervisorPrompt =
    knowledgePrefix +
    `نقشهٔ ریپو:\n${REPO_MAP}\n\n` +
    `زمینهٔ طراحی:\n${designSummary}\n\n` +
    `باگ‌ها و نیازهای qa:\n${qaSummary}\n\n` +
    'بر اساس زمینه، تصمیم بگیر این چرخه دقیقاً چه کدی باید نوشته یا اصلاح شود. ' +
    'فقط JSON معتبر بده با این ساختار:\n' +
    '{"goal": "هدف یک‌خطی", "tasks": [{"path": "مسیر نسبی فایل", "action": "create یا modify", "instruction": "دستور دقیق فنی به مجری"}]}\n' +
    'قواعد: حداکثر ۳ فایل؛ مسیرها نسبی و دقیق؛ هرگز فایل .env یا package-lock را انتخاب نکن؛ ' +
    'instruction باید آن‌قدر دقیق باشد که مجری بدون سؤال کد را بنویسد.';
  await reportLive?.('سرپرست: انتخاب فایل‌ها و هدف', 15);
  const supervisorRaw = await callLLM(supervisorPrompt, {
    system: SUPERVISOR_SYSTEM,
    temperature: 0.3,
  });
  const plan = normalizePlan(supervisorRaw);
  if (!plan) {
    const reason = 'سرپرست پلن معتبر برنگرداند؛ این چرخه پچی تولید نشد.';
    return {
      team: TEAM,
      summary: reason,
      blockers: [reason],
      tasks: [],
      approved: false,
      patches: [],
      patch: [],
    };
  }

  // ۲) خواندن محتوای فعلی فایل‌ها از ریپو (برای action=modify)
  await reportLive?.('خواندن فایل‌های واقعی ریپو', 30);
  const currentContents = new Map<string, string | null>();
  for (const task of plan.tasks) {
    if (task.action === 'modify') {
      try {
        const content = await readRepoFile(task.path);
        currentContents.set(task.path, content);
      } catch (err) {
        // گیت‌هاب متصل نیست یا فایل نیست؛ مجری با instruction جلو می‌رود
        currentContents.set(task.path, null);
      }
    } else {
      currentContents.set(task.path, null);
    }
  }

  // ۳) مجری‌ها: تولید محتوای کامل هر فایل (موازی)
  await reportLive?.('مجری‌ها: نوشتن کد واقعی', 55);
  const patches = await Promise.all(
    plan.tasks.map(async (task) => {
      const current = currentContents.get(task.path);
      const workerPrompt =
        `مسیر فایل: ${task.path}\n` +
        `عمل: ${task.action === 'create' ? 'ساخت فایل تازه' : 'اصلاح فایل موجود'}\n` +
        `دستور سرپرست:\n${task.instruction}\n` +
        (current
          ? `\nمحتوای فعلی فایل (آن را کامل بازنویسی کن، نه تکه‌تکه):\n${current.slice(0, 30000)}\n`
          : `\nفایل موجود نیست یا خوانده نشد؛ محتوای کامل را از صفر بنویس.\n`) +
        '\nقواعد سفت:\n' +
        '- خروجی فقط JSON معتبر با همین ساختار باشد: {"path": "مسیر فایل", "content": "محتوای کامل و نهایی فایل"}.\n' +
        '- نه files_hint، نه خلاصه، نه توضیح بیرون از JSON؛ content باید کد کامل و قابل اجرای فایل باشد.\n' +
        '- حداکثر ۲۰ کیلوبایت برای هر فایل؛ فایل بزرگ‌تر حذف می‌شود، پس کد را جمع‌وجور و کامل بنویس.\n' +
        '- کد باید کامل و قابل اجرا باشد؛ تکه‌کد ناقص یا placeholder مثل // ... ممنوع.\n' +
        '- برای رابط فارسی: فقط logical CSS (ms- me- ps- pe- start- end-)، هرگز ml- pl- text-left.\n' +
        '- ایمپورت‌ها دقیق و نسبی باشند؛ هیچ‌چیز حدسی ایمپورت نکن.';
      const raw = await callLLM(workerPrompt, {
        system: WORKER_SYSTEM,
        temperature: 0.4,
      });
      return normalizePatch(raw, task.path);
    }),
  );

  const validPatches = patches.filter((p): p is WorkerPatch => p !== null);
  if (validPatches.length === 0) {
    const reason = 'هیچ مجری‌ای کد معتبر تولید نکرد؛ این چرخه پچی تولید نشد.';
    return {
      team: TEAM,
      summary: reason,
      blockers: [reason],
      tasks: [],
      approved: false,
      patches: [],
      patch: [],
    };
  }

  // ۴) منتقد: داوری واقعی کد، فایل‌به‌فایل
  const criticPrompt =
    validPatches
      .map(
        (p, i) =>
          `--- فایل ${i + 1}: ${p.path} ---\n${p.content.slice(0, 25000)}`,
      )
      .join('\n\n') +
    '\n\nهر فایل را داوری کن و فقط JSON معتبر بده:\n' +
    '{"approved": بولین (کل پچ), "reason": "یک جمله", "files": [{"path": "مسیر", "approved": بولین, "reason": "دلیل"}]}\n' +
    'معیارها: سینتکس معتبر؛ ایمپورت‌های درست؛ راست‌چین با logical CSS؛ بدون secret و .env؛ ' +
    'کد ناقص یا placeholder = رد. فقط ایراد واقعی؛ سلیقه‌ای نه.';
  await reportLive?.('منتقد: بازبینی خط‌به‌خط کد', 85);
  let verdict: CriticVerdict;
  try {
    verdict = await callLLMJson<CriticVerdict>(criticPrompt, {
      system: CRITIC_SYSTEM,
      temperature: 0.2,
    });
  } catch {
    verdict = { approved: false, reason: 'منتقد خروجی معتبر نداد.', files: [] };
  }

  // فقط فایل‌های تأییدشده در پچ نهایی می‌مانند
  const approvedByPath = new Map<string, boolean>();
  if (Array.isArray(verdict.files)) {
    for (const f of verdict.files) {
      if (f && typeof f.path === 'string') approvedByPath.set(f.path, f.approved === true);
    }
  }
  const criticApproved = validPatches.filter((p) => {
    // اگر منتقد برای فایلی نظر نداد، نظر کلی ملاک است
    if (approvedByPath.has(p.path)) return approvedByPath.get(p.path) === true;
    return verdict.approved === true;
  });

  // مرحلهٔ نهایی: تبدیل به PatchFileهای واقعی با سقف ۳ فایل / ۲۰KB
  const dropped: string[] = [];
  const finalPatch = finalizePatches(criticApproved, dropped);

  const approved = verdict.approved === true && finalPatch.length > 0;
  const reason = String(verdict.reason ?? '').trim() || 'منتقد دلیلی ثبت نکرد.';
  const droppedNote =
    dropped.length > 0 ? ` — حذف‌شده (سقف ۲۰KB): ${dropped.join('، ')}` : '';

  const summary = approved
    ? `تیم dev ${finalPatch.length} فایل واقعی تولید کرد و منتقد تأیید کرد: ${reason} — فایل‌ها: ${finalPatch.map((p) => p.path).join('، ')}`
    : `تیم dev این چرخه پچ تأییدشده نداشت؛ دلیل: ${reason}`;

  if (approved) {
    await writeMemory(TEAM, `learned:${runId}`, {
      content: summary.slice(0, 2000),
      approved,
      run_id: runId,
      files: finalPatch.map((p) => p.path),
    });
  }

  const tasks: QueuedTask[] = finalPatch.map((p) => ({
    title: `پچ: ${p.path}`,
    description: `فایل ${p.path} — ${plan.goal}`,
    files_hint: p.path,
    priority: 'high' as const,
  }));

  const knowledgeResult = await extractCriticKnowledge(
    TEAM,
    { approved, reason, domain: 'توسعه و کد' },
    runId,
  );
  const knowledgeLog = criticKnowledgeLog(knowledgeResult);

  return {
    team: TEAM,
    summary: `${summary}${droppedNote} ${knowledgeLog}`,
    blockers: approved ? [] : [reason],
    tasks,
    approved,
    patches: finalPatch.map((p) => ({ path: p.path, content: p.content })),
    patch: finalPatch,
  };
}
