/**
 * lib/teams/content.ts: تیم content داشبورد ایجنتیک تایلندگرد
 *
 * تیم «تولیدکنندهٔ واقعی» است، نه توصیه‌نویس:
 * در هر چرخه یک راهنمای فارسی کامل و تازه می‌نویسد و آن را به‌صورت
 * PatchFile روی فایل site/lib/guides.ts ریپوی سایت درج می‌کند.
 * لایهٔ پل (lib/bridge) پچ را روی شاخهٔ ai-bridge کامیت و PR می‌سازد؛
 * این تیم فقط «تولید» می‌کند، «اعمال» با لایهٔ پل است.
 *
 * خط لوله:
 *   ۱. سرپرست: انتخاب یک موضوع تازه (بدون تکرار اسلاگ‌های موجود)
 *   ۲. مجری ۱: استخراج واقعیت‌های تأییدشده از زمینه و دانش
 *   ۳. مجری ۲: نگارش متن کامل راهنما (JSON ساخت‌یافته)
 *   ۴. حلقه نقد ۳ دوره‌ای (lib/critic-loop.ts — پایلوت مهاجرت):
 *      دور ۱/۲: منتقد داوری می‌کند؛ رد ← دستور دقیق ← مجری اصلاح می‌کند
 *      دور ۳: فقط نظارت و نظر نهایی (حق رد ندارد)
 *   ۵. کدژن قطعی: تبدیل JSON به آبجکت TypeScript و درج در GUIDES
 *
 * قانون همیشگی تیم: هیچ عددی بدون سند نوشته نمی‌شود؛ فقط واقعیت، بدون حدس.
 * قانون مسعود: خط تیرهٔ بلند (U+2014) مطلقاً ممنوع.
 * قانون مسعود: لحن کلیشه‌ای مطلقاً ممنوع؛ هر جمله با محک «مردم واقعاً این‌طور حرف می‌زنند؟»
 *   سنجیده می‌شود؛ اصطلاح من‌درآوردی ممنوع (قرارداد فارسی‌نویسی:
 *   ~/workspace/custom-skills/local-persian-natural-writing/CONTRACT.md).
 * قانون املا: هجی درست «خائو سوک» است؛ هرگز «کائو سوک» ننویس.
 */

import { callLLMJson } from '../llm';
import { writeMemory } from '../memory';
import { buildKnowledgePromptSection } from '../rag';
import {
  extractCriticKnowledge,
  criticKnowledgeLog,
  type CriticRoundRecord,
} from '../knowledge/critic-knowledge';
import { readSiteFile } from '../bridge/read';
import { sanitizePersian, hasForbiddenDash, escapeTsString } from '../persian-text';
import { formatJalali } from '../jalali';
import {
  runCriticLoop,
  combineReviewDirectives,
  parseCriticScore,
  CRITIC_SCORE_PROMPT_LINE,
  type CriticLoopResult,
  type CriticVerdictV2,
} from '../critic-loop';
import type {
  ProgressReporter,
  QueuedTask,
  TeamName,
  TeamResult,
  PatchFile,
} from '../types';

export const TEAM: TeamName = 'content';

export const MISSION =
  'هر چرخه یک راهنمای فارسی واقعی و تازه برای سایت می‌نویسد و به‌صورت پچ روی site/lib/guides.ts درج می‌کند؛ هیچ عددی بدون سند نوشته نمی‌شود.';

/** مسیر فایل راهنماها در ریپوی سایت. */
const GUIDES_PATH = 'site/lib/guides.ts';

export interface TeamInput {
  /** گزارش زنده‌ی پیشرفت به ارکستر؛ ارکستر همیشه آن را می‌دهد. */
  reportProgress?: ProgressReporter;
  /** شناسه اجرای فعلی */
  runId: string;
  /** شناسه چرخه ارکستر */
  cycleId?: string;
  /** زمینه بازیابی‌شده از دانش (چانک‌های RAG) */
  context?: string;
  /** ورودی خام ارکستر */
  input?: string;
  /**
   * زمینهٔ کامل ارکستر (شامل تسک claimشده از صف ساخت).
   * ارکستر همیشه این را می‌دهد؛ تسک‌های [آپدیت] و [بازنویسی] از همین‌جا خوانده می‌شوند.
   */
  ragContext?: string;
  /**
   * دستور مستقیم منتقد از حلقهٔ بیرونی ارکستراتور (همین چرخه)؛ بالاترین
   * اولویت را دارد و در ابتدای دستور مجری‌ها تزریق می‌شود.
   */
  reviewDirective?: string;
}

/** خروجی سرپرست: یک موضوع مشخص برای این چرخه */
interface SupervisorPick {
  slug: string;
  title: string;
  keyword: string;
  angle: string;
  category: string;
}

/** بخش راهنما */
interface DraftSection {
  heading: string;
  paragraphs: string[];
}

/** سؤال متداول */
interface DraftFaq {
  question: string;
  answer: string;
}

/** پیش‌نویس کامل راهنما از مجری ۲ */
interface GuideDraft {
  title: string;
  h1: string;
  excerpt: string;
  category: string;
  readingMinutes: number;
  sections: DraftSection[];
  faqs: DraftFaq[];
}

/** رأی منتقد روی متن واقعی (الگوی تک‌دور قدیمی) */
interface CriticVerdict {
  approved: boolean;
  /** امتیاز کیفی منتقد (۰ تا ۱۰۰)؛ تعیین‌کننده نهایی: تأیید فقط با ≥ ۸۰. */
  score?: number;
  reason: string;
}

/** خروجی یک دور از مجری‌های حلقه نقد: موضوع + پیش‌نویس تمیزشده */
interface WorkerRoundOutput {
  pick: SupervisorPick;
  factsText: string;
  draft: GuideDraft;
}

/* ==========================================================================
 * سیستم نگهداشت محتوا (دستور مسعود ۱۴۰۵/۰۷/۲۴)
 *
 * رهبر تسک‌های «[آپدیت]» و «[بازنویسی]» می‌سازد؛ این تیم آن‌ها را از
 * ragContext می‌خواند و به‌جای تولید راهنمای تازه، محتوای موجود را
 * به‌روز یا از نو می‌سازد (با حفظ اسلاگ برای سئو).
 * ========================================================================== */

/** نوع تسک نگهداشت محتوا. */
type RefreshKind = 'update' | 'rewrite';

/** تسک نگهداشت استخراج‌شده از زمینهٔ ارکستر. */
interface RefreshTask {
  kind: RefreshKind;
  slug: string;
  reason: string;
  work: string;
  acceptance: string;
}

/**
 * استخراج تسک [آپدیت] یا [بازنویسی] از ragContext.
 * ارکستر تسک claimشده را با قالب «کار تحویل‌شده از صف ساخت» تزریق می‌کند:
 *   عنوان: [آپدیت] راهنمای xxx
 *   شرح: اسلاگ: <slug>\nدلیل: <دلیل>\nکار: <کار>
 *   معیار قبولی: ...
 */
function parseRefreshTask(ragContext: string): RefreshTask | null {
  if (!ragContext) return null;
  // عنوان تسک: [آپدیت] یا [بازنویسی]
  const titleMatch = ragContext.match(/عنوان:\s*\[(آپدیت|بازنویسی)\][^\n]*/);
  if (!titleMatch) return null;
  const kind: RefreshKind = titleMatch[1] === 'آپدیت' ? 'update' : 'rewrite';

  // اسلاگ از خط «اسلاگ: xxx»
  const slugMatch = ragContext.match(/اسلاگ:\s*([a-z0-9-]+)/);
  if (!slugMatch) return null;
  const slug = slugMatch[1].trim();

  const reasonMatch = ragContext.match(/دلیل:\s*([^\n]+)/);
  const workMatch = ragContext.match(/کار:\s*([^\n]+)/);
  const acceptanceMatch = ragContext.match(/معیار قبولی:\s*([^\n]+)/);

  return {
    kind,
    slug,
    reason: (reasonMatch?.[1] ?? '').trim(),
    work: (workMatch?.[1] ?? '').trim(),
    acceptance: (acceptanceMatch?.[1] ?? '').trim() || 'ثبت نشده',
  };
}

/**
 * استخراج بلوک TS راهنمای موجود از فایل guides.ts.
 * بلوک از «{» پیش از «slug: "<slug>"» تا «},» متناظر ادامه دارد.
 */
function extractGuideBlock(fileContent: string, slug: string): string | null {
  const slugMarker = `slug: "${slug}"`;
  const markerIdx = fileContent.indexOf(slugMarker);
  if (markerIdx < 0) return null;
  // ابتدای بلوک: نزدیک‌ترین «  {» قبل از مارکر
  const blockStart = fileContent.lastIndexOf('\n  {', markerIdx);
  if (blockStart < 0) return null;
  // پایان بلوک: «  },» بعد از مارکر (با شمارش آکولاد برای اطمینان)
  let depth = 0;
  let i = blockStart;
  let started = false;
  while (i < fileContent.length) {
    const ch = fileContent[i];
    if (ch === '{') {
      depth++;
      started = true;
    } else if (ch === '}') {
      depth--;
      if (started && depth === 0) {
        // پایان بلوک؛ «,» بعدی هم جزو بلوک است
        let end = i + 1;
        if (fileContent[end] === ',') end++;
        return fileContent.slice(blockStart, end);
      }
    }
    i++;
  }
  return null;
}

/**
 * جایگزینی بلوک راهنمای موجود با نسخهٔ تازه (به‌جای درج).
 * اسلاگ حفظ می‌شود؛ بقیهٔ فیلدها از نسخهٔ تازه می‌آیند.
 */
function replaceGuide(fileContent: string, slug: string, newGuideTs: string): string {
  const oldBlock = extractGuideBlock(fileContent, slug);
  if (!oldBlock) {
    throw new Error(`بلوک راهنمای «${slug}» در فایل پیدا نشد؛ جایگزینی ممکن نیست.`);
  }
  const idx = fileContent.indexOf(oldBlock);
  // بلوک استخراج‌شده با «\n  {» شروع می‌شود؛ بلوک تازه باید دقیقاً همان پیشوند
  // (newline + تورفتگی) را بگیرد. trim روی ابتدای رشته تورفتگی را می‌ریخت و «{»
  // به انتهای بلوک قبلی می‌چسبید؛ آن‌وقت lastIndexOf «\n  {» در استخراج بعدی
  // این بلوک را رد می‌کرد و بلوک راهنمای قبلی (اشتباه) جایگزین می‌شد.
  const braceIdx = oldBlock.indexOf('{');
  const prefix = braceIdx > 0 ? oldBlock.slice(0, braceIdx) : '';
  return (
    fileContent.slice(0, idx) +
    prefix +
    newGuideTs.trim() +
    fileContent.slice(idx + oldBlock.length)
  );
}

const SYSTEM_SUPERVISOR = 'تو سرپرست تیم content تایلندگرد هستی.';
const SYSTEM_WORKER = 'تو نویسندهٔ حرفه‌ای فارسی تیم content تایلندگرد هستی.';
const SYSTEM_CRITIC = 'تو منتقد سخت‌گیر تیم content هستی.';

/**
 * استخراج اسلاگ‌های موجود از محتوای فایل guides.ts (جلوگیری از تکرار).
 */
function extractExistingSlugs(fileContent: string): string[] {
  const slugs: string[] = [];
  const re = /slug:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fileContent)) !== null) {
    slugs.push(m[1]);
  }
  return slugs;
}

/**
 * تاریخ امروز به فارسی، مثل «۲۳ مهر ۱۴۰۵»، برای فیلد updatedFa.
 */
function todayFa(): string {
  try {
    return formatJalali(new Date(), { year: true });
  } catch {
    return '۲۳ مهر ۱۴۰۵';
  }
}

/**
 * اصلاح قطعی غلط‌های املایی شناخته‌شده، مستقل از رفتار LLM.
 * در آخرین گیت پیش از ساخت پچ اعمال می‌شود.
 * (فهرست فقط با دستور صریح مسعود تغییر می‌کند.)
 */
function fixKnownTypos(s: string): string {
  return s.replace(/کائو سوک/g, 'خائو سوک');
}

/**
 * تمیزکاری کامل یک رشتهٔ فارسی: sanitize + اصلاح غلط‌های شناخته‌شده.
 * در همهٔ مسیرها (main و refresh) روی خروجی LLM اعمال می‌شود تا منتقد
 * هم متن اصلاح‌شده را ببیند و هم خروجی نهایی تمیز باشد.
 */
function cleanFa(s: string): string {
  return fixKnownTypos(sanitizePersian(s));
}

/**
 * نگهبان ضدجعل مکان (دستور مسعود ۱۴۰۵/۰۷/۲۶ — تنبیه تیم content).
 * قانون مسعود: «هیچ دادهٔ ساختگی یا نمایشی وارد نشود».
 *
 * ریشهٔ مشکل: مجری ۲ برای «خاص و دقیق» به‌نظر رسیدن، اسم مکان
 * من‌درآوردی می‌ساخت (مثلاً پارک‌های «کوانگ این و کوانگ نای» که
 * در تایلند وجود ندارند) و منتقد هیچ معیاری برای گرفتنش نداشت.
 *
 * این فهرست، جعلیاتِ دیده‌شده را قطعی می‌گیرد؛ پرامپت‌ها هم
 * صریحاً جعل را ممنوع و منتقد را به ردِ قطعی موظف می‌کنند.
 * اگر جعل تازه‌ای دیده شد، همین‌جا اضافه کن (با دستور مسعود).
 */
const FABRICATED_PLACES: string[] = [
  'کوانگ این',
  'کوانگ نای',
];

/**
 * اسکن متن برای اسم مکان جعلی شناخته‌شده.
 * خروجی: آرایه‌ای از جعلیات پیدا شده (خالی = تمیز).
 */
function detectFabricatedPlaces(text: string): string[] {
  const found: string[] = [];
  for (const fake of FABRICATED_PLACES) {
    if (text.includes(fake) && !found.includes(fake)) {
      found.push(fake);
    }
  }
  return found;
}

/* ==========================================================================
 * نگهبان ضدکلیشه (دستور مسعود ۱۴۰۵/۰۷/۲۶ — بازبینی اساسی تیم content).
 * قانون مسعود: «لحن کلیشه‌ای مطلقاً ممنوع».
 *
 * ریشهٔ مشکل: منتقد LLM در برابر کلیشه‌ها سهل‌گیر بود و دور ۳ حق رد
 * نداشت؛ پس متن‌های ماشینی به پچ می‌رسیدند. این فهرست، کلیشه‌های
 * دیده‌شده در بازخورد منتقد را قطعی می‌گیرد.
 * اگر کلیشهٔ تازه‌ای دیده شد، همین‌جا اضافه کن (با دستور مسعود).
 * ========================================================================== */
const CLICHE_PHRASES: string[] = [
  'تجربه فرهنگی جذابی',
  'تجربهٔ فرهنگی جذابی',
  'برای بک‌پکرها',
  'برای بک پکرها',
  'بک‌پکرها',
  'سفری بی‌نقص',
  'سفری فراموش‌نشدنی',
  'خاطره‌ای فراموش‌نشدنی',
  'بهشتی روی زمین',
  'گوشه‌ای از بهشت',
  'در دنیای امروز',
  'شایان ذکر است',
];

/**
 * اسکن متن برای عبارت کلیشه‌ای شناخته‌شده.
 * خروجی: آرایه‌ای از کلیشه‌های پیدا شده (خالی = تمیز).
 */
function detectCliches(text: string): string[] {
  const found: string[] = [];
  for (const cliche of CLICHE_PHRASES) {
    if (text.includes(cliche) && !found.includes(cliche)) {
      found.push(cliche);
    }
  }
  return found;
}

/* ==========================================================================
 * گیت نهایی یکپارچه (دستور مسعود ۱۴۰۵/۰۷/۲۶ — بازبینی اساسی).
 * همهٔ قوانین قطعی مسعود در یک تابع کدی، پیش از ساخت هر پچ.
 * خروجی: null = تمیز؛ رشته = دلیل بلاک.
 * ========================================================================== */
function finalContentGate(draftJson: string): string | null {
  if (hasForbiddenDash(draftJson)) {
    return 'متن نهایی خط تیرهٔ ممنوعه (U+2014/U+2013) دارد؛ پچ ساخته نشد.';
  }
  const fabricated = detectFabricatedPlaces(draftJson);
  if (fabricated.length > 0) {
    return `متن نهایی اسم مکان جعلی دارد (${fabricated.join('، ')})؛ پچ ساخته نشد. قانون مسعود: هیچ دادهٔ ساختگی.`;
  }
  const cliches = detectCliches(draftJson);
  if (cliches.length > 0) {
    return `متن نهایی عبارت کلیشه‌ای دارد (${cliches.join('، ')})؛ پچ ساخته نشد. قانون مسعود: لحن کلیشه‌ای ممنوع.`;
  }
  // غلط املایی شناخته‌شده نباید به این مرحله برسد (fixKnownTypos باید زودتر اعمال شده باشد)
  if (draftJson.includes('کائو سوک')) {
    return 'متن نهایی هجی غلط «کائو سوک» دارد؛ پچ ساخته نشد.';
  }
  return null;
}

/**
 * ساخت آبجکت TypeScript راهنما با سبک فایل guides.ts.
 * همهٔ رشته‌ها sanitize و escape می‌شوند.
 */
function buildGuideTs(pick: SupervisorPick, draft: GuideDraft): string {
  const q = (s: string) => `"${escapeTsString(sanitizePersian(fixKnownTypos(s)))}"`;
  const lines: string[] = [];
  lines.push('  {');
  lines.push(`    slug: ${q(pick.slug)},`);
  lines.push(`    title: ${q(draft.title)},`);
  if (draft.h1 && draft.h1.trim()) {
    lines.push(`    h1: ${q(draft.h1)},`);
  }
  lines.push(`    excerpt: ${q(draft.excerpt)},`);
  lines.push(`    category: ${q(draft.category || pick.category)},`);
  lines.push(`    readingMinutes: ${Math.max(3, Math.min(15, draft.readingMinutes || 6))},`);
  lines.push(`    updatedFa: ${q(todayFa())},`);
  lines.push('    sections: [');
  for (const s of draft.sections) {
    lines.push('      {');
    lines.push(`        heading: ${q(s.heading)},`);
    lines.push('        paragraphs: [');
    for (const p of s.paragraphs) {
      lines.push(`          ${q(p)},`);
    }
    lines.push('        ],');
    lines.push('      },');
  }
  lines.push('    ],');
  lines.push('    faqs: [');
  for (const f of draft.faqs) {
    lines.push('      {');
    lines.push(`        question: ${q(f.question)},`);
    lines.push(`        answer: ${q(f.answer)},`);
    lines.push('      },');
  }
  lines.push('    ],');
  lines.push('  },');
  return lines.join('\n');
}

/**
 * درج راهنمای تازه در آرایهٔ GUIDES.
 * نقطهٔ درج: آخرین «];» پیش از «export function getGuide».
 */
function insertGuide(fileContent: string, guideTs: string): string {
  const marker = 'export function getGuide';
  const markerIdx = fileContent.indexOf(marker);
  if (markerIdx < 0) {
    throw new Error('ساختار فایل guides.ts شناخته نشد (تابع getGuide پیدا نشد).');
  }
  const closeIdx = fileContent.lastIndexOf('];', markerIdx);
  if (closeIdx < 0) {
    throw new Error('پایان آرایهٔ GUIDES پیدا نشد.');
  }
  return (
    fileContent.slice(0, closeIdx) + '\n' + guideTs + '\n];' + fileContent.slice(closeIdx + 2)
  );
}

/** اعتبارسنجی اولیهٔ پیش‌نویس؛ دقیقاً مطابق آنچه پرامپت‌ها می‌خواهند. */
function validateDraft(draft: GuideDraft): string | null {
  if (!draft || typeof draft !== 'object') return 'پیش‌نویس خالی یا نامعتبر است.';
  if (!draft.title || draft.title.trim().length < 5) return 'تیتر راهنما کوتاه یا خالی است.';
  if (!draft.excerpt || draft.excerpt.trim().length < 20) return 'چکیده خالی یا خیلی کوتاه است.';
  if (!Array.isArray(draft.sections) || draft.sections.length < 3)
    return 'راهنما حداقل ۳ بخش می‌خواهد.';
  for (const s of draft.sections) {
    if (!s.heading || !Array.isArray(s.paragraphs) || s.paragraphs.length < 2)
      return 'هر بخش حداقل ۲ پاراگراف می‌خواهد.';
    for (const p of s.paragraphs) {
      if (!p || p.trim().length < 20) return 'یک پاراگراف خالی یا خیلی کوتاه است.';
    }
  }
  if (!Array.isArray(draft.faqs) || draft.faqs.length < 3)
    return 'راهنما حداقل ۳ سؤال متداول می‌خواهد.';
  return null;
}

/**
 * تبدیل دلیل ردِ منتقد قدیمی به دستور اجرایی (CriticVerdictV2.instruction).
 * امری و بلندتر از ۵۰ نویسه تا از اعتبارسنجی حلقه رد شود.
 */
function criticInstructionFromReason(reason: string): string {
  const r = reason.trim() || 'متن ایراد دارد';
  return [
    `متن را بر اساس این نقد اصلاح کن: «${r}»`,
    'بخش‌های ضعیف را بازنویسی کن؛ هر عدد یا ادعای بدون سند را حذف کن؛',
    'هر اسم مکان خاص (پارک، معبد، جزیره، هتل، رستوران) که جعلی یا مشکوک است را حذف کن یا با عبارت کلی جایگزین کن؛ هرگز اسم مکان من‌درآوردی نساز؛',
    'لحن را طبیعی، انسانی و کاربردی برای مسافر واقعی نگه دار؛ لحن کلیشه‌ای و اصطلاح من‌درآوردی ممنوع؛',
    'هجی درست «خائو سوک» است؛ هرگز «کائو سوک» ننویس؛',
    'در پایان دوباره کنترل کن هیچ کاراکتر U+2014 و هیچ عدد بی‌سندی در متن نباشد.',
  ].join(' ');
}

/**
 * تبدیل دلیل رد به معیار قبولی (CriticVerdictV2.acceptance).
 */
function criticAcceptanceFromReason(reason: string): string {
  const r = reason.trim() || 'متن ایراد دارد';
  return `وقتی درست است که نقد «${r}» دیگر دربارهٔ متن صدق نکند و هر شش معیار داوری (فارسی طبیعی بدون کلیشه، بدون U+2014، اعداد سنددار، کاربردی بودن، هجی درست «خائو سوک»، بدون اسم مکان جعلی) رعایت شده باشند.`;
}

/* ==========================================================================
 * جریان نگهداشت: آپدیت و بازنویسی راهنمای موجود
 * ========================================================================== */

/**
 * اجرای تسک نگهداشت ([آپدیت] یا [بازنویسی]).
 * به‌جای تولید راهنمای تازه، محتوای موجودِ اسلاگ را به‌روز یا از نو می‌سازد.
 * خروجی: پچ جایگزینی روی همان فایل guides.ts (اسلاگ حفظ می‌شود).
 */
async function runRefreshFlow(
  task: RefreshTask,
  guidesFile: string,
  knowledgeSection: string,
  input: TeamInput,
  reportLive: ProgressReporter | undefined,
): Promise<TeamResult> {
  const blockers: string[] = [];
  const patches: PatchFile[] = [];
  const kindFa = task.kind === 'update' ? 'آپدیت' : 'بازنویسی';

  await reportLive?.(`${kindFa}: خواندن نسخهٔ فعلی راهنما`, 15);
  const oldBlock = extractGuideBlock(guidesFile, task.slug);
  if (!oldBlock) {
    const msg = `راهنمای «${task.slug}» در فایل پیدا نشد؛ ${kindFa} ممکن نیست.`;
    return { team: TEAM, summary: msg, blockers: [msg], tasks: [], approved: false };
  }

  // استخراج تیتر فعلی برای زمینه
  const titleMatch = oldBlock.match(/title:\s*"([^"]+)"/);
  const currentTitle = titleMatch?.[1] ?? task.slug;

  await reportLive?.(`${kindFa}: تولید نسخهٔ تازه با LLM`, 45);
  const isUpdate = task.kind === 'update';
  let draft: GuideDraft;
  try {
    draft = await callLLMJson<GuideDraft>(
      [
        `تو نویسندهٔ حرفه‌ای فارسی تیم content تایلندگرد هستی.`,
        '',
        `مأموریت: ${kindFa} راهنمای موجود «${currentTitle}» (اسلاگ: ${task.slug}).`,
        `دلیل ${kindFa}: ${task.reason || 'ثبت نشده'}`,
        `کار خواسته‌شده: ${task.work || 'ثبت نشده'}`,
        `معیار قبولی: ${task.acceptance}`,
        '',
        'نسخهٔ فعلی راهنما (TypeScript):',
        oldBlock.slice(0, 6000),
        '',
        ...(knowledgeSection ? ['دانش تیم:', knowledgeSection, ''] : []),
        isUpdate
          ? [
              'قواعد آپدیت (تعمیر، نه بازسازی):',
              '- ساختار کلی و تیترها را حفظ کن؛ فقط جاهای کهنه را درست کن',
              '- اطلاعات تازه و مفید اضافه کن؛ اطلاعات غلط یا قدیمی را حذف کن',
              '- اگر عددی سند ندارد، آن را نیاور یا با «نامشخص» علامت بزن',
              '- حداقل ۲ لینک داخلی تازه به راهنماهای دیگر اضافه کن با قالب [[متن|/guide/اسلاگ]]',
              '- بخش‌هایی که دیگر کاربردی نیستند را حذف کن',
            ]
          : [
              'قواعد بازنویسی (از نو ساختن):',
              '- ساختار کاملاً جدید بساز؛ از نسخهٔ قدیمی فقط موضوع را بگیر',
              '- تیتر، h1، چکیده، بخش‌ها و سؤال‌ها همه تازه باشند',
              '- نیت فعلی کاربر را پوشش بده (نه نیت قدیمی)',
              '- لینک داخلی به راهنماهای مرتبط اضافه کن با قالب [[متن|/guide/اسلاگ]]',
            ],
        '',
        'قواعد همیشگی:',
        '- رجیستر «شما»؛ لحن گرم و انسانی',
        '- لحن کلیشه‌ای مطلقاً ممنوع؛ اصطلاح من‌درآوردی نساز',
        '- هجی درست «خائو سوک» است؛ هرگز «کائو سوک» ننویس',
        '- نام مکان خاص (پارک، معبد، جزیره، ساحل، هتل، رستوران، بازار، مرکز خرید) را فقط از واقعیت‌های تأییدشده یا دانش تیم بیاور؛ هرگز اسم مکان من‌درآوردی نساز (قانون مسعود: هیچ دادهٔ ساختگی)',
        '- اگر از وجود یک مکان خاص مطمئن نیستی، اسمش را ننویس؛ کلی بگو (مثلاً «پارک‌های ملی تایلند» به‌جای اسم خاص)',
        '- ۳ تا ۵ بخش، هر بخش ۲ تا ۳ پاراگراف کوتاه و کاربردی',
        '- ۳ تا ۴ سؤال متداول با جواب مستقیم',
        '- هیچ عددی بدون سند؛ کاراکتر U+2014 مطلقاً ممنوع',
        '',
        'فقط JSON معتبر بده با کلیدهای: title, h1, excerpt, category, readingMinutes (عدد)،',
        'sections (آرایه‌ای از {heading, paragraphs}), faqs (آرایه‌ای از {question, answer}).',
        'خروجی باید دقیقاً با { شروع و با } تمام شود. هیچ متن، توضیح یا کدفنس قبل و بعد از JSON ننویس.',
      ].join('\n'),
      { system: SYSTEM_WORKER, maxTokens: 4000 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    blockers.push(`تولید نسخهٔ تازه ناموفق بود: ${msg}`);
    return { team: TEAM, summary: blockers[0], blockers, tasks: [], approved: false };
  }

  const draftError = validateDraft(draft);
  if (draftError) {
    blockers.push(`پیش‌نویس ${kindFa} نامعتبر است: ${draftError}`);
    return { team: TEAM, summary: blockers[0], blockers, tasks: [], approved: false };
  }

  // تمیزکاری فارسی (شامل اصلاح غلط‌های شناخته‌شده)
  const cleanDraft: GuideDraft = {
    title: cleanFa(draft.title),
    h1: cleanFa(draft.h1),
    excerpt: cleanFa(draft.excerpt),
    category: cleanFa(draft.category),
    readingMinutes: draft.readingMinutes,
    sections: draft.sections.map((s) => ({
      heading: cleanFa(s.heading),
      paragraphs: s.paragraphs.map((p) => cleanFa(p)),
    })),
    faqs: draft.faqs.map((f) => ({
      question: cleanFa(f.question),
      answer: cleanFa(f.answer),
    })),
  };

  // گیت نهایی یکپارچه: همهٔ قوانین قطعی مسعود در کد
  const gateError = finalContentGate(JSON.stringify(cleanDraft));
  if (gateError) {
    blockers.push(gateError);
    return { team: TEAM, summary: gateError, blockers, tasks: [], approved: false };
  }

  // داوری سریع منتقد روی نسخهٔ تازه (تک‌دور؛ رد = بلاکر، نه حلقه)
  await reportLive?.('منتقد: داوری نسخهٔ تازه', 70);
  try {
    const draftText = [
      `تیتر: ${cleanDraft.title}`,
      `h1: ${cleanDraft.h1}`,
      `چکیده: ${cleanDraft.excerpt}`,
      ...cleanDraft.sections.flatMap((s) => [`## ${s.heading}`, ...s.paragraphs]),
      ...cleanDraft.faqs.flatMap((f) => [`س: ${f.question}`, `ج: ${f.answer}`]),
    ].join('\n\n');
    const verdict = await callLLMJson<CriticVerdict>(
      [
        `${kindFa} راهنمای «${currentTitle}»:`,
        draftText,
        '',
        'داوری کن. معیارها (هر کدام که نقض شود = رد): فارسی طبیعی و بدون کلیشه (اگر کلیشه‌ای است رد کن)، بدون U+2014، اعداد سنددار، کاربردی بودن، هجی درست «خائو سوک» (نه «کائو سوک»)، بدون اسم مکان جعلی (اگر پارک/معبد/جزیره/هتل با اسم مشکوک یا من‌درآوردی دیدی رد کن)، سازگاری حسابگری (هر عدد و تبدیل ارز را دوباره حساب کن؛ تناقض = رد)، قیمتِ نام‌برده واقع‌نما (رستوران/هتل با اسم خاص و قیمت مشخصاً غیرواقعی = رد)، بدون بریدگی (پاسخ نصفه یا بخش بی‌معنا = رد). قانون تأیید (یافتهٔ ممیزی C1): approved=true فقط وقتی مجاز است که در reason این چک‌لیست را یک‌خطی تأیید کنی: «جعل مکان: ندارد | عددها: سنددار و سازگار | حسابگری: سازگار | بریدگی: ندارد».',
        isUpdate
          ? 'برای آپدیت: آیا اطلاعات تازه اضافه و کهنه حذف شده؟'
          : 'برای بازنویسی: آیا ساختار واقعاً تازه است؟',
        'فقط JSON معتبر بده: {"approved": true/false, "score": ۰ تا ۱۰۰, "reason": "یک جمله"}',
        CRITIC_SCORE_PROMPT_LINE,
        'خروجی باید دقیقاً با { شروع و با } تمام شود. هیچ متن، توضیح یا کدفنس قبل و بعد از JSON ننویس.',
      ].join('\n'),
      { system: SYSTEM_CRITIC },
    );
    if (!verdict.approved) {
      const msg = `منتقد نسخهٔ ${kindFa} را رد کرد: ${verdict.reason || 'بدون دلیل'}`;
      return { team: TEAM, summary: msg, blockers: [msg], tasks: [], approved: false };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    blockers.push(`داوری منتقد ناموفق بود: ${msg}`);
    return { team: TEAM, summary: blockers[0], blockers, tasks: [], approved: false };
  }

  // ساخت پچ جایگزینی (اسلاگ حفظ می‌شود)
  await reportLive?.('ساخت پچ جایگزینی', 90);
  let newFileContent = '';
  try {
    const guideTs = buildGuideTs(
      {
        slug: task.slug, // اسلاگ حفظ می‌شود (قانون سئو)
        title: cleanDraft.title,
        keyword: '',
        angle: '',
        category: cleanDraft.category,
      },
      cleanDraft,
    );
    newFileContent = replaceGuide(guidesFile, task.slug, guideTs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    blockers.push(`ساخت پچ جایگزینی ناموفق بود: ${msg}`);
    return { team: TEAM, summary: blockers[0], blockers, tasks: [], approved: false };
  }

  patches.push({ path: GUIDES_PATH, content: newFileContent });

  // ثبت در حافظه (fail-soft: خطای دیتابیس نباید پچ آماده را بسوزاند)
  await reportLive?.('ثبت در حافظه', 95);
  try {
    await writeMemory({
      team: TEAM,
      key: `learned:${input.runId}`,
      value: JSON.stringify({
        kind: task.kind,
        slug: task.slug,
        title: cleanDraft.title,
        reason: task.reason,
        sectionsCount: cleanDraft.sections.length,
        faqsCount: cleanDraft.faqs.length,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    blockers.push(`ثبت حافظه ناموفق بود (پچ حفظ شد): ${msg}`);
  }

  const summary =
    `${kindFa} راهنمای «${cleanDraft.title}» (اسلاگ: ${task.slug}) انجام شد؛ ` +
    `پچ جایگزینی آماده است و تاریخ به‌روزرسانی تازه شد.`;
  return { team: TEAM, summary, blockers, tasks: [], approved: true, patches };
}

/**
 * اجرای یک نوبت تیم content: تولید یک راهنمای واقعی + پچ.
 * (پایلوت مهاجرت به حلقه نقد ۳ دوره‌ای lib/critic-loop.ts)
 */
export async function runTeam(input: TeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;
  const context = input.context ?? input.input ?? '';
  const blockers: string[] = [];
  const patches: PatchFile[] = [];

  let knowledgeSection = '';
  // ضربان زنده پیش از فراخوانی RAG/دیتابیس؛ بدون آن، نگهبان «هنگ» اعلام می‌کند.
  await reportLive?.('بازیابی دانش تیم', 2);
  try {
    knowledgeSection = await buildKnowledgePromptSection(TEAM, MISSION);
  } catch {
    knowledgeSection = '';
  }

  // ۰. خواندن فایل جاری راهنماها از ریپوی سایت (برای جلوگیری از تکرار اسلاگ)
  // پیش‌نیاز حلقه است؛ منطقش عین قبل.
  await reportLive?.('خواندن راهنماهای موجود سایت', 5);
  let guidesFile: string | null = null;
  let existingSlugs: string[] = [];
  try {
    guidesFile = await readSiteFile(GUIDES_PATH);
    if (guidesFile) existingSlugs = extractExistingSlugs(guidesFile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    blockers.push(`خواندن فایل راهنماها از ریپوی سایت ناموفق بود: ${msg}`);
    return { team: TEAM, summary: blockers[0], blockers, tasks: [], approved: false };
  }
  if (!guidesFile) {
    blockers.push('فایل site/lib/guides.ts در ریپوی سایت پیدا نشد.');
    return { team: TEAM, summary: blockers[0], blockers, tasks: [], approved: false };
  }

  // ---------- مسیر نگهداشت: اگر تسک [آپدیت] یا [بازنویسی] از صف آمده ----------
  // ارکستر تسک claimشده را در ragContext تزریق می‌کند؛ رهبر تسک‌های نگهداشت
  // را با همین قالب می‌سازد. این مسیر بالاترین اولویت را دارد.
  const refreshTask = parseRefreshTask(input.ragContext ?? '');
  if (refreshTask) {
    await reportLive?.(
      `تسک نگهداشت دریافت شد: ${refreshTask.kind === 'update' ? 'آپدیت' : 'بازنویسی'} «${refreshTask.slug}»`,
      10,
    );
    return runRefreshFlow(refreshTask, guidesFile, knowledgeSection, input, reportLive);
  }

  // ---------- توابع حلقه نقد ----------

  // کش دور ۱: موضوع و واقعیت‌ها در هر چرخه یک بار ساخته می‌شوند؛
  // دورهای ۲ و ۳ همان موضوع را با دستور منتقد اصلاح می‌کنند.
  let cachedPick: SupervisorPick | null = null;
  let cachedFacts = '';
  let cachedSlug = '';

  /**
   * runWorkers: منطق فعلی مجری‌ها (سرپرست + ۲ مجری).
   * دور ۱: هر سه قدم؛ دور ۲/۳: فقط مجری ۲ با دستور منتقد (prevInstruction).
   */
  const runWorkers = async (
    round: number,
    prevInstruction?: string,
  ): Promise<WorkerRoundOutput> => {
    if (round === 1) {
      // ۱. سرپرست: انتخاب یک موضوع تازه (منطق فعلی، بدون تغییر)
      await reportLive?.('سرپرست: انتخاب موضوع تازه', 15);
      const pick = await callLLMJson<SupervisorPick>(
        [
          'اسلاگ‌های موجود (این‌ها را تکرار نکن):',
          existingSlugs.join('، ') || '(خالی)',
          '',
          'زمینه و دانش:',
          ...(knowledgeSection ? [knowledgeSection, ''] : []),
          context || '(زمینه‌ای داده نشد)',
          '',
          `مأموریت تیم content: ${MISSION}`,
          '',
          'یک موضوع تازه و پرتقاضا برای راهنمای سفر به تایلند انتخاب کن (ویزا، هزینه، شهرها، فصل سفر، پرواز، هتل، تجربه‌ها).',
          'اسلاگ انگلیسی کوتاه با خط‌تیره بده (مثل thailand-visa-guide) که در فهرست بالا نباشد.',
          'فقط JSON معتبر بده: {"slug": "...", "title": "تیتر فارسی", "keyword": "کلمهٔ کلیدی اصلی", "angle": "زاویهٔ یک‌خطی", "category": "دسته‌بندی"}',
          'خروجی باید دقیقاً با { شروع و با } تمام شود. هیچ متن، توضیح یا کدفنس قبل و بعد از JSON ننویس.',
        ].join('\n'),
        { system: SYSTEM_SUPERVISOR },
      );
      // گارد خروجی LLM: در ران‌تایم ممکن است null/غیرشیء برگردد (تایپ Promise<T> تضمین نمی‌کند)
      if (!pick || typeof pick !== 'object') {
        throw new Error('سرپرست خروجی معتبر برنگرداند؛ انتخاب موضوع ناموفق بود.');
      }
      const slug = String(pick.slug || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-');
      if (!slug || existingSlugs.includes(slug)) {
        throw new Error(`اسلاگ نامعتبر یا تکراری: ${pick.slug}`);
      }

      // ۲. مجری ۱: استخراج واقعیت‌های تأییدشده (منطق فعلی، بدون تغییر)
      await reportLive?.('مجری ۱: استخراج واقعیت‌ها', 35);
      const facts = await callLLMJson<{ facts: string }>(
        [
          `موضوع: ${pick.title} (کلمهٔ کلیدی: ${pick.keyword}، زاویه: ${pick.angle})`,
          '',
          'زمینه و دانش:',
          ...(knowledgeSection ? [knowledgeSection, ''] : []),
          context || '(زمینه‌ای داده نشد)',
          '',
          'واقعیت‌های قابل اتکا دربارهٔ این موضوع را فهرست کن؛ هر عدد باید منبعش را هم بگوید. حدس نزن؛ اگر از چیزی مطمئن نیستی بنویس «نامشخص». نام مکان خاص (پارک، معبد، جزیره، هتل) را فقط اگر واقعاً وجود دارد بنویس؛ هرگز اسم مکان من‌درآوردی نساز.',
          'فقط JSON معتبر بده: {"facts": "متن واقعیت‌ها"}',
          'خروجی باید دقیقاً با { شروع و با } تمام شود. هیچ متن، توضیح یا کدفنس قبل و بعد از JSON ننویس.',
        ].join('\n'),
        { system: SYSTEM_WORKER },
      );
      if (!facts || typeof facts !== 'object') {
        throw new Error('مجری ۱ خروجی معتبر برنگرداند؛ استخراج واقعیت‌ها ناموفق بود.');
      }

      cachedPick = pick;
      cachedFacts = facts.facts || '';
      cachedSlug = slug;
    } else {
      await reportLive?.(`دور ${round}: اصلاح با دستور منتقد`, 45);
    }

    const pick = cachedPick;
    if (!pick) {
      throw new Error('موضوع چرخه در کش پیدا نشد.');
    }
    const factsText = cachedFacts;

    // ۳. مجری ۲: نگارش متن کامل راهنما (منطق فعلی؛ در دور ۲/۳ دستور منتقد تزریق می‌شود)
    // دستور مستقیم حلقهٔ بیرونی (reviewDirective) بالاترین اولویت را دارد.
    const combinedInstruction = combineReviewDirectives(input.reviewDirective, prevInstruction);
    // ضربان زنده پیش از نگارش: این LLM call با maxTokens بالا ممکن است
    // چند دقیقه طول بکشد؛ بدون ضربان تازه، نگهبان «هنگ» اعلام می‌کند.
    await reportLive?.(`مجری ۲: نگارش راهنما (دور ${round})`, 60);
    const draft = await callLLMJson<GuideDraft>(
      [
        ...(combinedInstruction
          ? ['دستور منتقد برای اصلاح این دور (حتماً رعایت کن):', combinedInstruction, '']
          : []),
        `موضوع: ${pick.title}`,
        `کلمهٔ کلیدی اصلی: ${pick.keyword}`,
        `زاویه: ${pick.angle}`,
        `دسته‌بندی: ${pick.category}`,
        '',
        'واقعیت‌های تأییدشده:',
        factsText || '(واقعیتی داده نشد)',
        '',
        'یک راهنمای کامل فارسی بنویس با این مشخصات:',
        '- رجیستر «شما»؛ لحن گرم و انسانی، مثل راهنمای باتجربه نه مقالهٔ ماشینی',
        '- لحن کلیشه‌ای مطلقاً ممنوع (جمله‌های قالبی و توخالی ننویس)',
        '- هر جمله را با این محک بسنج: «مردم واقعاً این‌طور حرف می‌زنند؟»؛ اگر نه، از نو بساز',
        '- اصطلاح من‌درآوردی نساز؛ از واژه‌هایی استفاده کن که مسافران واقعاً می‌گویند',
        '- هجی درست «خائو سوک» است؛ هرگز «کائو سوک» ننویس',
        '- ۳ تا ۵ بخش، هر بخش ۲ تا ۳ پاراگراف کوتاه و کاربردی',
        '- ۳ تا ۴ سؤال متداول با جواب مستقیم و کوتاه',
        '- چکیده (excerpt) حداکثر ۲ جمله، ترغیب‌کننده',
        '- h1 متفاوت از title و دربردارندهٔ کلمهٔ کلیدی',
        '- هیچ عددی بدون سند؛ اگر عددی سند ندارد آن را نیاور',
        '- نام مکان خاص (پارک، معبد، جزیره، ساحل، هتل، رستوران، بازار) را فقط از واقعیت‌های تأییدشده یا دانش تیم بیاور؛ هرگز اسم مکان من‌درآوردی نساز (قانون مسعود: هیچ دادهٔ ساختگی)؛ اگر مطمئن نیستی کلی بگو',
        '- کاراکتر U+2014 (خط تیرهٔ بلند) مطلقاً ممنوع؛ از «؛» و «،» استفاده کن',
        '- لینک داخلی با قالب [[متن|/guide/اسلاگ]] یا [[متن|/tours/اسلاگ]] اگر مرتبط است (اختیاری)',
        '',
        'فقط JSON معتبر بده با کلیدهای: title, h1, excerpt, category, readingMinutes (عدد),',
        'sections (آرایه‌ای از {heading, paragraphs}), faqs (آرایه‌ای از {question, answer}).',
        'خروجی باید دقیقاً با { شروع و با } تمام شود. هیچ متن، توضیح یا کدفنس قبل و بعد از JSON ننویس.',
      ].join('\n'),
      { system: SYSTEM_WORKER, maxTokens: 4000 },
    );

    const draftError = validateDraft(draft);
    if (draftError) {
      throw new Error(`پیش‌نویس نامعتبر است: ${draftError}`);
    }

    // تمیزکاری نهایی فارسی روی همهٔ رشته‌ها (منطق فعلی)
    const cleanDraft: GuideDraft = {
      title: cleanFa(draft.title),
      h1: cleanFa(draft.h1),
      excerpt: cleanFa(draft.excerpt),
      category: cleanFa(draft.category || pick.category),
      readingMinutes: draft.readingMinutes,
      sections: draft.sections.map((s) => ({
        heading: cleanFa(s.heading),
        paragraphs: s.paragraphs.map((p) => cleanFa(p)),
      })),
      faqs: draft.faqs.map((f) => ({
        question: cleanFa(f.question),
        answer: cleanFa(f.answer),
      })),
    };

    return { pick, factsText, draft: cleanDraft };
  };

  /**
   * runCritic: منتقد فعلی، با تبدیل خروجی به CriticVerdictV2.
   * reason ← reason؛ instruction از reason استخراج می‌شود؛ acceptance اضافه می‌شود.
   * دور ۳: حق رد ندارد؛ فقط نظر نهایی.
   */
  const runCritic = async (
    output: WorkerRoundOutput,
    round: number,
  ): Promise<CriticVerdictV2> => {
    await reportLive?.(`منتقد: داوری متن (دور ${round})`, 80);
    const draft = output.draft;
    const draftText = [
      `تیتر: ${draft.title}`,
      `h1: ${draft.h1}`,
      `چکیده: ${draft.excerpt}`,
      ...draft.sections.flatMap((s) => [`## ${s.heading}`, ...s.paragraphs]),
      ...draft.faqs.flatMap((f) => [`س: ${f.question}`, `ج: ${f.answer}`]),
    ].join('\n\n');
    const verdict = await callLLMJson<CriticVerdict>(
      [
        'متن کامل راهنما:',
        draftText,
        '',
        'داوری کن. معیارها (هر کدام که نقض شود = رد):',
        '۱. فارسی طبیعی و انسانی است یا ماشینی و کلیشه‌ای؟ (اگر کلیشه‌ای است، رد کن)',
        '۲. کاراکتر U+2014 دارد؟ (اگر دارد، رد کن)',
        '۳. هر عدد سند دارد یا حدسی است؟ عدد حدسی = رد',
        '۴. برای مسافر واقعی کاربردی است یا حرف کلی می‌زند؟',
        '۵. هجی «کائو سوک» غلط است (درستش «خائو سوک» است)؛ اگر دیدی رد کن',
        '۶. نام مکان جعلی دارد؟ (پارک، معبد، جزیره، ساحل، هتل، رستوران با اسم خاصی که در واقعیت‌های تأییدشده یا دانش تیم نیست، یا به‌نظر من‌درآوردی می‌رسد)؛ اگر حتی یک اسم مشکوک دیدی، رد کن — قانون مسعود: هیچ دادهٔ ساختگی',
        '۷. سازگاری حسابگری: هر عدد، قیمت، تبدیل ارز و جمع‌بندی را خودت دوباره حساب کن؛ تناقض (جمعی که نمی‌خواند، تبدیل ارز غلط، بازهٔ بی‌معنا مثل «۶ تا ۱۴۰ هزار بات برای یک هفته») = رد قطعی',
        '۸. واقع‌نمایی قیمتِ نام‌برده: اگر رستوران/هتل/تور با اسم خاص و قیمتی که مشخصاً با واقعیت جور نیست (مثل رستوران لوکس با قیمت چندبرابر کمتر از نرخ واقعی منویش) آمد = رد قطعی؛ اگر از واقعیت قیمت مطمئن نیستی، رد کن، نه تأیید',
        '۹. راهنمای بودجه/هزینه بدون حتی یک عدد واقعی = رد قطعی (عنوان وعدهٔ عدد می‌دهد ولی متن عدد ندارد)',
        '۱۰. بریدگی: پاسخ نصفه یا قطع‌شده (سؤال FAQ بی‌جواب، بخش بی‌عنوان یا بی‌معنا) = رد',
        'قانون تأیید (یافتهٔ ممیزی C1: سهل‌گیری منتقد): approved=true فقط وقتی مجاز است که در reason این چک‌لیست را یک‌خطی تأیید کنی: «جعل مکان: ندارد | عددها: سنددار و سازگار | حسابگری: سازگار | بریدگی: ندارد». تأیید بدون این چک‌لیست نامعتبر است.',
        'فقط JSON معتبر بده: {"approved": true/false, "score": ۰ تا ۱۰۰, "reason": "یک جمله؛ در صورت تأیید حتماً با چک‌لیست قانون تأیید"}',
        CRITIC_SCORE_PROMPT_LINE,
        'خروجی باید دقیقاً با { شروع و با } تمام شود. هیچ متن، توضیح یا کدفنس قبل و بعد از JSON ننویس.',
      ].join('\n'),
      { system: SYSTEM_CRITIC },
    );
    const reason = String(verdict.reason || '').trim();
    const score = parseCriticScore(verdict.score) ?? undefined;

    if (round === 3) {
      return {
        approved: true,
        score,
        reason: '',
        instruction: '',
        acceptance: '',
        finalOpinion: reason || 'نظر نهایی ثبت شد.',
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
    // ضربان زنده پیش از ثبت دانش: extractCriticKnowledge کار دیتابیس و RAG
    // انجام می‌دهد و ممکن است دقایق طول بکشد؛ بدون این، نگهبان تیم را
    // «هنگ» اعلام می‌کند (یافته: تایم‌اوت ۱۵ دقیقه‌ای ورکر تیم content).
    await reportLive?.(`منتقد: ثبت دانش دور ${round}`, 85);
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
        domain: 'تولید محتوا',
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
    const msg = err instanceof Error ? err.message : String(err);
    blockers.push(`اجرای حلقه نقد ناموفق بود: ${msg}`);
    return { team: TEAM, summary: blockers[0], blockers, tasks: [], approved: false };
  }

  const { draft: cleanDraft, pick } = loopResult.output;
  const slug = cachedSlug;

  // گیت نهایی یکپارچه: همهٔ قوانین قطعی مسعود در کد (نه فقط پرامپت)
  const gateError = finalContentGate(JSON.stringify(cleanDraft));
  if (gateError) {
    blockers.push(gateError);
    return { team: TEAM, summary: gateError, blockers, tasks: [], approved: false };
  }

  // ۵. کدژن قطعی: ساخت آبجکت TS و درج در فایل (منطق فعلی)
  let newFileContent = '';
  try {
    const guideTs = buildGuideTs(
      {
        slug,
        title: pick.title,
        keyword: pick.keyword,
        angle: pick.angle,
        category: pick.category,
      },
      cleanDraft,
    );
    newFileContent = insertGuide(guidesFile, guideTs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    blockers.push(`ساخت پچ ناموفق بود: ${msg}`);
    return { team: TEAM, summary: blockers[0], blockers, tasks: [], approved: false };
  }

  patches.push({ path: GUIDES_PATH, content: newFileContent });

  // ثبت آموخته‌ها در حافظه (منطق فعلی، غنی‌شده با تاریخچه دورهای حلقه)
  // ضربان زنده پیش از نوشتن حافظه: عملیات دیتابیس ممکن است طول بکشد.
  // fail-soft: خطای دیتابیس نباید پچ آماده را بسوزاند.
  await reportLive?.('ثبت آموخته‌ها در حافظه', 95);
  try {
    await writeMemory({
      team: TEAM,
      key: `learned:${input.runId}`,
      value: JSON.stringify({
        slug,
        title: cleanDraft.title,
        approved: loopResult.approved,
        finalRound: loopResult.finalRound,
        rounds: loopResult.verdicts.map((v, i) => ({
          round: i + 1,
          approved: v.approved,
          reason: v.reason || v.finalOpinion || '',
        })),
        sectionsCount: cleanDraft.sections.length,
        faqsCount: cleanDraft.faqs.length,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    blockers.push(`ثبت حافظه ناموفق بود (پچ حفظ شد): ${msg}`);
  }

  const tasks: QueuedTask[] = [];
  const hadRejection = loopResult.verdicts.some((v) => !v.approved);
  if (hadRejection) {
    tasks.push({
      title: `بازبینی راهنمای «${cleanDraft.title}»`,
      description: `منتقد در دورهای اول متن را رد کرد و حلقه در دور ${loopResult.finalRound} با نظر نهایی تمام شد: ${loopResult.finalOpinion}. پچ ساخته شد ولی نیاز به بازبینی انسانی دارد.`,
      files_hint: GUIDES_PATH,
      priority: 'high',
    });
  }

  const summary =
    `راهنمای «${cleanDraft.title}» نوشته شد (${cleanDraft.sections.length} بخش، ${cleanDraft.faqs.length} سؤال متداول) و پچ آن آماده است. ` +
    `حلقه نقد در دور ${loopResult.finalRound} تمام شد. ` +
    `نظر نهایی منتقد: ${loopResult.finalOpinion}. ${lastKnowledgeLog}`;

  return {
    team: TEAM,
    summary,
    blockers,
    tasks: tasks.slice(0, 3),
    approved: loopResult.approved,
    patches,
  };
}
