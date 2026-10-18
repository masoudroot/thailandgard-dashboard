/**
 * lib/teams/dev.ts : تیم توسعه (dev) — کدنویس واقعی
 *
 * این تیم گزارش نمی‌نویسد؛ کد واقعی تولید می‌کند:
 * حلقه نقد ۳ دوره‌ای (lib/critic-loop.ts):
 *   دور ۱: سرپرست (تصمیم + انتخاب فایل‌ها) ← خواندن فایل‌های واقعی ریپو ←
 *          مجری‌ها (تولید محتوای کامل هر فایل) ← منتقد کد
 *   دور ۲: رد ← دستور دقیق منتقد ← مجری‌ها همان فایل‌ها را اصلاح می‌کنند
 *   دور ۳: فقط نظارت و نظر نهایی (حق رد ندارد) ← فیلتر فایل‌به‌فایل ← پچ نهایی
 *
 * خروجی: PatchFile[] در TeamResult.patch — یعنی [{path, content}]
 * اعمال پچ (کامیت روی شاخه) کار این تیم نیست؛ لایهٔ اعمال جداگانه انجامش می‌دهد.
 */

import { callLLM, callLLMJson } from '../llm';
import { writeMemory } from '../memory';
import { buildKnowledgePromptSection } from '../rag';
import {
  extractCriticKnowledge,
  criticKnowledgeLog,
  type CriticRoundRecord,
} from '../knowledge/critic-knowledge';
import { readRepoFile } from '../github';
import { SITE_REPO, BRIDGE_BASE_BRANCH } from '../bridge/commit';
import {
  runCriticLoop,
  combineReviewDirectives,
  parseCriticScore,
  retryInCycle,
  CRITIC_SCORE_PROMPT_LINE,
  type CriticLoopResult,
  type CriticVerdictV2,
} from '../critic-loop';
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
  /**
   * دستور مستقیم منتقد از حلقهٔ بیرونی ارکستراتور (همین چرخه)؛ بالاترین
   * اولویت را دارد و در ابتدای دستور مجری‌ها تزریق می‌شود.
   */
  reviewDirective?: string;
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

/**
 * نگهبان مسیر فایل (اعمال کدی، نه فقط پرامپت).
 * یافته‌های ممیزی: ممنوعیت نام placeholder و فایل test فقط در پرامپت بود و
 * مجری می‌توانست path را اورراید کند؛ فایل health-check.js در پروژهٔ TS دیده شد؛
 * هیچ اعتبارسنجی‌ای برای site/ یا فرار با .. نبود.
 * خروجی: null یعنی مسیر سالم؛ رشته یعنی دلیل رد.
 */
function pathRejectionReason(rawPath: string): string | null {
  const p = String(rawPath ?? '').trim().replace(/^\/+/, '');
  if (!p) return 'مسیر خالی است.';
  if (p.includes('..')) return 'مسیر شامل «..» است (فرار از ریپو ممنوع).';
  if (p.includes('\\')) return 'مسیر شامل بک‌اسلش است.';
  if (!p.startsWith('site/')) return 'مسیر باید زیر site/ باشد.';
  const lower = p.toLowerCase();
  // فایل‌های حساس و قفل پکیج — هرگز از طریق پچ
  const base = lower.split('/').pop() ?? '';
  if (!base || !base.includes('.')) return 'نام فایل نامعتبر است (باید فایل واقعی با پسوند باشد).';
  if (base.startsWith('.env')) return 'فایل .env ممنوع است.';
  if (
    base === 'package-lock.json' ||
    base === 'pnpm-lock.yaml' ||
    base === 'yarn.lock'
  ) {
    return 'فایل قفل پکیج ممنوع است.';
  }
  // ممنوعیت .js/.jsx در پروژهٔ TS (به‌جز کانفیگ‌های ریشهٔ site و فایل‌های استاتیک public)
  if (lower.endsWith('.js') || lower.endsWith('.jsx')) {
    const rel = lower.slice('site/'.length);
    const atRoot = !rel.includes('/');
    const isConfig =
      atRoot &&
      (/^[a-z0-9-]+\.config\.(js|jsx)$/.test(rel) ||
        /^instrumentation\.(js|jsx)$/.test(rel));
    const isPublicAsset = rel.startsWith('public/');
    if (!isConfig && !isPublicAsset)
      return 'فایل .js/.jsx در پروژهٔ TS ممنوع است (فقط کانفیگ ریشهٔ site یا فایل استاتیک public).';
  }
  // توکن‌های placeholder / test / debug / mock — هم در نام فایل، هم در سگمنت مسیر
  const segments = lower.split('/');
  const placeholderTokens = new Set([
    'someapi',
    'some-api',
    'test',
    'tests',
    '__tests__',
    'spec',
    'specs',
    '__specs__',
    'debug',
    'mock',
    'mocks',
    '__mocks__',
    '__snapshots__',
    'temp',
    'tmp',
    'example',
    'examples',
    'sample',
    'samples',
    'demo',
    'demos',
    'placeholder',
    'foo',
    'bar',
  ]);
  for (const seg of segments) {
    if (placeholderTokens.has(seg)) {
      return `سگمنت مسیر «${seg}» ممنوع است (test/spec/debug/mock/placeholder).`;
    }
  }
  const nameNoExt = base.replace(/\.[a-z0-9]+$/, '');
  const nameTokens = nameNoExt.split(/[^a-z0-9]+/).filter(Boolean);
  if (nameTokens.some((t) => placeholderTokens.has(t))) {
    return `نام فایل «${base}» شامل توکن ممنوعه است (test/spec/debug/mock/placeholder).`;
  }
  if (nameNoExt.includes('someapi') || nameNoExt.includes('some-api')) {
    return `نام فایل «${base}» placeholder است.`;
  }
  return null;
}

/**
 * نگهبان کامل‌بودن کد (اعمال کدی، نه فقط پرامپت).
 * قبلاً فقط «حداقل ۲۰ نویسه» چک می‌شد؛ اسکلت ناقص هم رد می‌شد.
 * خروجی: null یعنی محتوا قابل‌قبول؛ رشته یعنی دلیل رد.
 */
function contentRejectionReason(content: string, path: string): string | null {
  const t = String(content ?? '').trim();
  if (t.length < 20) return 'محتوا خالی یا کوتاه‌تر از ۲۰ نویسه است.';
  if (/\b(TODO|FIXME|XXX|HACK)\b/i.test(t)) {
    return 'محتوا شامل TODO/FIXME است (کد ناقص).';
  }
  // خط placeholder از جنس «...» تنها در یک خط
  if (/^\s*(\/\/\s*|\/\*\s*|\{\/\*\s*)?\.\.\.(\s*\*\/|\s*\*\/\})?\s*$/m.test(t)) {
    return 'محتوا شامل placeholder «...» است (کد ناقص).';
  }
  // فایل ماژول TS/JS باید چیزی export کند؛ وگرنه یا خالی است یا اسکلت
  const lower = String(path ?? '').toLowerCase();
  if (/\.(tsx?|mjs|cjs)$/.test(lower) && !/\bexport\b/.test(t)) {
    return 'فایل ماژول بدون هیچ export است (اسکلت/ناقص).';
  }
  return null;
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
  /** امتیاز کیفی منتقد (۰ تا ۱۰۰)؛ تعیین‌کننده نهایی: تأیید فقط با ≥ ۸۰. */
  score?: number;
  reason: string;
  files: FileVerdict[];
}

/** خروجی یک دور از مجری‌های حلقه نقد: پلن سرپرست + پچ‌های تولیدشده */
interface WorkerRoundOutput {
  plan: SupervisorPlan;
  patches: WorkerPatch[];
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
        // نگهبان کدی مسیر (انتخاب سرپرست): مسیر نامعتبر = تسک حذف می‌شود
        .filter((t) => pathRejectionReason(t.path) === null)
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
    const chosenPath =
      String(parsed.path ?? expectedPath).trim().replace(/^\/+/, '') ||
      expectedPath;
    // نگهبان کدی مسیر (اورراید مجری): مسیر نامعتبر = پچ رد می‌شود.
    // عمداً به expectedPath برنمی‌گردیم؛ محتوای نوشته‌شده برای مسیر نامعتبر
    // (مثلاً کد تست) نباید زیر نام دیگری تحویل داده شود.
    if (pathRejectionReason(chosenPath) !== null) return null;
    // نگهبان کدی کامل‌بودن کد: اسکلت، TODO و placeholder رد می‌شود
    if (contentRejectionReason(content, chosenPath) !== null) return null;
    return { path: chosenPath, content };
  } catch {
    return null;
  }
}

/**
 * مرحلهٔ نهایی بعد از منتقد: تبدیل خروجی تأییدشده به PatchFileهای واقعی.
 * دروازهٔ دفاع-در-عمق: هر فایل یک بار دیگر از نگهبان مسیر و نگهبان کامل‌بودن
 * کد رد می‌شود (اگر سرپرست یا مجری از فیلترهای قبلی رد شده باشند).
 * سقف‌ها: حداکثر ۳ فایل، هر فایل حداکثر ۲۰ کیلوبایت.
 * فایل ردشده/بزرگ‌تر از سقف حذف می‌شود (کد برش‌خورده بدتر از نبودنش است) و در
 * آرایهٔ dropped گزارش می‌شود؛ droppedPaths مسیرهای خالص حذف‌شده است برای
 * راستی‌آزمایی تحویل.
 */
function finalizePatches(
  approved: WorkerPatch[],
  dropped: string[],
): { files: PatchFile[]; droppedPaths: string[] } {
  const out: PatchFile[] = [];
  const droppedPaths: string[] = [];
  for (const p of approved.slice(0, MAX_PATCH_FILES)) {
    const gateReason =
      pathRejectionReason(p.path) ?? contentRejectionReason(p.content, p.path);
    if (gateReason !== null) {
      dropped.push(`${p.path} (رد نگهبان: ${gateReason})`);
      droppedPaths.push(p.path);
      continue;
    }
    const size = utf8Bytes(p.content);
    if (size > MAX_PATCH_BYTES) {
      dropped.push(`${p.path} (${Math.round(size / 1024)}KB، سقف ۲۰KB)`);
      droppedPaths.push(p.path);
      continue;
    }
    out.push({ path: p.path, content: p.content });
  }
  return { files: out, droppedPaths };
}

/**
 * راستی‌آزمایی تحویل پچ (یافته: رد چک رهبر «فایل واقعی تولید شد ولی پچ تحویل داده نشد»).
 * هر فایل تأییدشدهٔ منتقد باید یا در پچ نهایی باشد یا با دلیل روشن در dropped ثبت
 * شده باشد؛ هیچ فایلی نباید بی‌صدا گم شود. اگر فایلی گم شد، تیم تأیید نمی‌گیرد.
 */
function verifyPatchDelivery(
  criticApproved: WorkerPatch[],
  finalPatch: PatchFile[],
  droppedPaths: string[],
): { ok: boolean; missing: string[] } {
  const delivered = new Set(finalPatch.map((p) => p.path));
  const droppedSet = new Set(droppedPaths.map((d) => d.trim()));
  const missing = criticApproved
    .map((p) => p.path)
    .filter((p) => !delivered.has(p) && !droppedSet.has(p));
  return { ok: missing.length === 0, missing };
}

/**
 * تبدیل دلیل ردِ منتقد قدیمی به دستور اجرایی (CriticVerdictV2.instruction).
 * امری و بلندتر از ۵۰ نویسه تا از اعتبارسنجی حلقه رد شود.
 */
function criticInstructionFromReason(reason: string, files: FileVerdict[]): string {
  const r = reason.trim() || 'کد ایراد دارد';
  const fileNotes = files
    .filter((f) => !f.approved)
    .map((f) => `فایل ${f.path}: ${String(f.reason || '').trim() || 'ایراد دارد'}`)
    .join('؛ ');
  return [
    `کد را بر اساس این نقد اصلاح کن: «${r}»`,
    ...(fileNotes ? [`ایرادهای فایل‌به‌فایل را برطرف کن: ${fileNotes}.`] : []),
    'هر فایل را کامل و قابل اجرا بازنویسی کن؛ سینتکس را درست کن؛ ایمپورت‌ها را دقیق و نسبی بنویس؛',
    'placeholder و کد ناقص را حذف کن؛ برای رابط فارسی فقط logical CSS استفاده کن؛',
    'در پایان مطمئن شو هیچ secret و ارجاعی به .env در کد نیست.',
  ].join(' ');
}

/**
 * تبدیل دلیل رد به معیار قبولی (CriticVerdictV2.acceptance).
 */
function criticAcceptanceFromReason(reason: string, files: FileVerdict[]): string {
  const r = reason.trim() || 'کد ایراد دارد';
  const fileNotes = files
    .filter((f) => !f.approved)
    .map((f) => f.path)
    .join('، ');
  return `وقتی درست است که نقد «${r}» دیگر دربارهٔ کد صدق نکند${fileNotes ? ` (به‌ویژه فایل‌های: ${fileNotes})` : ''} و هر فایل سینتکس معتبر، ایمپورت‌های درست، logical CSS و بدون secret داشته باشد.`;
}

/**
 * یک چرخهٔ کامل تیم dev را اجرا می‌کند و TeamResult با patch واقعی برمی‌گرداند.
 * (مهاجرت به حلقه نقد ۳ دوره‌ای lib/critic-loop.ts)
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

  // ---------- توابع حلقه نقد ----------

  // کش دور ۱: پلن سرپرست و محتوای فعلی فایل‌ها در هر چرخه یک بار ساخته می‌شوند؛
  // دورهای ۲ و ۳ همان فایل‌ها را با دستور منتقد اصلاح می‌کنند.
  let cachedPlan: SupervisorPlan | null = null;
  const cachedContents = new Map<string, string | null>();
  // جزئیات فایل‌به‌فایل آخرین داوری منتقد (برای فیلتر نهایی و دستور دور بعد)
  let lastFileVerdicts: FileVerdict[] = [];
  // حکم خام آخرین داوری (پیش از اجبار دور ۳) برای منطق تأیید نهایی
  let lastRawApproved: boolean = false;
  let lastRawReason = '';

  /**
   * تولید محتوای کامل هر فایل با مجری‌ها (موازی) — منطق فعلی، بدون تغییر.
   * در دور ۲/۳ دستور منتقد (prevInstruction) به پرامپت هر مجری تزریق می‌شود.
   */
  const generatePatches = async (
    plan: SupervisorPlan,
    prevInstruction?: string,
  ): Promise<WorkerPatch[]> => {
    // ضربان زنده پیش از شروع مجری‌های موازی (یافته: هنگ ۱۰ دقیقه‌ای بدون پیشرفت)
    await reportLive?.(`مجری‌ها: نوشتن ${plan.tasks.length} فایل`, 55);
    const patches = await Promise.all(
      plan.tasks.map(async (task) => {
        const current = cachedContents.get(task.path);
        const workerPrompt =
          `مسیر فایل: ${task.path}\n` +
          `عمل: ${task.action === 'create' ? 'ساخت فایل تازه' : 'اصلاح فایل موجود'}\n` +
          `دستور سرپرست:\n${task.instruction}\n` +
          (prevInstruction ? `\nدستور منتقد برای اصلاح این دور (حتماً رعایت کن):\n${prevInstruction}\n` : '') +
          (current
            ? `\nمحتوای فعلی فایل (آن را کامل بازنویسی کن، نه تکه‌تکه):\n${current.slice(0, 30000)}\n`
            : `\nفایل موجود نیست یا خوانده نشد؛ محتوای کامل را از صفر بنویس.\n`) +
          '\nقواعد سفت:\n' +
          '- خروجی فقط JSON معتبر با همین ساختار باشد: {"path": "مسیر فایل", "content": "محتوای کامل و نهایی فایل"}.\n' +
          '- نه files_hint، نه خلاصه، نه توضیح بیرون از JSON؛ content باید کد کامل و قابل اجرای فایل باشد.\n' +
          '- حداکثر ۲۰ کیلوبایت برای هر فایل؛ فایل بزرگ‌تر حذف می‌شود، پس کد را جمع‌وجور و کامل بنویس.\n' +
          '- کد باید کامل و قابل اجرا باشد؛ تکه‌کد ناقص یا placeholder مثل // ... ممنوع.\n' +
          '- فایل‌های test، spec، debug یا mock هرگز تولید نکن. فقط کد پروداکشن واقعی.\n' +
          '- مسیر (path) حتماً با site/ شروع شود، بدون .. ؛ فایل .js/.jsx ممنوع است (پروژه TS است)؛ ' +
          'محتوا باید بدون TODO/FIXME و بدون خط «...» و با حداقل یک export باشد، وگرنه پچ خودکار رد می‌شود.\n' +
          '- نام فایل (path) باید معنادار و مرتبط با کار باشد؛ نام‌های placeholder مثل someApi، some-api، test، temp، example، sample، demo ممنوع است؛ ' +
          'اگر path داده‌شده placeholder است، آن را با نام معنادار اصلاح کن.\n' +
          '- برای رابط فارسی: فقط logical CSS (ms- me- ps- pe- start- end-)، هرگز ml- pl- text-left.\n' +
          '- ایمپورت‌ها دقیق و نسبی باشند؛ هیچ‌چیز حدسی ایمپورت نکن. قبل از ایمپورت، مطمئن شو آن ماژول/کامپوننت واقعاً وجود دارد.\n' +
          '- اگر محتوای فعلی فایل داده شد (اصلاح فایل موجود): ساختار، قابلیت‌ها و استایل موجود را حفظ کن و فقط همان را عوض کن که دستور گفته؛ بازنویسی کوری که بخش‌های دیگر فایل را حذف یا خراب کند ممنوع.\n' +
          '- روت‌های API (POST/PUT/PATCH): حتماً request.json() را در try/catch بگذار؛ ورودی را اعتبارسنجی کن (فیلدهای لازم، نوع داده)؛ خطاها را با status مناسب برگردان (۴۰۰ برای ورودی نامعتبر، ۵۰۰ برای خطای سرور).\n' +
          '- هیچ‌وقت await بدون try/catch برای عملیات نامطمئن (fetch، دیتابیس، فایل) ننویس.\n' +
          '- ساختار کد تمیز: هر تابع یک کار؛ نام‌های معنادار؛ بدون کد مرده یا کامنتِ به‌جای کد.';
        const raw = await callLLM(workerPrompt, {
          system: WORKER_SYSTEM,
          temperature: 0.4,
        });
        return normalizePatch(raw, task.path);
      }),
    );
    return patches.filter((p): p is WorkerPatch => p !== null);
  };

  /**
   * runWorkers: سرپرست (دور ۱) + خواندن فایل‌ها (دور ۱) + مجری‌ها (هر دور).
   */
  const runWorkers = async (
    round: number,
    prevInstruction?: string,
  ): Promise<WorkerRoundOutput> => {
    if (round === 1) {
      // ۱) سرپرست: هدف این چرخه + انتخاب حداکثر ۳ فایل (منطق فعلی، بدون تغییر)
      const supervisorPrompt =
        knowledgePrefix +
        `نقشهٔ ریپو:\n${REPO_MAP}\n\n` +
        `زمینهٔ طراحی:\n${designSummary}\n\n` +
        `باگ‌ها و نیازهای qa:\n${qaSummary}\n\n` +
        'بر اساس زمینه، تصمیم بگیر این چرخه دقیقاً چه کدی باید نوشته یا اصلاح شود. ' +
        'فقط JSON معتبر بده با این ساختار:\n' +
        '{"goal": "هدف یک‌خطی", "tasks": [{"path": "مسیر نسبی فایل", "action": "create یا modify", "instruction": "دستور دقیق فنی به مجری"}]}\n' +
        'قواعد: حداکثر ۳ فایل؛ مسیرها نسبی و دقیق و حتماً با site/ شروع شوند (بدون .. و بدون بک‌اسلش)؛ هرگز فایل .env یا package-lock را انتخاب نکن؛ ' +
        'نام فایل باید معنادار و مرتبط با کار باشد؛ نام‌های placeholder مثل someApi، some-api، test، temp، example، sample، demo ممنوع است؛ ' +
        'اگر اسم دقیق نمی‌دانی، از روی هدف تسک الهام بگیر؛ ' +
        'instruction باید آن‌قدر دقیق باشد که مجری بدون سؤال کد را بنویسد.';
      await reportLive?.('سرپرست: انتخاب فایل‌ها و هدف', 15);
      // تلاش مجدد در همین چرخه اگر سرپرست JSON معتبر برنگرداند (یافته: ۱۱ رد
      // در ۲۴ ساعت با خطای «سرپرست پلن معتبر برنگرداند»). دستور مسعود: هیچ‌کاری
      // به چرخهٔ بعد موکول نمی‌شود.
      const plan = await retryInCycle(
        async () => {
          const supervisorRaw = await callLLM(supervisorPrompt, {
            system: SUPERVISOR_SYSTEM,
            temperature: 0.3,
          });
          return normalizePlan(supervisorRaw);
        },
        (p): p is SupervisorPlan => p !== null,
        {
          maxAttempts: 3,
          label: 'پلن سرپرست',
          onProgress: (msg) => reportLive?.(msg, 15),
        },
      );
      if (!plan) {
        throw new Error('سرپرست پس از ۳ تلاش پلن معتبر برنگرداند؛ این چرخه پچی تولید نشد.');
      }
      cachedPlan = plan;

      // ۲) خواندن محتوای فعلی فایل‌ها از ریپوی سایت (شاخهٔ dev — همان مبنای پل)
      // یافتهٔ ممیزی یکپارچگی: قبلاً از ریپوی کانفیگ (داشبورد) و ref=master خوانده می‌شد،
      // یعنی عملاً همیشه ۴۰۴ و null بود و مجری «از صفر» بازنویسی می‌کرد.
      await reportLive?.('خواندن فایل‌های واقعی ریپو', 30);
      for (let i = 0; i < plan.tasks.length; i++) {
        const task = plan.tasks[i];
        await reportLive?.(`خواندن فایل ${i + 1} از ${plan.tasks.length}: ${task.path}`, 30);
        if (task.action === 'modify') {
          try {
            const content = await readRepoFile(task.path, {
              repo: SITE_REPO,
              ref: BRIDGE_BASE_BRANCH,
            });
            cachedContents.set(task.path, content);
          } catch {
            // گیت‌هاب متصل نیست یا فایل نیست؛ مجری با instruction جلو می‌رود
            cachedContents.set(task.path, null);
          }
        } else {
          cachedContents.set(task.path, null);
        }
      }
    } else {
      await reportLive?.(`دور ${round}: اصلاح با دستور منتقد`, 45);
    }

    const plan = cachedPlan;
    if (!plan) {
      throw new Error('پلن سرپرست در کش پیدا نشد.');
    }

    // ۳) مجری‌ها: تولید محتوای کامل هر فایل
    await reportLive?.('مجری‌ها: نوشتن کد واقعی', 55);
    const validPatches = await generatePatches(
      plan,
      combineReviewDirectives(input.reviewDirective, prevInstruction),
    );
    if (validPatches.length === 0) {
      throw new Error('هیچ مجری‌ای کد معتبر تولید نکرد؛ این چرخه پچی تولید نشد.');
    }
    return { plan, patches: validPatches };
  };

  /**
   * runCritic: منتقد کد فعلی (فایل‌به‌فایل)، با تبدیل خروجی به CriticVerdictV2.
   * دور ۳: حق رد ندارد؛ فقط نظر نهایی.
   */
  const runCritic = async (
    output: WorkerRoundOutput,
    round: number,
  ): Promise<CriticVerdictV2> => {
    const criticPrompt =
      output.patches
        .map(
          (p, i) =>
            `--- فایل ${i + 1}: ${p.path} ---\n${p.content.slice(0, 25000)}`,
        )
        .join('\n\n') +
      '\n\nهر فایل را داوری کن و فقط JSON معتبر بده:\n' +
      '{"approved": بولین (کل پچ), "score": عدد ۰ تا ۱۰۰, "reason": "یک جمله", "files": [{"path": "مسیر", "approved": بولین, "reason": "دلیل"}]}\n' +
      CRITIC_SCORE_PROMPT_LINE + '\n' +
      'معیارها: سینتکس معتبر؛ ایمپورت‌های درست؛ راست‌چین با logical CSS؛ بدون secret و .env؛ ' +
      'کد ناقص یا placeholder = رد. فقط کد کامل و آماده تحویل را تأیید کن. فقط ایراد واقعی؛ سلیقه‌ای نه. ' +
      'تطابق تحویل با قرارداد تسک (یافتهٔ ممیزی C1): خروجی باید دقیقاً همان چیزی باشد که تسک خواسته؛ اگر تسک پچ خواسته، خروجی باید پچ باشد نه فقط فایل تازه؛ مسیرها و تعداد فایل‌های خواسته‌شده باید بخورند. تحویلِ خارج از قرارداد = رد قطعی. خروجی خالی یا بدون محتوا = رد قطعی. ' +
      'قانون تأیید: approved=true فقط وقتی مجاز است که در reason این چک‌لیست را یک‌خطی تأیید کنی: «تحویل مطابق قرارداد تسک | خروجی خالی نیست | سینتکس/ایمپورت/راست‌چین سالم».';
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

    // جزئیات فایل‌به‌فایل را برای فیلتر نهایی و دستور دور بعد نگه می‌داریم
    lastFileVerdicts = Array.isArray(verdict.files)
      ? verdict.files.filter((f) => f && typeof f.path === 'string')
      : [];
    lastRawApproved = verdict.approved === true;
    lastRawReason = String(verdict.reason ?? '').trim() || 'منتقد دلیلی ثبت نکرد.';
    const score = parseCriticScore(verdict.score) ?? undefined;
    const reason = lastRawReason;

    if (round === 3) {
      return {
        approved: true,
        score,
        reason: '',
        instruction: '',
        acceptance: '',
        finalOpinion: reason,
      };
    }
    if (verdict.approved) {
      return {
        approved: true,
        score,
        reason: '',
        instruction: '',
        acceptance: '',
        finalOpinion: reason || undefined,
      };
    }
    return {
      approved: false,
      score,
      reason,
      instruction: criticInstructionFromReason(reason, lastFileVerdicts),
      acceptance: criticAcceptanceFromReason(reason, lastFileVerdicts),
    };
  };

  // تاریخچه دورها برای ثبت دانش + آخرین لاگ دانش برای خلاصه
  const roundHistory: CriticRoundRecord[] = [];
  let lastKnowledgeLog = '';

  /**
   * onRoundKnowledge: ثبت دانش هر دور با extractCriticKnowledge فعلی.
   */
  const onRoundKnowledge = async (
    round: number,
    verdict: CriticVerdictV2,
  ): Promise<void> => {
    const record: CriticRoundRecord = {
      round,
      approved: verdict.approved,
      reason: verdict.approved
        ? verdict.finalOpinion || 'تأیید شد.'
        : verdict.reason,
      instruction: verdict.instruction?.trim() || undefined,
    };
    // ضربان زنده پیش از کار دیتابیس+RAG (یافته: نقطهٔ کور بدون ضربان)
    await reportLive?.(`منتقد: ثبت دانش دور ${round}`, 88);
    const knowledgeResult = await extractCriticKnowledge(
      TEAM,
      {
        approved: verdict.approved,
        reason: record.reason,
        domain: 'توسعه و کد',
        instruction: record.instruction,
        round,
        rounds: roundHistory.slice(),
        isFinal: round === 3,
      },
      runId,
    );
    roundHistory.push(record);
    lastKnowledgeLog = criticKnowledgeLog(knowledgeResult);
  };

  // ---------- اجرای حلقه نقد ۳ دوره‌ای ----------
  let loopResult: CriticLoopResult<WorkerRoundOutput>;
  try {
    loopResult = await runCriticLoop<WorkerRoundOutput>({
      team: TEAM,
      runId,
      runWorkers,
      runCritic,
      onRoundKnowledge,
      onProgress: (msg) => reportLive?.(msg, 70),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      team: TEAM,
      summary: msg,
      blockers: [msg],
      tasks: [],
      approved: false,
      patches: [],
      patch: [],
    };
  }

  // فقط فایل‌های تأییدشده در پچ نهایی می‌مانند (منطق فعلی)
  const approvedByPath = new Map<string, boolean>();
  for (const f of lastFileVerdicts) {
    approvedByPath.set(f.path, f.approved === true);
  }
  const criticApproved = loopResult.output.patches.filter((p) => {
    // اگر منتقد برای فایلی نظر نداد، نظر کلی ملاک است
    if (approvedByPath.has(p.path)) return approvedByPath.get(p.path) === true;
    return lastRawApproved;
  });

  // مرحلهٔ نهایی: تبدیل به PatchFileهای واقعی با سقف ۳ فایل / ۲۰KB + نگهبان مسیر و کامل‌بودن کد
  const dropped: string[] = [];
  const { files: finalPatch, droppedPaths } = finalizePatches(criticApproved, dropped);

  // راستی‌آزمایی تحویل: هیچ فایل تأییدشده‌ای نباید بی‌صدا گم شود
  const deliveryCheck = verifyPatchDelivery(criticApproved, finalPatch, droppedPaths);
  const approved = lastRawApproved && finalPatch.length > 0 && deliveryCheck.ok;
  const reason = lastRawReason;
  const droppedNote =
    dropped.length > 0 ? ` — حذف‌شده: ${dropped.join('، ')}` : '';
  const deliveryNote = !deliveryCheck.ok
    ? ` — تحویل ناقص: این فایل‌ها در پچ نهایی نیستند: ${deliveryCheck.missing.join('، ')}`
    : '';

  const summary = approved
    ? `تیم dev ${finalPatch.length} فایل واقعی تولید کرد و منتقد تأیید کرد: ${reason} — فایل‌ها: ${finalPatch.map((p) => p.path).join('، ')}`
    : `تیم dev این چرخه پچ تأییدشده نداشت؛ دلیل: ${!deliveryCheck.ok ? `تحویل پچ ناقص (${deliveryCheck.missing.join('، ')})` : reason}`;

  const failBlockers: string[] = [];
  if (!approved) {
    failBlockers.push(
      !deliveryCheck.ok
        ? `تحویل پچ ناقص است؛ این فایل‌ها در پچ نهایی نیستند: ${deliveryCheck.missing.join('، ')}`
        : reason,
    );
  }

  if (approved) {
    // ضربان زنده پیش از نوشتن حافظه (یافته: نقطهٔ کور بدون ضربان)
    await reportLive?.('ثبت آموخته‌ها در حافظه', 95);
    await writeMemory(TEAM, `learned:${runId}`, {
      content: summary.slice(0, 2000),
      approved,
      run_id: runId,
      files: finalPatch.map((p) => p.path),
      finalRound: loopResult.finalRound,
      rounds: loopResult.verdicts.map((v, i) => ({
        round: i + 1,
        approved: v.approved,
        reason: v.reason || v.finalOpinion || '',
      })),
    });
  }

  const tasks: QueuedTask[] = finalPatch.map((p) => ({
    title: `پچ: ${p.path}`,
    description: `فایل ${p.path} — ${loopResult.output.plan.goal}`,
    files_hint: p.path,
    priority: 'high' as const,
  }));
  const hadRejection = loopResult.verdicts.some((v) => !v.approved);
  if (hadRejection) {
    tasks.push({
      title: 'بازبینی پچ dev',
      description: `منتقد در دورهای اول کد را رد کرد و حلقه در دور ${loopResult.finalRound} با نظر نهایی تمام شد: ${loopResult.finalOpinion}. پچ ساخته شد ولی نیاز به بازبینی دارد.`,
      files_hint: finalPatch.map((p) => p.path).join('، ') || '(بدون فایل)',
      priority: 'high' as const,
    });
  }

  return {
    team: TEAM,
    summary: `${summary}${droppedNote}${deliveryNote} ${lastKnowledgeLog}`,
    blockers: failBlockers,
    tasks,
    approved,
    patches: finalPatch.map((p) => ({ path: p.path, content: p.content })),
    patch: finalPatch,
  };
}
