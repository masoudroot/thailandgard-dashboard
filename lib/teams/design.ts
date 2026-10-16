/**
 * lib/teams/design.ts : تیم طراحی (design) تایلندگرد
 *
 * این تیم دیگر «توضیح دربارهٔ طراحی» نمی‌دهد؛ کامپوننت واقعی React/TSX تولید
 * می‌کند که مستقیم روی ریپوی سایت قابل اعمال است.
 *
 * حلقه نقد ۳ دوره‌ای (lib/critic-loop.ts):
 *   دور ۱: سرپرست (انتخاب دقیقاً یک کامپوننت) ← مجری (تولید کد)
 *   دور ۲: رد ← دستور دقیق منتقد ← مجری کد را اصلاح می‌کند
 *   دور ۳: فقط نظارت و نظر نهایی (حق رد ندارد)
 * خروجی نهایی: PatchFile[] با مسیر site/components/... که تیم dev یا مرحلهٔ
 * اعمال، آن را با applyPatchViaGithub روی شاخهٔ dev ریپوی سایت کامیت می‌کند.
 *
 * قوانین سفت (دستور مسعود):
 * - فقط آیتم‌های رجیستری وایب‌فارسی؛ استایل من‌درآوردی ممنوع.
 * - راست‌چین با خاصیت‌های منطقی (ms/me/ps/pe/text-start/...)؛ هرگز ml/mr/pl/pr/text-left.
 * - تیتر با Pinar FD، بدنه با IranSans X، ارقام فارسی در متن نمایشی.
 * - U+2014 مطلقاً ممنوع.
 * - تم Graphite: خط مویی ۱px، بدون سایه، گوشهٔ ۸/۲۲، حرکت ۲۰۰ms.
 */

import { callLLM, callLLMJson } from '../llm';
import { buildKnowledgePromptSection } from '../rag';
import {
  extractCriticKnowledge,
  criticKnowledgeLog,
  type CriticRoundRecord,
} from '../knowledge/critic-knowledge';
import {
  runCriticLoop,
  type CriticLoopResult,
  type CriticVerdictV2,
} from '../critic-loop';
import type {
  ProgressReporter,
  MemoryEntry,
  QueuedTask,
  TeamName,
  TeamResult,
  PatchFile,
} from '../types';

export const TEAM: TeamName = 'design';

export const MISSION =
  'از بریف artdir کامپوننت واقعی React/TSX می‌سازد؛ هر چرخه دقیقاً یک کامپوننت قابل‌مشاهده با الگوهای رجیستری وایب‌فارسی، راست‌چین درست و تایپوگرافی فارسی، آمادهٔ کامیت روی شاخهٔ dev.';

export interface TeamInput {
  /** گزارش زنده‌ی پیشرفت به ارکستر؛ ارکستر همیشه آن را می‌دهد. */
  reportProgress?: ProgressReporter;
  cycleId: string;
  runId: string;
  ragContext: string;
  memory: MemoryEntry[];
  previousWavesOutput: Record<string, TeamResult | null>;
}

/** تصمیم سرپرست: دقیقاً یک کامپوننت برای این چرخه. */
interface SupervisorPlan {
  component: {
    /** نام فارسی کامپوننت، مثل «کارت تور». */
    name: string;
    /** مسیر فایل در ریپوی سایت، مثل site/components/tours/tour-card.tsx */
    filePath: string;
    /** نام تابع exportشده، مثل TourCard */
    exportName: string;
    /** یک جمله: این کامپوننت کجای سایت می‌نشیند و چه کاری می‌کند. */
    purpose: string;
    /** slug آیتم‌های رجیستری وایب‌فارسی که الگو هستند، مثل ["card", "badge"]. */
    registryRefs: string[];
    /** پراپ‌های ورودی کامپوننت به زبان ساده. */
    props: string;
  };
}

/** کامپوننت نرمال‌شده؛ اگر خروجی سرپرست ناقص بود null. */
type SafeComponent = SupervisorPlan['component'];

/** اعتبارسنجی خروجی سرپرست: فیلد ناقص یعنی پرامپت مجری خراب و خروجی خالی. */
function safeComponent(plan: unknown): SafeComponent | null {
  const c =
    plan && typeof plan === 'object'
      ? (plan as { component?: unknown }).component
      : undefined;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const o = c as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const name = str(o.name);
  const filePath = str(o.filePath);
  const exportName = str(o.exportName);
  if (!name || !filePath || !exportName) return null;
  const registryRefs = Array.isArray(o.registryRefs)
    ? o.registryRefs.map((r) => (typeof r === 'string' ? r.trim() : '')).filter(Boolean)
    : [];
  return {
    name,
    filePath,
    exportName,
    purpose: str(o.purpose),
    registryRefs,
    props: str(o.props),
  };
}

/** خروجی مجری: فایل‌های واقعی. */
interface WorkerOutput {
  files: PatchFile[];
}

/** خروجی یک دور از مجری حلقه نقد: کامپوننت انتخاب‌شده + فایل‌های تولیدشده */
interface WorkerRoundOutput {
  component: SafeComponent;
  files: PatchFile[];
}

/** حکم منتقد روی کد واقعی. */
interface CriticVerdict {
  approved: boolean;
  reason: string;
  /** کد نهایی تأییدشده یا اصلاح‌شده؛ در صورت رد می‌تواند تهی باشد. */
  files: PatchFile[];
}

/** قوانین سفت تولید کد که به مجری و منتقد داده می‌شود. */
const CODE_RULES = [
  '۱. راست‌چین فقط با خاصیت‌های منطقی: ms-، me-، ps-، pe-، text-start، text-end، start-0، end-0، rounded-s-، rounded-e-، border-s، border-e.',
  '۲. ممنوع مطلق: ml-، mr-، pl-، pr-، text-left، text-right، left-0، right-0، rounded-l-، rounded-r-، space-x- (به‌جایش gap).',
  '۳. تیتر با فونت Pinar FD و بدنه با IranSans X (کلاس‌های font-pinar و font-iransans اگر در تم تعریف شده‌اند؛ وگرنه font-bold برای تیتر).',
  '۴. هر عددی که کاربر می‌بیند باید فارسی باشد (۱۲٬۵۰۰٬۰۰۰ تومان، نه 12500000).',
  '۵. کاراکتر U+2014 (خط تیرهٔ بلند) مطلقاً ممنوع؛ به‌جایش «:» یا «،» یا «ـ».',
  '۶. تم Graphite: حاشیهٔ مویی ۱px با border، بدون سایه (shadow-* ممنوع)، گوشه‌های rounded-lg یا rounded-[22px]، حرکت transition با duration-200.',
  '۷. فقط توکن‌های تم: bg-background، text-foreground، text-muted-foreground، border، bg-muted و لهجهٔ کهربایی برای تأکید کوچک. رنگ hex من‌درآوردی (text-[#...] و bg-[#...]) ممنوع.',
  '۸. آیکون فقط از lucide-react؛ در راست‌چین، آیکون «بعدی/جلو» ArrowLeft است نه ArrowRight.',
  '۹. کامپوننت باید export تابع نام‌دار با interface پراپ‌ها باشد؛ بدون ' + "'use client'" + ' مگر تعامل واقعی (useState/useEffect) لازم باشد.',
  '۱۰. TSX معتبر: تگ‌های متوازن، ایمپورت‌های استفاده‌شده، تایپ TypeScript درست. بدون کد نمایشی یا TODO.',
].join('\n');

/** سرپرست: از بریف artdir و خروجی branding دقیقاً یک کامپوننت انتخاب می‌کند. */
async function makeSupervisorPlan(input: TeamInput): Promise<SupervisorPlan> {
  let knowledgeSection = '';
  try {
    knowledgeSection = await buildKnowledgePromptSection(TEAM, MISSION);
  } catch {
    knowledgeSection = '';
  }
  const memoryLines = input.memory.map((m) => `- ${m.key}: ${m.value}`).join('\n');
  const artdirResult = input.previousWavesOutput['artdir'];
  const brandingResult = input.previousWavesOutput['branding'];
  const artdirBrief = artdirResult?.summary ?? '(بریف artdir نیست)';
  const brandingOutput = brandingResult?.summary ?? '(خروجی branding نیست)';
  const prompt = [
    'زمینه:',
    ...(knowledgeSection ? [knowledgeSection, ''] : []),
    input.ragContext || '(زمینه‌ای نیست)',
    '',
    'بریف آرت‌دایرکشن (خروجی تیم artdir):',
    artdirBrief,
    '',
    'خروجی تیم branding:',
    brandingOutput,
    '',
    memoryLines ? `یادگیری‌های قبلی:\n${memoryLines}` : '',
    '',
    `مأموریت تیم design: ${MISSION}`,
    '',
    'دقیقاً یک کامپوننت انتخاب کن که این چرخه ساخته شود: کوچک، مشخص و قابل‌مشاهده روی سایت (مثل کارت تور، بنر، بخش نظرات، دکمهٔ تماس). از تکرار کامپوننت‌های یادگیری‌های قبلی پرهیز کن.',
    'فقط JSON معتبر بده با کلید component شامل: name (فارسی)، filePath (با الگوی site/components/<area>/<kebab-name>.tsx)، exportName (PascalCase)، purpose (یک جمله)، registryRefs (آرایهٔ slug آیتم‌های رجیستری وایب‌فارسی)، props (توصیف پراپ‌ها).',
  ]
    .filter((l) => l !== null)
    .join('\n');
  return callLLMJson<SupervisorPlan>(prompt, {
    system: 'تو سرپرست تیم design تایلندگرد هستی. فقط JSON معتبر می‌دهی؛ بدون حدس.',
    temperature: 0.3,
  });
}

/** آیا خروجی مجری حداقل یک فایل با محتوای واقعی دارد؟ */
function hasRealFiles(out: unknown): out is WorkerOutput {
  if (!out || typeof out !== 'object' || Array.isArray(out)) return false;
  const files = (out as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0) return false;
  return files.some(
    (f) =>
      f && typeof f === 'object' &&
      typeof (f as { content?: unknown }).content === 'string' &&
      ((f as { content: string }).content.trim().length >= 50),
  );
}

/** مجری: کامپوننت واقعی TSX تولید می‌کند. */
async function executeWorker(c: SafeComponent, prevInstruction?: string): Promise<WorkerOutput> {
  const system =
    'تو مجری تیم design تایلندگرد هستی؛ یک برنامه‌نویس فرانت‌اند حرفه‌ای فارسی‌زبان. فقط JSON معتبر با کد واقعی می‌دهی؛ هیچ توضیحی دربارهٔ طراحی نمی‌نویسی، فقط کد.';
  const buildPrompt = (compact: boolean) => [
    ...(prevInstruction
      ? ['دستور منتقد برای اصلاح این دور (حتماً رعایت کن):', prevInstruction, '']
      : []),
    `کامپوننت «${c.name}» را بساز.`,
    `مسیر فایل: ${c.filePath}`,
    `نام export: ${c.exportName}`,
    `کاربرد: ${c.purpose || '(مشخص نشده)'}`,
    `الگوهای رجیستری وایب‌فارسی: ${c.registryRefs.join('، ') || '(مشخص نشده)'}`,
    `پراپ‌ها: ${c.props || '(مشخص نشده)'}`,
    '',
    'قوانین سفت تولید کد:',
    CODE_RULES,
    '',
    compact
      ? 'فقط JSON معتبر و «فشرده» بده با کلید files شامل آرایه‌ای از {path، content}؛ content کل محتوای فایل TSX باشد ولی بدون حاشیه‌روی. بدون توضیح اضافه، بدون markdown.'
      : 'فقط JSON معتبر بده با کلید files شامل آرایه‌ای از {path، content}؛ content باید کل محتوای فایل TSX باشد. بدون توضیح اضافه، بدون markdown.',
  ].join('\n');
  const first = await callLLMJson<WorkerOutput>(buildPrompt(false), {
    system,
    temperature: 0.5,
    maxTokens: 6000,
  });
  if (hasRealFiles(first)) return first;
  // تلاش دوم: خروجی خالی/بریده بود؛ فشرده بخواه تا در سقف توکن جا شود
  const second = await callLLMJson<WorkerOutput>(buildPrompt(true), {
    system,
    temperature: 0.5,
    maxTokens: 6000,
  });
  if (hasRealFiles(second)) return second;
  throw new Error('مجری فایل معتبری تولید نکرد (files خالی یا محتوای تهی پس از دو تلاش)');
}

/**
 * منتقد: کد واقعی را می‌خواند و داوری می‌کند.
 * رد شدن یعنی کد مشکل دارد و نباید کامیت شود؛ نه اینکه تیم کار نکرده.
 */
async function judgeWorker(files: PatchFile[]): Promise<CriticVerdict> {
  const prompt = [
    'کدهای تولیدشده توسط مجری:',
    ...files.map((f) => `--- ${f.path} ---\n${f.content}`),
    '',
    'قوانین سفت:',
    CODE_RULES,
    '',
    'کد را خط‌به‌خط داوری کن:',
    'الف) TSX معتبر است؟ (تگ متوازن، export درست، interface پراپ‌ها، ایمپورت‌های استفاده‌شده)',
    'ب) راست‌چین درست است؟ (فقط خاصیت منطقی؛ هیچ ml/mr/pl/pr/text-left نباشد)',
    'پ) تایپوگرافی فارسی درست است؟ (فونت تیتر و بدنه، ارقام فارسی در متن نمایشی)',
    'ت) U+2014 در کد یا متن نیست؟',
    'ث) فقط توکن‌های تم وایب‌فارسی/گرافیت به کار رفته؟ (بدون hex من‌درآوردی، بدون سایه)',
    'اگر ایراد کوچکی هست، خودت در files اصلاحش کن و approved بده. فقط اگر ایراد ساختاری جدی است رد کن.',
    'فقط JSON معتبر بده با کلیدهای: approved (بولین)، reason (یک جملهٔ فارسی)، files (آرایهٔ {path، content} نهایی؛ در صورت رد می‌تواند تهی باشد).',
  ].join('\n');
  return callLLMJson<CriticVerdict>(prompt, {
    system:
      'تو منتقد سخت‌گیر کد تیم design هستی. کد واقعی را داوری می‌کنی نه توضیح را. فقط JSON معتبر می‌دهی.',
    temperature: 0.2,
    maxTokens: 6000,
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

/** اعتبارسنجی سبک PatchFile پیش از تحویل. */
function validatePatches(files: PatchFile[]): string | null {
  if (!Array.isArray(files) || files.length === 0) return 'فایل تولید نشد';
  if (files.length > 5) return 'بیش از ۵ فایل در یک چرخه مجاز نیست';
  for (const f of files) {
    if (typeof f.path !== 'string' || !f.path.trim()) return 'مسیر یک فایل نامعتبر است';
    const p = f.path.trim().replace(/^\/+/, '');
    if (p.includes('..') || p.startsWith('.git') || p.includes('.env'))
      return `مسیر غیرمجاز: ${p}`;
    if (!p.startsWith('site/')) return `مسیر باید با site/ شروع شود: ${p}`;
    if (typeof f.content !== 'string' || f.content.trim().length < 50)
      return `محتوای فایل ${p} خیلی کوتاه است`;
    if (f.content.includes('\u2014')) return `U+2014 در فایل ${p} دیده شد`;
  }
  return null;
}

/**
 * تبدیل دلیل ردِ منتقد قدیمی به دستور اجرایی (CriticVerdictV2.instruction).
 * امری و بلندتر از ۵۰ نویسه تا از اعتبارسنجی حلقه رد شود.
 */
function criticInstructionFromReason(reason: string): string {
  const r = reason.trim() || 'کد ایراد دارد';
  return [
    `کد را بر اساس این نقد اصلاح کن: «${r}»`,
    'کل فایل TSX را از نو و کامل بنویس؛ قوانین سفت را خط‌به‌خط رعایت کن:',
    'راست‌چین فقط با خاصیت منطقی (ms/me/ps/pe/text-start)؛ هیچ ml/mr/pl/pr/text-left نیاور؛',
    'تیتر Pinar FD و بدنه IranSans X؛ ارقام نمایشی فارسی؛ U+2014 ممنوع؛',
    'فقط توکن‌های تم گرافیت (بدون سایه، بدون hex من‌درآوردی) و آیکون lucide-react.',
  ].join(' ');
}

/**
 * تبدیل دلیل رد به معیار قبولی (CriticVerdictV2.acceptance).
 */
function criticAcceptanceFromReason(reason: string): string {
  const r = reason.trim() || 'کد ایراد دارد';
  return `وقتی درست است که نقد «${r}» دیگر دربارهٔ کد صدق نکند: TSX معتبر، راست‌چین با خاصیت منطقی، تایپوگرافی فارسی درست، بدون U+2014 و فقط توکن‌های تم وایب‌فارسی/گرافیت.`;
}

export async function runTeam(input: TeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;
  const tasks: QueuedTask[] = [];
  const blockers: string[] = [];

  // ۰. سرپرست: انتخاب دقیقاً یک کامپوننت (پیش‌نیاز حلقه؛ منطقش عین قبل)
  await reportLive?.('سرپرست: انتخاب کامپوننت این چرخه', 15);
  const plan = await makeSupervisorPlan(input);
  const component = safeComponent(plan);
  if (!component) {
    const msg = 'سرپرست کامپوننت معتبری انتخاب نکرد (خروجی JSON ناقص)؛ کار به چرخهٔ بعد موکول شد.';
    blockers.push(msg);
    return { team: TEAM, summary: msg, blockers, tasks, approved: false };
  }

  // ---------- توابع حلقه نقد ----------

  // حکم خام آخرین داوری + فایل‌های نهایی منتقد (برای ساخت پچ بعد از حلقه)
  let lastRawApproved: boolean = false;
  let lastRawReason = '';
  let lastCriticFiles: PatchFile[] = [];

  /**
   * runWorkers: مجری تولید کد هر دور (در دور ۲/۳ با دستور منتقد).
   */
  const runWorkers = async (
    round: number,
    prevInstruction?: string,
  ): Promise<WorkerRoundOutput> => {
    await reportLive?.(
      round === 1 ? `مجری: تولید کد ${component.name}` : `دور ${round}: اصلاح با دستور منتقد`,
      50,
    );
    const workerOut = await executeWorker(component, prevInstruction);
    const localError = validatePatches(workerOut.files);
    if (localError) {
      throw new Error(`خروجی مجری نامعتبر است: ${localError}`);
    }
    return { component, files: workerOut.files };
  };

  /**
   * runCritic: منتقد کد فعلی، با تبدیل خروجی به CriticVerdictV2.
   * دور ۳: حق رد ندارد؛ فقط نظر نهایی.
   */
  const runCritic = async (
    output: WorkerRoundOutput,
    round: number,
  ): Promise<CriticVerdictV2> => {
    await reportLive?.(`منتقد: داوری کد واقعی (دور ${round})`, 80);
    const rawVerdict = await judgeWorker(output.files);
    // حکم ناقص LLM نباید «undefined» چاپ کند
    const verdict: CriticVerdict = {
      approved: rawVerdict?.approved === true,
      reason:
        typeof rawVerdict?.reason === 'string' && rawVerdict.reason.trim()
          ? rawVerdict.reason
          : '(دلیل ثبت نشد)',
      files: Array.isArray(rawVerdict?.files) ? rawVerdict.files : [],
    };
    lastRawApproved = verdict.approved;
    lastRawReason = verdict.reason;
    lastCriticFiles = verdict.files;
    const reason = verdict.reason;

    if (round === 3) {
      return {
        approved: true,
        reason: '',
        instruction: '',
        acceptance: '',
        finalOpinion: reason,
      };
    }
    if (verdict.approved) {
      return {
        approved: true,
        reason: '',
        instruction: '',
        acceptance: '',
        finalOpinion: reason || undefined,
      };
    }
    return {
      approved: false,
      reason,
      instruction: criticInstructionFromReason(reason),
      acceptance: criticAcceptanceFromReason(reason),
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
    const knowledgeResult = await extractCriticKnowledge(
      TEAM,
      {
        approved: verdict.approved,
        reason: record.reason,
        domain: 'تولید کامپوننت',
        instruction: record.instruction,
        round,
        rounds: roundHistory.slice(),
        isFinal: round === 3,
      },
      input.runId,
    );
    roundHistory.push(record);
    lastKnowledgeLog = criticKnowledgeLog(knowledgeResult);
  };

  // ---------- اجرای حلقه نقد ۳ دوره‌ای ----------
  let loopResult: CriticLoopResult<WorkerRoundOutput>;
  try {
    loopResult = await runCriticLoop<WorkerRoundOutput>({
      team: TEAM,
      runId: input.runId,
      runWorkers,
      runCritic,
      onRoundKnowledge,
      onProgress: (msg) => reportLive?.(msg, 70),
    });
  } catch (err) {
    const msg = `مجری خروجی معتبر نداد: ${err instanceof Error ? err.message : String(err)}؛ کار به چرخهٔ بعد موکول شد.`;
    blockers.push(msg);
    return { team: TEAM, summary: msg, blockers, tasks, approved: false };
  }

  // PatchFileها برای مرحلهٔ اعمال (تیم dev یا job اعمال) روی نتیجهٔ نهایی منتقد سوار می‌شوند.
  let patches: PatchFile[] | undefined;

  if (!lastRawApproved) {
    blockers.push(`منتقد design کد را تأیید نکرد: ${lastRawReason}`);
  } else {
    const patchError = validatePatches(lastCriticFiles);
    if (patchError) {
      blockers.push(`خروجی نهایی منتقد نامعتبر است: ${patchError}`);
    } else {
      patches = lastCriticFiles.map((f) => ({
        path: f.path.trim().replace(/^\/+/, ''),
        content: f.content,
      }));
      tasks.push(
        {
          title: `اعمال کامپوننت ${component.name} روی سایت`,
          description: `کامپوننت ${component.exportName} در ${patches.map((p) => p.path).join('، ')} آمادهٔ کامیت روی شاخهٔ dev ریپوی سایت است (الگوهای رجیستری: ${component.registryRefs.join('، ') || 'ندارد'}).`,
          files_hint: patches.map((p) => p.path).join(', '),
          priority: 'high',
        },
        {
          title: 'بازبینی سه‌چشمی کد نهایی',
          description: `کد ${component.name} از نظر فارسی‌نویسی، راست‌چین و توکن‌های وایب‌فارسی توسط منتقد تأیید شد و برای ممیزی vibefarsi و farsiui آماده است.`,
          files_hint: 'design-system/decisions.md',
          priority: 'medium',
        },
      );
    }
  }

  const approved = patches !== undefined;
  const lesson = approved
    ? `کامپوننت موفق: ${component.name} (${component.filePath}) — حلقه در دور ${loopResult.finalRound} تمام شد`
    : `رد منتقد: ${lastRawReason} — حلقه در دور ${loopResult.finalRound} با نظر نهایی تمام شد`;
  await remember(input.runId, lesson);

  const summary = approved
    ? `تیم design این چرخه کامپوننت «${component.name}» را به‌صورت کد واقعی TSX تولید کرد (${patches!.map((p) => p.path).join('، ')})؛ منتقد کد را از نظر راست‌چین، تایپوگرافی فارسی و توکن‌های وایب‌فارسی تأیید کرد. ${lastKnowledgeLog}`
    : `تیم design این چرخه کد تولید کرد ولی منتقد آن را تأیید نکرد و کار به چرخهٔ بعد موکول شد. دلیل: ${lastRawReason} ${lastKnowledgeLog}`;

  return {
    team: TEAM,
    summary,
    blockers,
    tasks: tasks.slice(0, 3),
    approved,
    patches,
  };
}
