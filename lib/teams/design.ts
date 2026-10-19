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
 * خروجی نهایی: PatchFile[] با مسیر site/components/... و دست‌کم یک فایل استفاده‌کننده
 * (قانون B5: «انجام‌شده» یعنی کامپوننت در همین پچ جایی رندر شود؛ فایل تنها = کد مرده)
 * که تیم dev یا مرحلهٔ اعمال، آن را با applyPatchViaGithub روی شاخهٔ dev ریپوی سایت کامیت می‌کند.
 *
 * ضدتکراری سفت در سطح کد (lib/teams/design-dup-guard.ts)، نه فقط پرامپت:
 * سرپرست فهرست واقعی site/components را می‌گیرد (API گیت‌هاب؛ اگر نبود ریپوی
 * محلی) و نگهبان سه‌لایه چک می‌کند: مسیر دقیق، بود/نبود در ریپوی محلی، و
 * توکن‌های نام (thailand-tour-card هم همان tour-card است). ردِ تکراری با دلیل
 * دستوری به پرامپت تلاش بعدی برمی‌گردد تا تیم یاد بگیرد.
 * کلید قطع اضطراری: DESIGN_ALLOW_CREATE=false یعنی فقط modify.
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
import { SITE_REPO_FULL, getGithubConfig } from '../github';
import {
  ALLOW_DESIGN_CREATE,
  findDuplicate,
  isLocalSiteAvailable,
  listLocalSiteComponents,
  localSiteFileExists,
  normalizeSitePath,
} from './design-dup-guard';
import {
  extractCriticKnowledge,
  criticKnowledgeLog,
  type CriticRoundRecord,
} from '../knowledge/critic-knowledge';
import {
  runCriticLoop,
  retryInCycle,
  combineReviewDirectives,
  parseCriticScore,
  CRITIC_SCORE_PROMPT_LINE,
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
  /** دستور صریح منتقد از حلقهٔ بیرونی ارکستراتور (همین چرخه)؛ اگر بود، بالاترین اولویت را دارد. */
  reviewDirective?: string;
  /** شمارهٔ دور حلقهٔ بیرونی (۱ تا ۳). */
  round?: number;
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
    /** 'create' برای فایل تازه، 'modify' برای بهبود کامپوننت موجود */
    action: 'create' | 'modify';
    /**
     * مسیر فایل استفاده‌کننده: صفحه‌ای که این کامپوننت را رندر می‌کند
     * (مثل site/app/(site)/page.tsx یا یک بلوک مونتاژکننده در site/components).
     * «انجام‌شده» یعنی کامپوننت در همین چرخه جایی رندر شود؛ فایل تنها پذیرفته نیست.
     */
    usageFile: string;
    /** 'modify' برای صفحهٔ موجود، 'create' برای صفحه/بخش تازه */
    usageAction: 'modify' | 'create';
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
  const action = o.action === 'modify' ? 'modify' : 'create';
  const usageFile = str(o.usageFile);
  const usageAction = o.usageAction === 'create' ? 'create' : 'modify';
  if (!usageFile) return null;
  const registryRefs = Array.isArray(o.registryRefs)
    ? o.registryRefs.map((r) => (typeof r === 'string' ? r.trim() : '')).filter(Boolean)
    : [];
  return {
    name,
    filePath,
    exportName,
    action,
    usageFile,
    usageAction,
    purpose: str(o.purpose),
    registryRefs,
    props: str(o.props),
  };
}

/**
 * فهرست واقعی فایل‌های site/components از ریپوی سایت (شاخهٔ dev) از GitHub API.
 *
 * تغییر مهم (درس هدررفت توکن): در هر خطا (بی‌توکنی، شبکه، ۴۰۴) به‌جای آرایهٔ
 * تهیِ بی‌صدا، null برمی‌گردد تا صداکننده بداند «فهرستی نداریم» و به ریپوی
 * محلی یا پرس‌وجوی مستقیم تکیه کند؛ فهرست تهیِ بی‌صدا یعنی نگهبان ضدتکراری
 * عملاً خاموش.
 */
async function listSiteComponents(): Promise<string[] | null> {
  try {
    const { token } = await getGithubConfig();
    if (!token) {
      console.warn('[design] توکن گیت‌هاب نیست؛ فهرست کامپوننت‌ها از API گرفته نشد (null).');
      return null;
    }
    const out: string[] = [];
    let listed = false;
    const walk = async (dir: string): Promise<void> => {
      const res = await fetch(
        `https://api.github.com/repos/${SITE_REPO_FULL}/contents/${dir}?ref=dev`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
          },
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!res.ok) return;
      listed = true;
      const items = (await res.json()) as Array<{ type: string; path: string }>;
      if (!Array.isArray(items)) return;
      for (const it of items) {
        if (it.type === 'dir') await walk(it.path);
        else if (typeof it.path === 'string' && /\.tsx?$/.test(it.path)) out.push(it.path);
      }
    };
    await walk('site/components');
    if (!listed) {
      console.warn('[design] گیت‌هاب فهرست site/components را نداد (شاخهٔ dev؟)؛ null برمی‌گردد.');
      return null;
    }
    return out;
  } catch (err) {
    console.warn(
      '[design] خطا در گرفتن فهرست کامپوننت‌ها از گیت‌هاب:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * پرس‌وجوی مستقیم بود/نبود یک مسیر دقیق از گیت‌هاب (شاخهٔ dev).
 * وقتی فهرست کامل در دسترس نیست، آخرین سنگر نگهبانِ «فایل از قبل هست؟» است.
 * برمی‌گرداند: true (هست)، false (نیست)، null (نامشخص).
 */
async function githubFileExists(sitePath: string): Promise<boolean | null> {
  try {
    const { token } = await getGithubConfig();
    if (!token) return null;
    const res = await fetch(
      `https://api.github.com/repos/${SITE_REPO_FULL}/contents/${sitePath}?ref=dev`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    return null;
  } catch {
    return null;
  }
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
  /** امتیاز کیفی منتقد (۰ تا ۱۰۰)؛ تعیین‌کننده نهایی: تأیید فقط با ≥ ۸۰. */
  score?: number;
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
  '۱۱. ضدتکراری اجباری و برنامه‌ای: فهرست واقعی site/components که در پرامپت داده شده، سند نهایی است، نه حافظه. اگر ریشهٔ نام فایل تازه (مثل tour-card) با ریشهٔ نام هر فایل موجود (مثل TourCard) یکی باشد، تکراری است و قانون می‌گوید همان فایل موجود را با action برابر modify بهبود بده. ساخت فایل تازه با ریشهٔ نام تکراری = رد قطعی و خودکار.',
  '۱۲. «انجام‌شده» یعنی رندرشده: پچ این چرخه حتماً باید فایل استفاده‌کننده (usageFile) را هم داشته باشد که کامپوننت را import و در JSX رندر می‌کند. کامپونتی که هیچ صفحه‌ای آن را رندر نکند، کد مرده است و «انجام‌شده» حساب نمی‌شود.',
].join('\n');

/** سرپرست: از بریف artdir و خروجی branding دقیقاً یک کامپوننت انتخاب می‌کند.
 * correctiveFeedback: اگر انتخاب قبلی همین چرخه به دلیل تکراری رد شد، دلیل
 * دقیقش این‌جا می‌آید تا سرپرست همان اشتباه را تکرار نکند (یادگیری درون‌چرخه‌ای). */
async function makeSupervisorPlan(
  input: TeamInput,
  siteFiles: string[],
  siteListSource: string,
  correctiveFeedback?: string,
): Promise<SupervisorPlan> {
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
  const siteListLine = siteFiles.length
    ? `فهرست واقعی فایل‌های site/components (منبع: ${siteListSource}):\n${siteFiles.join('\n')}`
    : '(فهرست واقعی در دسترس نبود؛ با احتیاط و از روی یادگیری‌های قبلی انتخاب کن. اگر action برابر create گذاشتی، حتماً نامی کاملاً تازه و بی‌سابقه انتخاب کن)';
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
    siteListLine,
    '',
    ...(correctiveFeedback
      ? [
          'اخطار اصلاحی: انتخاب قبلی‌ات در همین چرخه رد شد و نباید تکرار شود:',
          correctiveFeedback,
          'یک کامپوننت دیگر انتخاب کن، یا همان فایل موجودِ نام‌برده را با action برابر modify برای بهبود بردار.',
          '',
        ]
      : []),
    ...(ALLOW_DESIGN_CREATE
      ? []
      : [
          'ممنوعیت فعلی: ساخت کامپوننت تازه (action برابر create) در این دوره غیرفعال است؛ فقط action برابر modify برای بهبود کامپوننت موجود مجاز است.',
          '',
        ]),
    'دقیقاً یک کامپوننت انتخاب کن که این چرخه ساخته شود: کوچک، مشخص و قابل‌مشاهده روی سایت (مثل کارت تور، بنر، بخش نظرات، دکمهٔ تماس). از تکرار کامپوننت‌های یادگیری‌های قبلی پرهیز کن.',
    'ضدتکراری با فهرست واقعی بالا: ریشهٔ نام فایل (حروف کوچک، بدون خط‌تیره) را با همهٔ فایل‌های فهرست مقایسه کن. اگر ریشهٔ نام تکراری است (مثلاً tour-card در برابر TourCard)، همان فایل موجود را برای «بهبود» انتخاب کن و action را modify بگذار؛ ساخت فایل تازهٔ تکراری ممنوع و مساوی رد قطعی است.',
    '«انجام‌شده» یعنی رندرشده: همراه کامپوننت، فایل استفاده‌کننده (usageFile) را هم مشخص کن؛ صفحه‌ای واقعی زیر site/app/... یا یک بلوک مونتاژکننده در site/components که این کامپوننت را رندر می‌کند. action برابر modify برای صفحهٔ موجود، و create برای صفحه/بخش تازه.',
    'فقط JSON معتبر بده با کلید component شامل: name (فارسی)، filePath (با الگوی site/components/<area>/<kebab-name>.tsx)، exportName (PascalCase)، action (رشتهٔ "create" یا "modify")، usageFile (مسیر فایل استفاده‌کننده با الگوی site/... )، usageAction (رشتهٔ "create" یا "modify")، purpose (یک جمله)، registryRefs (آرایهٔ slug آیتم‌های رجیستری وایب‌فارسی)، props (توصیف پراپ‌ها).',
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
    c.action === 'modify'
      ? `این یک «بهبود» است نه ساخت تازه: فایل موجود ${c.filePath} را بازنویسی/بهبود بده؛ فایل تازه با نام دیگر نساز.`
      : `این یک ساخت تازه است: فایل ${c.filePath} را بساز.`,
    '',
    '«انجام‌شده» یعنی رندرشده: خروجی files حتماً باید شامل فایل استفاده‌کننده هم باشد:',
    `- مسیر: ${c.usageFile} (${c.usageAction === 'create' ? 'فایل تازه' : 'فایل موجود؛ نسخهٔ کامل و نهایی‌اش را بده'})`,
    `- این فایل باید کامپوننت را import کند و دست‌کم در یک جای JSX آن را با تگ <${c.exportName} ...> رندر کند؛`,
    `- اگر صفحهٔ موجود است، فقط بخش لازم را اضافه کن و بقیهٔ فایل را دست‌نخورده و کامل نگه دار؛`,
    `- خروجی بدون فایل استفاده‌کننده یا بدون رندر واقعی، نامعتبر است و کل پچ رد می‌شود.`,
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
async function judgeWorker(
  files: PatchFile[],
  component: SafeComponent,
): Promise<CriticVerdict> {
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
    'ج) ضدتکراری: ریشهٔ نام فایل تازه با هیچ کامپوننت موجودی یکی نیست؟ (در غیر این صورت باید همان موجود بهبود می‌یافت)',
    'چ) «انجام‌شده» یعنی رندرشده: آیا در میان فایل‌ها، فایل استفاده‌کننده (' +
      component.usageFile +
      ') هست و کامپوننت ' +
      component.exportName +
      ' را واقعاً import و در JSX رندر می‌کند؟ کامپوننت بدون رندر = رد.',
    'اگر ایراد کوچکی هست، خودت در files اصلاحش کن و approved بده. فقط اگر ایراد ساختاری جدی است رد کن.',
    'فقط JSON معتبر بده با کلیدهای: approved (بولین)، score (عدد ۰ تا ۱۰۰)، reason (یک جملهٔ فارسی)، files (آرایهٔ {path، content} نهایی؛ در صورت رد می‌تواند تهی باشد).',
    CRITIC_SCORE_PROMPT_LINE,
  ].join('\n');
  const verdict = await callLLMJson<CriticVerdict>(prompt, {
    system:
      'تو منتقد سخت‌گیر کد تیم design هستی. کد واقعی را داوری می‌کنی نه توضیح را. فقط JSON معتبر می‌دهی.',
    temperature: 0.2,
    maxTokens: 6000,
  });
  return { ...verdict, score: parseCriticScore(verdict.score) ?? undefined };
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

/**
 * اعتبارسنجی سبک PatchFile پیش از تحویل.
 * سه قانون سفت B5/۱۱/۱۲: (۱) نگهبان سفت ضدتکراری با فهرست واقعی + ریپوی محلی
 * (سطح کد، نه پرامپت)؛ (۲) نگهبان معکوس: modify روی فایل ناموجود یعنی توهم و
 * باید create باشد؛ (۳) «انجام‌شده» یعنی پچ شامل فایل استفاده‌کننده‌ای است که
 * کامپوننت را واقعاً رندر می‌کند.
 *
 * sourcesReliable یعنی دست‌کم یک منبع بود/نبود (API یا ریپوی محلی) در دسترس
 * است؛ وقتی هیچ منبعی نیست، نگهبان‌ها «باز» می‌مانند (fail-open) تا چرخه
 * بیهوده نمیرد، ولی هشدارش در لاگ می‌ماند.
 */
function validatePatches(
  files: PatchFile[],
  component: SafeComponent,
  siteFiles: string[],
  sourcesReliable: boolean,
): string | null {
  if (!Array.isArray(files) || files.length === 0) return 'فایل تولید نشد';
  if (files.length > 5) return 'بیش از ۵ فایل در یک چرخه مجاز نیست';
  const paths = files.map((f) =>
    typeof f.path === 'string' ? f.path.trim().replace(/^\/+/, '') : '',
  );
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
  // قانون ۱۱: نگهبان سفت ضدتکراری (کد، نه پرامپت)؛ دلیل ردش دستوری است تا
  // در چرخهٔ اصلاح (buildWorkerRetryInstruction) به مجری برگردد.
  const dup = findDuplicate(component, siteFiles);
  if (dup) return dup;
  // نگهبان معکوس: modify روی فایل ناموجود
  const compNormPath = normalizeSitePath(component.filePath);
  if (component.action === 'modify' && sourcesReliable) {
    const known = siteFiles.includes(compNormPath) || localSiteFileExists(compNormPath);
    if (!known) {
      return (
        `action برابر modify است ولی فایل ${compNormPath} در سایت پیدا نشد؛ ` +
        `برای فایل تازه action باید create باشد، نه modify.`
      );
    }
  }
  // قانون ۱۲: فایل استفاده‌کننده باید در همین پچ باشد و کامپوننت را رندر کند
  const usagePath = component.usageFile.trim().replace(/^\/+/, '');
  const compPath = component.filePath.trim().replace(/^\/+/, '');
  if (!paths.includes(compPath)) return `فایل کامپوننت (${compPath}) در پچ نیست`;
  if (!paths.includes(usagePath))
    return `فایل استفاده‌کننده (${usagePath}) در پچ نیست؛ کامپوننت بدون رندر، کد مرده است`;
  const usage = files.find(
    (f) => f.path.trim().replace(/^\/+/, '') === usagePath,
  );
  if (usage && !usage.content.includes(component.exportName))
    return `فایل استفاده‌کننده (${usagePath}) کامپوننت ${component.exportName} را رندر نمی‌کند`;
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

  // فهرست واقعی کامپوننت‌ها برای نگهبان برنامه‌ای تکراری (قانون ۱۱)؛ پیش از
  // سرپرست خوانده می‌شود تا هم در پرامپتش باشد هم در اعتبارسنجی. اگر API
  // گیت‌هاب در دسترس نبود، ریپوی محلی سایت جایگزین می‌شود (نه آرایهٔ تهیِ بی‌صدا).
  await reportLive?.('فهرست کامپوننت‌های موجود سایت', 10);
  const apiFiles = await listSiteComponents();
  const localFiles = listLocalSiteComponents();
  const siteFiles = apiFiles ?? localFiles;
  const siteListSource =
    apiFiles !== null
      ? 'گیت‌هاب، شاخهٔ dev'
      : isLocalSiteAvailable()
        ? 'ریپوی محلی سایت'
        : 'نامشخص (نه API نه محلی)';
  if (apiFiles === null) {
    console.warn(
      `[design] فهرست API در دسترس نبود؛ ${localFiles.length} فایل از ریپوی محلی خوانده شد.`,
    );
  }
  // دست‌کم یک منبع بود/نبود (API یا ریپوی محلی) در دسترس است؟
  const sourcesReliable = apiFiles !== null || isLocalSiteAvailable();

  // ۰. سرپرست: انتخاب دقیقاً یک کامپوننت، با خوداصلاحی درون‌چرخه‌ای.
  // دستور مسعود: سرپرست باید در همین چرخه کامپوننت معتبر بدهد؛ تا ۳ تلاش، بدون موکول به چرخه بعد.
  // اعتبارسنجی هر تلاش: شکل JSON درست + نگهبان سفت ضدتکراری + کلید قطع create.
  // اگر انتخابی رد شد، «دلیل دقیق» رد به پرامپت تلاش بعدی برمی‌گردد تا سرپرست
  // یاد بگیرد، نه اینکه کورکورانه همان را تکرار کند.
  await reportLive?.('سرپرست: انتخاب کامپوننت این چرخه', 15);
  let supervisorFeedback: string | undefined;
  const plan = await retryInCycle(
    () => makeSupervisorPlan(input, siteFiles, siteListSource, supervisorFeedback),
    (p) => {
      const c = safeComponent(p);
      if (!c) return false;
      if (!ALLOW_DESIGN_CREATE && c.action === 'create') {
        supervisorFeedback =
          'ساخت کامپوننت تازه (action برابر create) در این دوره غیرفعال است؛ فقط action برابر modify برای بهبود کامپوننت موجود مجاز است.';
        return false;
      }
      const dup = findDuplicate(c, siteFiles);
      if (dup) {
        supervisorFeedback = dup;
        return false;
      }
      return true;
    },
    { label: 'سرپرست design', onProgress: (msg) => reportLive?.(msg, 15) },
  );
  const component = plan ? safeComponent(plan) : undefined;
  if (!component) {
    const msg =
      'سرپرست پس از ۳ تلاش در همین چرخه کامپوننت معتبری انتخاب نکرد (خروجی JSON ناقص یا انتخاب تکراری پیاپی)؛ بلوکر در همین چرخه ثبت شد.';
    blockers.push(msg);
    return { team: TEAM, summary: msg, blockers, tasks, approved: false };
  }

  // دروازهٔ نهایی ناهمگام برای create: اگر فهرست API در دسترس نبود، بود/نبود
  // دقیق مسیر را مستقیم از گیت‌هاب بپرس (یک فراخوانی، فقط وقتی لازم است).
  if (component.action === 'create' && apiFiles === null) {
    const fp = normalizeSitePath(component.filePath);
    const exists = await githubFileExists(fp);
    if (exists === true) {
      const msg = `فایل ${fp} در شاخهٔ dev گیت‌هاب از قبل وجود دارد. File already exists. Use modify action, not create. بلوکر در همین چرخه ثبت شد.`;
      blockers.push(msg);
      return { team: TEAM, summary: msg, blockers, tasks, approved: false };
    }
    if (exists === null) {
      console.warn(`[design] بود/نبود ${fp} در گیت‌هاب نامشخص ماند؛ با احتیاط ادامه می‌دهیم.`);
    }
  }

  // ---------- توابع حلقه نقد ----------

  // دلیل و فایل‌های نهایی منتقد (برای ساخت پچ بعد از حلقه)
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
    // دستور صریح حلقهٔ بیرونی (ارکستراتور) در همین چرخه — اولویت بالا، جدا از ragContext.
    // با همان قرارداد مشترک همه تیم‌ها (combineReviewDirectives).
    const combinedInstruction = combineReviewDirectives(input.reviewDirective, prevInstruction);
    const workerOut = await executeWorker(component, combinedInstruction);
    const localError = validatePatches(workerOut.files, component, siteFiles, sourcesReliable);
    if (localError) {
      throw new Error(`خروجی مجری نامعتبر است: ${localError}`);
    }
    return { component, files: workerOut.files };
  };

  /**
   * runCritic: منتقد کد فعلی، با تبدیل خروجی به CriticVerdictV2.
   * دور ۳: آخرین دور؛ حکم خام منتقد ثبت می‌شود.
   */
  const runCritic = async (
    output: WorkerRoundOutput,
    round: number,
  ): Promise<CriticVerdictV2> => {
    await reportLive?.(`منتقد: داوری کد واقعی (دور ${round})`, 80);
    const rawVerdict = await judgeWorker(output.files, output.component);
    // حکم ناقص LLM نباید «undefined» چاپ کند
    const verdict: CriticVerdict = {
      approved: rawVerdict?.approved === true,
      score: rawVerdict?.score,
      reason:
        typeof rawVerdict?.reason === 'string' && rawVerdict.reason.trim()
          ? rawVerdict.reason
          : '(دلیل ثبت نشد)',
      files: Array.isArray(rawVerdict?.files) ? rawVerdict.files : [],
    };
    lastRawReason = verdict.reason;
    lastCriticFiles = verdict.files;
    const reason = verdict.reason;
    const score = verdict.score;

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
    const msg = `مجری پس از ۳ تلاش در همین چرخه خروجی معتبر نداد: ${err instanceof Error ? err.message : String(err)}؛ بلوکر در همین چرخه ثبت شد.`;
    blockers.push(msg);
    return { team: TEAM, summary: msg, blockers, tasks, approved: false };
  }

  // PatchFileها برای مرحلهٔ اعمال (تیم dev یا job اعمال) روی نتیجهٔ نهایی منتقد سوار می‌شوند.
  let patches: PatchFile[] | undefined;

  if (!loopResult.approved) {
    blockers.push(`منتقد design کد را تأیید نکرد: ${lastRawReason}`);
  } else {
    const patchError = validatePatches(lastCriticFiles, component, siteFiles, sourcesReliable);
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
          description: `کامپوننت ${component.exportName} در ${patches.map((p) => p.path).join('، ')} آمادهٔ کامیت روی شاخهٔ dev ریپوی سایت است (الگوهای رجیستری: ${component.registryRefs.join('، ') || 'ندارد'})؛ فایل استفاده‌کننده ${component.usageFile} کامپوننت را رندر می‌کند (قانون «انجام‌شده = رندرشده»).`,
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

  const approved = loopResult.approved && patches !== undefined;
  const lesson = approved
    ? `کامپوننت موفق: ${component.name} (${component.filePath}) — حلقه در دور ${loopResult.finalRound} تمام شد`
    : `رد منتقد: ${lastRawReason} — حلقه در دور ${loopResult.finalRound} با نظر نهایی تمام شد`;
  await remember(input.runId, lesson);

  const summary = approved
    ? `تیم design این چرخه کامپوننت «${component.name}» را به‌صورت کد واقعی TSX تولید کرد (${patches!.map((p) => p.path).join('، ')})؛ منتقد کد را از نظر راست‌چین، تایپوگرافی فارسی و توکن‌های وایب‌فارسی تأیید کرد و کامپوننت در ${component.usageFile} رندر می‌شود. ${lastKnowledgeLog}`
    : `تیم design این چرخه کد تولید کرد؛ منتقد در ${loopResult.finalRound} دور همین چرخه تأیید نکرد و نظر نهایی داد. دلیل: ${lastRawReason} دانش به‌روز شد و بلوکر در گزارش همین چرخه درج شد. ${lastKnowledgeLog}`;

  return {
    team: TEAM,
    summary,
    blockers,
    tasks: tasks.slice(0, 3),
    approved,
    patches,
  };
}
