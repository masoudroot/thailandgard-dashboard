/**
 * lib/teams/seo.ts: تیم سئو (seo)
 *
 * تیم «تولیدکنندهٔ واقعی» است، نه توصیه‌نویس:
 * در هر چرخه برای اسلاگ‌هایی که h1 مستقل ندارند، h1 واقعی می‌سازد و
 * متا تایتل/دیسکریپشن بهینه تولید می‌کند؛ خروجی به‌صورت PatchFile روی
 * فایل‌های site/lib/seo-h1.ts و site/lib/seo-meta.ts ریپوی سایت می‌نشیند.
 * لایهٔ پل (lib/bridge) پچ را روی شاخهٔ ai-bridge کامیت و PR می‌سازد.
 *
 * خط لوله:
 *   ۰. تحویل تسک صف ساخت از ragContext (اسلاگ‌های اجباری؛ بازتولید حتی
 *      اگر متای کهنه داشته باشند؛ پیش از هر تصمیم «کاری نیست»)
 *   ۱. خواندن اسلاگ‌های راهنماها، تورها و دسته‌بندی‌ها و h1های موجود از ریپوی سایت
 *   ۲. حلقه نقد ۳ دوره‌ای (lib/critic-loop.ts):
 *      دور ۱: سرپرست (انتخاب ۱ تا ۳ اسلاگ اولویت‌دار) ← مجری (h1+متا)
 *      دور ۲: منتقد داوری می‌کند؛ رد ← دستور دقیق ← مجری همان اسلاگ‌ها را اصلاح می‌کند
 *      دور ۳: فقط نظارت و نظر نهایی (حق رد ندارد)
 *   ۳. کدژن قطعی: درج در H1_OVERRIDES و META_OVERRIDES (بازنویسی برای اجباری‌ها)
 */

import type {
  ProgressReporter,
  QueuedTask,
  TeamName,
  TeamResult,
  PatchFile,
} from '../types';
import { callLLM, callLLMJson } from '../llm';
import { writeMemory } from '../memory';
import { buildKnowledgePromptSection } from '../rag';
import {
  extractCriticKnowledge,
  criticKnowledgeLog,
  type CriticRoundRecord,
} from '../knowledge/critic-knowledge';
import { readSiteFile } from '../bridge/read';
import { sanitizePersian, hasForbiddenDash, escapeTsString } from '../persian-text';
import {
  runCriticLoop,
  combineReviewDirectives,
  parseCriticScore,
  CRITIC_SCORE_PROMPT_LINE,
  type CriticLoopResult,
  type CriticVerdictV2,
} from '../critic-loop';

export const TEAM: TeamName = 'seo';

/** یک خط فارسی: مأموریت تیم سئو */
export const MISSION =
  'برای هر صفحهٔ سایت h1 مستقل و متا تگ بهینهٔ واقعی تولید می‌کند و در فایل‌های سئوی ریپوی سایت درج می‌کند.';

/** ورودی runTeam */
export interface SeoTeamInput {
  /** گزارش زنده‌ی پیشرفت به ارکستر؛ ارکستر همیشه آن را می‌دهد. */
  reportProgress?: ProgressReporter;
  /** شناسه اجرای جاری (برای کلید حافظه: learned:<runId>) */
  runId: string;
  /** خروجی تیم‌های موج‌های قبلی؛ خلاصه تیم محتوا از ['content'] خوانده می‌شود */
  previousWavesOutput?: Record<string, TeamResult | string>;
  /** دانش بازیابی‌شده از RAG (اختیاری) */
  knowledge?: string;
  /**
   * زمینهٔ کامل ارکستر (یافتهٔ ممیزی یکپارچگی: این فیلد پیش‌تر در ورودی
   * سئو نبود و تسک claimشده از صف ساخت بی‌صدا گم می‌شد؛ ارکستر آن را
   * «موفق» می‌بست در حالی که کاری انجام نشده بود).
   * ارکستر تسک claimشده را با قالب «کار تحویل‌شده از صف ساخت» و تسک‌های
   * تأییدشده را با «کارهای تأییدشدهٔ در انتظار» در همین رشته تزریق می‌کند.
   */
  ragContext?: string;
  /** شمارهٔ دور اجرای تیم (۱ = اجرای اول؛ ۲ = دور اصلاح پس از چک رهبر). */
  round?: number;
  /**
   * دستور مستقیم منتقد از حلقهٔ بیرونی ارکستراتور (همین چرخه)؛ بالاترین
   * اولویت را دارد و در ابتدای دستور مجری‌ها تزریق می‌شود.
   */
  reviewDirective?: string;
}

const GUIDES_PATH = 'site/lib/guides.ts';
/** منابع اسلاگ صفحات تور و دسته‌بندی‌ها (یافتهٔ ممیزی: پیش‌تر خوانده نمی‌شدند و بی‌صدا جا می‌ماندند). */
const TOURS_PATH = 'site/lib/tours.ts';
const TOUR_CATEGORIES_PATH = 'site/lib/tour-categories.ts';
const SEO_H1_PATH = 'site/lib/seo-h1.ts';
const SEO_META_PATH = 'site/lib/seo-meta.ts';

/** حداکثر اسلاگ در هر چرخه (حالت خودکار). */
const MAX_SLUGS_PER_CYCLE = 3;
/** سقف اسلاگ‌های اجباری از تسک صف (جلوگیری از فرار چرخه). */
const MAX_FORCED_SLUGS = 5;

/** نوع صفحه برای تولید متای متناسب با نیت جست‌وجو. */
type SeoPageType = 'guide' | 'tour' | 'category';

/** صفحات استاتیک شناخته‌شده: متایشان در page.tsx خودشان است، نه در نگاشت‌های سئو. */
const STATIC_PAGES: Array<{ id: string; title: string; matchers: RegExp[] }> = [
  { id: 'about', title: 'درباره تایلندگرد', matchers: [/درباره( ما)?/, /\babout\b/i] },
  { id: 'contact', title: 'تماس با تایلندگرد', matchers: [/تماس/, /\bcontact\b/i] },
];

/** یک صفحهٔ شناخته‌شدهٔ سایت با نوعش. */
interface SeoPage {
  slug: string;
  title: string;
  type: SeoPageType;
}

/** یک قلم خروجی سئو برای یک اسلاگ */
interface SeoItem {
  slug: string;
  /** نوع صفحه؛ لحن متا را متناسب با نیت جست‌وجو تنظیم می‌کند. */
  pageType: SeoPageType;
  title: string;
  h1: string;
  metaTitle: string;
  metaDescription: string;
  keyword: string;
}

interface CriticVerdict {
  approved: boolean;
  /** امتیاز کیفی منتقد (۰ تا ۱۰۰)؛ تعیین‌کننده نهایی: تأیید فقط با ≥ ۸۰. */
  score?: number;
  reason: string;
}

/** خروجی یک دور از مجری‌های حلقه نقد: اسلاگ‌های انتخاب‌شده + اقلام تولیدشده */
interface WorkerRoundOutput {
  slugs: string[];
  items: SeoItem[];
}

const SYSTEM_SUPERVISOR = 'تو سرپرست تیم سئوی تایلندگرد هستی.';
const SYSTEM_WORKER = 'تو متخصص سئوی فارسی تیم تایلندگرد هستی.';
const SYSTEM_CRITIC = 'تو منتقد سخت‌گیر تیم سئو هستی.';

/** استخراج جفت‌های slug/title از فایل guides.ts */
function extractGuides(fileContent: string): Array<{ slug: string; title: string }> {
  const out: Array<{ slug: string; title: string }> = [];
  const re = /slug:\s*"([^"]+)"[\s\S]*?title:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fileContent)) !== null) {
    out.push({ slug: m[1], title: m[2].replace(/\\"/g, '"') });
  }
  return out;
}

/** استخراج کلیدهای H1_OVERRIDES */
function extractH1Keys(fileContent: string): string[] {
  const keys: string[] = [];
  const mapMatch = fileContent.match(/H1_OVERRIDES[^=]*=\s*\{([\s\S]*?)\n\};/);
  const body = mapMatch ? mapMatch[1] : fileContent;
  const re = /"([^"]+)"\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    keys.push(m[1]);
  }
  return keys;
}

/** استخراج کلیدهای META_OVERRIDES (اگر فایل هست) */
function extractMetaKeys(fileContent: string | null): string[] {
  if (!fileContent) return [];
  const keys: string[] = [];
  const mapMatch = fileContent.match(/META_OVERRIDES[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (!mapMatch) return [];
  const re = /"([^"]+)"\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(mapMatch[1])) !== null) {
    keys.push(m[1]);
  }
  return keys;
}

/**
 * استخراج جفت‌های slug/title از فایل tours.ts (ساختار دقیق فایل سایت ممکن
 * است فرق کند؛ پس تحمل‌پذیر: برای هر slug نزدیک‌ترین title یا name را
 * در پنجرهٔ ۸۰۰ نویسه‌ای جلو/عقب پیدا می‌کند).
 */
function extractTours(
  fileContent: string,
): Array<{ slug: string; title: string }> {
  const out: Array<{ slug: string; title: string }> = [];
  const seen = new Set<string>();
  const slugRe = /slug:\s*"([a-z0-9-]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = slugRe.exec(fileContent)) !== null) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const fwd = fileContent.slice(m.index, m.index + 800);
    const back = fileContent.slice(Math.max(0, m.index - 800), m.index);
    const titleRe = /(?:title|name):\s*"((?:[^"\\]|\\.)*)"/;
    const tm = titleRe.exec(fwd) ?? titleRe.exec(back);
    const title = tm ? tm[1].replace(/\\"/g, '"') : slug;
    out.push({ slug, title });
  }
  return out;
}

/**
 * استخراج اسلاگ دسته‌بندی‌های تور (best-effort؛ اگر فایل یا ساختار عوض
 * شده باشد، خالی برمی‌گرداند و چرخه با راهنماها/تورها ادامه می‌دهد).
 */
function extractCategorySlugs(fileContent: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /slug:\s*"([a-z0-9-]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fileContent)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

/* ==========================================================================
 * خواندن تسک‌های صف ساخت از ragContext
 *
 * ارکستر تسک claimشده را با این قالب تزریق می‌کند:
 *   کار تحویل‌شده از صف ساخت (در اولویت اجرا):
 *   عنوان: ...
 *   شرح: ...
 *   معیار قبولی: ...
 * و تسک‌های تأییدشده را با «کارهای تأییدشدهٔ در انتظار این تیم» و خط‌های
 * «- عنوان: شرح». سئو پیش‌تر ragContext را نداشت و این تسک‌ها بی‌صدا گم
 * می‌شدند (ارکستر آن‌ها را «موفق» می‌بست در حالی که کاری انجام نشده بود).
 * ========================================================================== */

/** تسک claimشده از صف ساخت. */
interface ClaimedSeoTask {
  title: string;
  description: string;
  acceptance: string;
}

/** استخراج تسک claimشده از ragContext. */
function parseClaimedSeoTask(ragContext: string | undefined): ClaimedSeoTask | null {
  if (!ragContext) return null;
  const after = ragContext.split('کار تحویل‌شده از صف ساخت')[1];
  if (!after) return null;
  const block = after
    .split('کارهای تأییدشدهٔ در انتظار')[0]
    .split('دانش ذخیره‌شده')[0];
  const title = /عنوان:\s*([^\n]+)/.exec(block)?.[1]?.trim() ?? '';
  if (!title) return null;
  const descMatch = /شرح:\s*([\s\S]*?)(?=\nمعیار قبولی:|$)/.exec(block);
  const acceptance = /معیار قبولی:\s*([^\n]+)/.exec(block)?.[1]?.trim() ?? '';
  return { title, description: (descMatch?.[1] ?? '').trim(), acceptance };
}

/** استخراج تسک‌های تأییدشدهٔ در انتظار (خط‌های «- عنوان: شرح»). */
function parseApprovedSeoTasks(
  ragContext: string | undefined,
): Array<{ title: string; description: string }> {
  if (!ragContext) return [];
  const after = ragContext.split('کارهای تأییدشدهٔ در انتظار')[1];
  if (!after) return [];
  const block = after.split('دانش ذخیره‌شده')[0];
  const out: Array<{ title: string; description: string }> = [];
  const re = /^-\s*([^:\n]{2,200}):\s*([^\n]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    out.push({ title: m[1].trim(), description: m[2].trim() });
  }
  return out;
}

/**
 * دستور رهبر برای دور اصلاح که ارکستر در ابتدای ragContext تزریق می‌کند
 * («دستور رهبر برای دور اصلاح (خروجی دور قبل رد شد): ...»).
 * اگر input.reviewDirective به هر دلیلی نرسیده باشد، این پس‌زدگی (fallback)
 * همان دستور را از ragContext برمی‌گرداند.
 */
function parseDirectivePrefix(ragContext: string | undefined): string | undefined {
  if (!ragContext) return undefined;
  const m = /دستور رهبر برای دور اصلاح[^\n]*\n([\s\S]*?)(?=\n\n|$)/.exec(ragContext);
  const d = m?.[1]?.trim();
  return d ? d : undefined;
}

/** نتیجهٔ تفکیک اسلاگ‌های هدف تسک. */
interface TargetSlugs {
  /** اسلاگ‌های شناخته‌شده (راهنما/تور/دسته)؛ بازتولید اجباری. */
  forced: string[];
  /** صفحات استاتیک هدف (متا در page.tsx خودشان؛ در پچ نمی‌نشینند). */
  staticTargets: string[];
  /** اسلاگ‌های صریح «اسلاگ: xxx» که در هیچ منبعی پیدا نشدند (گزارش صادقانه، نه سکوت). */
  unknown: string[];
}

/**
 * استخراج اسلاگ‌های هدف از عنوان/شرح تسک‌ها.
 * - خط صریح «اسلاگ: xxx» بالاترین اعتبار را دارد؛
 * - توکن‌های اسلاگ‌مانند فقط وقتی قبول‌اند که در اسلاگ‌های شناخته‌شده باشند
 *   (تا کلمات انگلیسی متن، هدف کاذب نسازند).
 */
function extractTargetSlugs(
  texts: string[],
  knownSlugs: Set<string>,
): TargetSlugs {
  const forced = new Set<string>();
  const staticTargets = new Set<string>();
  const unknown = new Set<string>();
  for (const t of texts) {
    const explicitRe = /اسلاگ:\s*([a-z0-9-]+)/g;
    let m: RegExpExecArray | null;
    while ((m = explicitRe.exec(t)) !== null) {
      const s = m[1];
      if (knownSlugs.has(s)) forced.add(s);
      else unknown.add(s);
    }
    const tokens = t.match(/[a-z0-9][a-z0-9-]{1,79}/g) ?? [];
    for (const tok of tokens) {
      if (knownSlugs.has(tok)) forced.add(tok);
    }
    for (const sp of STATIC_PAGES) {
      if (sp.matchers.some((rx) => rx.test(t))) staticTargets.add(sp.id);
    }
  }
  return { forced: [...forced], staticTargets: [...staticTargets], unknown: [...unknown] };
}

/** خلاصه تیم محتوا از خروجی موج‌های قبلی */
function getContentSummary(
  previousWavesOutput: SeoTeamInput['previousWavesOutput'],
): string {
  const content = previousWavesOutput?.['content'];
  if (!content) return '(خلاصه‌ای از تیم محتوا در دسترس نیست)';
  if (typeof content === 'string') return content;
  return content.summary || '(خلاصه‌ای از تیم محتوا در دسترس نیست)';
}

/**
 * درج ورودی‌های تازه در نگاشت H1_OVERRIDES.
 * نقطهٔ درج: «};» پایانی نگاشت، پیش از کامنت «قاعدهٔ مشتق‌سازی».
 * پس‌زدگی: اگر ساختار فایل عوض شده باشد (نشانگر نیست)، درج پیش از آخرین
 * «};» فایل انجام می‌شود تا تیم به‌جای بلاکر، پچ سالم بسازد.
 */
function insertH1Overrides(fileContent: string, items: SeoItem[]): string {
  const marker = '/** قاعدهٔ مشتق‌سازی';
  const markerIdx = fileContent.indexOf(marker);
  let closeIdx: number;
  if (markerIdx >= 0) {
    closeIdx = fileContent.lastIndexOf('};', markerIdx);
  } else {
    console.warn('[seo] نشانگر درج seo-h1.ts پیدا نشد؛ درج پیش از آخرین «};» انجام شد.');
    closeIdx = fileContent.lastIndexOf('};');
  }
  if (closeIdx < 0) {
    throw new Error('پایان نگاشت H1_OVERRIDES پیدا نشد.');
  }
  const entries = items
    .map(
      (it) =>
        `  "${it.slug}": "${escapeTsString(sanitizePersian(it.h1))}",`,
    )
    .join('\n');
  const comment = `  // سئو (اجرای خودکار): h1 مستقل برای اسلاگ‌های تازه`;
  return (
    fileContent.slice(0, closeIdx) +
    `\n${comment}\n${entries}\n` +
    fileContent.slice(closeIdx)
  );
}

/** قالب کامل فایل seo-meta.ts وقتی هنوز وجود ندارد. */
function buildSeoMetaFile(items: SeoItem[]): string {
  const entries = items
    .map(
      (it) =>
        `  "${it.slug}": {\n` +
        `    title: "${escapeTsString(sanitizePersian(it.metaTitle))}",\n` +
        `    description: "${escapeTsString(sanitizePersian(it.metaDescription))}",\n` +
        `  },`,
    )
    .join('\n');
  return `/**
 * نگاشت سراسری slug ← متا تایتل/دیسکریپشن بهینه (تولید تیم seo).
 *
 * قاعده: هر صفحه که ورودی اختصاصی ندارد، همان تایتل/دیسکریپشن مشتق از
 * محتوای دیتابیس می‌ماند؛ با نشستن ورودی در این جدول، همان صفحه خودکار
 * متای بهینه می‌گیرد و کد دست نمی‌خورد.
 *
 * اتصال (یک خط در generateMetadata هر صفحه):
 *   import { resolveMeta } from "@/lib/seo-meta";
 *   const meta = resolveMeta(slug, { title: fallbackTitle, description: fallbackDescription });
 *
 * قراردادها (داوری خودکار تیم seo):
 * - تایتل ۵۰ تا ۶۰ نویسه، با کلمهٔ کلیدی در ابتدا؛ پسوند برند «| تایلندگرد» جدا می‌نشیند
 * - دیسکریپشن ۱۲۰ تا ۱۶۰ نویسه، فارسی طبیعی، با فراخوان عمل ملایم
 * - خط تیرهٔ بلند (U+2014) مطلقاً ممنوع
 */

export interface MetaOverride {
  title: string;
  description: string;
}

const META_OVERRIDES: Record<string, MetaOverride> = {
${entries}
};

/** متای نهایی یک اسلاگ: ورودی اختصاصی، وگرنه همان مقادیر پیش‌فرض. */
export function resolveMeta(
  slug: string,
  fallback: MetaOverride,
): MetaOverride {
  return META_OVERRIDES[slug] ?? fallback;
}
`;
}

/**
 * درج ورودی‌های تازه در نگاشت META_OVERRIDES فایل موجود.
 * پس‌زدگی: اگر تابع resolveMeta در فایل نیست (ساختار عوض شده)، درج پیش
 * از آخرین «};» انجام می‌شود.
 */
function insertMetaOverrides(fileContent: string, items: SeoItem[]): string {
  const markerIdx = fileContent.indexOf('export function resolveMeta');
  let closeIdx: number;
  if (markerIdx >= 0) {
    closeIdx = fileContent.lastIndexOf('};', markerIdx);
  } else {
    console.warn('[seo] نشانگر درج seo-meta.ts پیدا نشد؛ درج پیش از آخرین «};» انجام شد.');
    closeIdx = fileContent.lastIndexOf('};');
  }
  if (closeIdx < 0) {
    throw new Error('پایان نگاشت META_OVERRIDES پیدا نشد.');
  }
  const entries = items
    .map(
      (it) =>
        `  "${it.slug}": {\n` +
        `    title: "${escapeTsString(sanitizePersian(it.metaTitle))}",\n` +
        `    description: "${escapeTsString(sanitizePersian(it.metaDescription))}",\n` +
        `  },`,
    )
    .join('\n');
  return (
    fileContent.slice(0, closeIdx) + `\n${entries}\n` + fileContent.slice(closeIdx)
  );
}

/**
 * حذف ورودی‌های موجود اسلاگ‌های اجباری از H1_OVERRIDES پیش از درج تازه
 * (بازنویسی متای کهنه، نه تکرار کلید).
 */
function removeH1Entries(fileContent: string, slugs: Set<string>): string {
  if (slugs.size === 0) return fileContent;
  return fileContent
    .split('\n')
    .filter((line) => {
      const m = /^\s*"([^"]+)"\s*:/.exec(line);
      return !(m && slugs.has(m[1]));
    })
    .join('\n');
}

/**
 * حذف بلوک‌های موجود اسلاگ‌های اجباری از META_OVERRIDES پیش از درج تازه.
 * بلوک هر اسلاگ چندخطی است: "slug": { title: ..., description: ..., },
 */
function removeMetaEntries(fileContent: string, slugs: Set<string>): string {
  if (slugs.size === 0) return fileContent;
  const lines = fileContent.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^\s*"([^"]+)"\s*:\s*\{\s*$/.exec(lines[i]);
    if (m && slugs.has(m[1])) {
      i += 1;
      while (i < lines.length && !/^\s*\},?\s*$/.test(lines[i])) i += 1;
      i += 1; // خط بستن بلوک هم رد شود
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }
  return out.join('\n');
}

/** اعتبارسنجی قلم سئو پیش از داوری. */
function validateItem(it: SeoItem, title: string): string | null {
  if (!it.slug) return 'اسلاگ خالی است.';
  if (!it.h1 || it.h1 === title) return `h1 برای ${it.slug} با تایتل یکی است یا خالی است.`;
  if (it.h1.length > 60) return `h1 برای ${it.slug} بیش از ۶۰ نویسه است.`;
  if (!it.metaTitle || it.metaTitle.length < 30 || it.metaTitle.length > 70)
    return `متا تایتل ${it.slug} باید ۳۰ تا ۷۰ نویسه باشد.`;
  if (!it.metaDescription || it.metaDescription.length < 100 || it.metaDescription.length > 170)
    return `متا دیسکریپشن ${it.slug} باید ۱۰۰ تا ۱۷۰ نویسه باشد.`;
  if (hasForbiddenDash(it.h1 + it.metaTitle + it.metaDescription))
    return `خروجی ${it.slug} خط تیرهٔ ممنوعه دارد.`;
  return null;
}

/**
 * تبدیل دلیل ردِ منتقد قدیمی به دستور اجرایی (CriticVerdictV2.instruction).
 * امری و بلندتر از ۵۰ نویسه تا از اعتبارسنجی حلقه رد شود.
 */
function criticInstructionFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی سئو ایراد دارد';
  return [
    `خروجی سئو را بر اساس این نقد اصلاح کن: «${r}»`,
    'برای هر اسلاگ دوباره بنویس: h1 را واقعاً از تایتل جدا و متفاوت بنویس؛',
    'متا تایتل را ۵۰ تا ۶۰ نویسه با کلمهٔ کلیدی در ابتدا بنویس؛',
    'متا دیسکریپشن را ۱۲۰ تا ۱۶۰ نویسه، فارسی طبیعی و با فراخوان عمل ملایم بنویس؛',
    'هیچ کاراکتر U+2014 نیاور و از کلیک‌بیت گمراه‌کننده استفاده نکن.',
  ].join(' ');
}

/**
 * تبدیل دلیل رد به معیار قبولی (CriticVerdictV2.acceptance).
 */
function criticAcceptanceFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی سئو ایراد دارد';
  return `وقتی درست است که نقد «${r}» دیگر دربارهٔ خروجی صدق نکند و برای هر اسلاگ: h1 از تایتل جدا باشد، متا تایتل ۵۰ تا ۶۰ نویسه، دیسکریپشن ۱۲۰ تا ۱۶۰ نویسه، فارسی طبیعی و بدون U+2014 باشد.`;
}
/**
 * اجرای تیم سئو برای یک چرخه: تولید h1 و متا تگ واقعی + پچ.
 * (مهاجرت به حلقه نقد ۳ دوره‌ای lib/critic-loop.ts)
 */
export async function runTeam(input: SeoTeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;
  const { runId, previousWavesOutput, knowledge } = input;
  const blockers: string[] = [];
  const patches: PatchFile[] = [];

  let knowledgeSection = '';
  try {
    knowledgeSection = await buildKnowledgePromptSection(TEAM, MISSION);
  } catch {
    knowledgeSection = '';
  }
  const knowledgeText = knowledge?.trim() || '';
  const combinedKnowledge = [knowledgeSection, knowledgeText].filter(Boolean).join('\n\n');
  const contentSummary = getContentSummary(previousWavesOutput);

  // ۰. خواندن وضعیت جاری سئوی سایت (راهنماها + تورها + دسته‌بندی‌ها)
  await reportLive?.('خواندن وضعیت سئوی سایت', 5);
  let guidesFile: string | null = null;
  let h1File: string | null = null;
  let metaFile: string | null = null;
  let toursFile: string | null = null;
  let categoriesFile: string | null = null;
  try {
    [guidesFile, h1File] = await Promise.all([
      readSiteFile(GUIDES_PATH),
      readSiteFile(SEO_H1_PATH),
    ]);
    metaFile = await readSiteFile(SEO_META_PATH).catch(() => null);
    // تورها و دسته‌بندی‌ها fail-soft: اگر فایل نیست، چرخه با راهنماها ادامه می‌دهد.
    toursFile = await readSiteFile(TOURS_PATH).catch(() => null);
    categoriesFile = await readSiteFile(TOUR_CATEGORIES_PATH).catch(() => null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    blockers.push(`خواندن فایل‌های سئو از ریپوی سایت ناموفق بود: ${msg}`);
    return { team: TEAM, summary: blockers[0], blockers, tasks: [], approved: false };
  }
  if (!guidesFile || !h1File) {
    blockers.push('فایل‌های guides.ts یا seo-h1.ts در ریپوی سایت پیدا نشد.');
    return { team: TEAM, summary: blockers[0], blockers, tasks: [], approved: false };
  }

  // فهرست یکپارچهٔ صفحات شناخته‌شده با نوعشان (راهنما/تور/دسته)
  const pages: SeoPage[] = [];
  const seenPage = new Set<string>();
  const addPage = (slug: string, title: string, type: SeoPageType) => {
    if (!slug || seenPage.has(slug)) return;
    seenPage.add(slug);
    pages.push({ slug, title: title || slug, type });
  };
  for (const g of extractGuides(guidesFile)) addPage(g.slug, g.title, 'guide');
  if (toursFile) {
    for (const t of extractTours(toursFile)) addPage(t.slug, t.title, 'tour');
  }
  if (categoriesFile) {
    for (const s of extractCategorySlugs(categoriesFile)) addPage(s, s, 'category');
  }
  const knownSlugs = new Set(pages.map((p) => p.slug));
  const pageBySlug = new Map(pages.map((p) => [p.slug, p]));

  const h1Keys = new Set(extractH1Keys(h1File));
  const metaKeys = new Set(extractMetaKeys(metaFile));
  const missing = pages.filter((p) => !h1Keys.has(p.slug) || !metaKeys.has(p.slug));

  // ---------- تحویل تسک‌های صف ساخت (پیش از هر تصمیم «کاری نیست») ----------
  // ارکستر تسک claimشده و تسک‌های تأییدشده را در ragContext تزریق می‌کند.
  // اسلاگ‌های هدف این تسک‌ها «اجباری»‌اند: حتی اگر متای کهنه داشته باشند،
  // بازتولید می‌شوند (حذف ورودی قدیمی + درج تازه).
  const claimedTask = parseClaimedSeoTask(input.ragContext);
  const approvedTasks = parseApprovedSeoTasks(input.ragContext);
  const taskTexts = [
    ...(claimedTask ? [`${claimedTask.title}\n${claimedTask.description}`] : []),
    ...approvedTasks.map((t) => `${t.title}\n${t.description}`),
  ];
  const targets = extractTargetSlugs(taskTexts, knownSlugs);
  const forcedSlugs = targets.forced.slice(0, MAX_FORCED_SLUGS);
  const forcedSet = new Set(forcedSlugs);
  const outerDirective =
    (input.reviewDirective ?? '').trim() ||
    parseDirectivePrefix(input.ragContext) ||
    undefined;
  if (claimedTask) {
    await reportLive?.(`تسک صف دریافت شد: ${claimedTask.title}`, 8);
  }

  if (missing.length === 0 && forcedSlugs.length === 0) {
    // حتی در حالت «کاری نیست»، سرنوشت تسک صف باید صادقانه گزارش شود؛
    // وگرنه ارکستر آن را «موفق» می‌بندد در حالی که هیچ کاری نشده.
    const noopNotes: string[] = [];
    if (claimedTask) {
      noopNotes.push(`تسک صف «${claimedTask.title}» هیچ اسلاگ شناخته‌شده‌ای نداشت؛ کاری برای آن انجام نشد.`);
    }
    if (targets.unknown.length > 0) {
      noopNotes.push(`اسلاگ‌های ناشناخته در تسک: ${targets.unknown.join('، ')}.`);
    }
    if (targets.staticTargets.length > 0) {
      noopNotes.push(
        `صفحات استاتیک هدف (${targets.staticTargets.join('، ')}) متایشان در page.tsx خودشان است؛ در حوزهٔ نگاشت‌های سئو نیستند.`,
      );
    }
    const summary =
      'همهٔ صفحه‌ها h1 و متا تگ اختصاصی دارند و اسلاگ اجباری تازه‌ای از صف نیامده؛ کاری برای این چرخه نبود.' +
      (noopNotes.length > 0 ? ' ' + noopNotes.join(' ') : '');
    await writeMemory({ team: TEAM, key: `learned:${runId}`, value: JSON.stringify({ noop: true, claimedTask: claimedTask?.title ?? null }) });
    return { team: TEAM, summary, blockers: [], tasks: [], approved: true };
  }

  // ---------- توابع حلقه نقد ----------

  // کش دور ۱: اسلاگ‌های انتخاب‌شده در هر چرخه یک بار ساخته می‌شوند؛
  // دورهای ۲ و ۳ همان اسلاگ‌ها را با دستور منتقد اصلاح می‌کنند.
  let cachedSlugs: string[] = [];

  /**
   * تولید h1 + متا برای هر اسلاگ (منطق فعلی مجری، بدون تغییر).
   * در دور ۲/۳ دستور منتقد (prevInstruction) به پرامپت تزریق می‌شود.
   */
  const generateSeoItems = async (
    slugs: string[],
    prevInstruction?: string,
  ): Promise<SeoItem[]> => {
    const items: SeoItem[] = [];
    const skipped: string[] = [];
    for (const slug of slugs) {
      // ضربان زنده در هر اسلاگ: حلقه LLM ممکن است دقایق طول بکشد؛ بدون این،
      // نگهبان تیم را «هنگ» اعلام می‌کند (یافته: تایم‌اوت ۱۵ دقیقه‌ای ورکر).
      await reportLive?.(`مجری: تولید سئو برای ${slug}`, 60);
      const page = pageBySlug.get(slug);
      if (!page) {
        // دیگر سکوت نمی‌کنیم: اسلاگ ناشناخته در خلاصه گزارش می‌شود تا تسک
        // صف با «موفق» کاذب بسته نشود.
        skipped.push(slug);
        continue;
      }
      // لحن متا متناسب با نیت جست‌وجوی نوع صفحه.
      const typeHint =
        page.type === 'tour'
          ? 'نوع صفحه: تور (نیت تراکنشی). متا تایتل و دیسکریپشن باید حس «رزرو/قیمت/برنامه سفر» بدهند ولی صادقانه بمانند؛ از ادعای قیمت مشخص خودداری کن.'
          : page.type === 'category'
            ? 'نوع صفحه: دسته‌بندی تورها (نیت مرور و مقایسه). متا باید دامنهٔ انتخاب‌ها را نشان بدهد، نه یک تور خاص.'
            : 'نوع صفحه: راهنمای آموزشی (نیت اطلاعاتی). متا باید وعدهٔ پاسخ کامل و کاربردی بدهد.';
      // ریشه‌ی باگ: خطای یک اسلاگ (مثلاً JSON نامعتبر پس از ۳ تلاش روی همه‌ی
      // مدل‌ها) کل تیم را می‌کشت. حالا هر اسلاگ جداگانه تاب می‌آورد؛ اگر همه
      // مردند، runWorkers پایین‌تر با پیام واضح خطا می‌دهد.
      let rawItem: SeoItem | null;
      try {
        rawItem = await callLLMJson<SeoItem>(
        [
          ...(prevInstruction
            ? ['دستور منتقد برای اصلاح این دور (حتماً رعایت کن):', prevInstruction, '']
            : []),
          `اسلاگ: ${slug}`,
          `تیتر صفحه: ${page.title}`,
          typeHint,
          '',
          'برای این صفحه تولید کن:',
          '۱. h1: مستقل از تایتل، دربردارندهٔ کلمهٔ کلیدی اصلی، حداکثر ۶۰ نویسه، فارسی طبیعی. ممنوع: لحن کلیک‌بیت، اغراق، صفت‌های توخالی («بهترین»، «فوق‌العاده»، «بی‌نظیر»). h1 باید توصیفی و دقیق باشد، نه تبلیغاتی.',
          '۲. metaTitle: ۵۰ تا ۶۰ نویسه برای SERP، کلمهٔ کلیدی در ابتدا، ترغیب‌کننده (بدون پسوند برند؛ برند جدا اضافه می‌شود). اگر سال می‌آوری (مثل ۱۴۰۴)، فقط وقتی مجاز است که محتوای صفحه واقعاً برای همان سال به‌روز شده باشد؛ سالِ بدون به‌روزرسانی = گمراه‌کننده و رد.',
          '۳. metaDescription: ۱۲۰ تا ۱۶۰ نویسه، فارسی طبیعی، خلاصهٔ مفید + فراخوان ملایم. ممنوع: لحن دستوری و امری («همین حالا رزرو کنید»، «از دست ندهید»). دیسکریپشن باید «توصیفی» باشد نه «امری»؛ مثل یک معرفی کوتاه و صادقانه.',
          '۴. keyword: کلمهٔ کلیدی اصلی صفحه',
          '',
          'قوانین: کاراکتر U+2014 مطلقاً ممنوع. هیچ تکنیک خاکستری. فقط واقعیت.',
          // ریشه‌ی باگ JSON: مدل گاهی داخل مقادیر از " انگلیسی استفاده می‌کند و
          // JSON می‌شکند. قانون صریح: داخل مقادیر هرگز " نیاور؛ اگر نقل‌قول لازم
          // شد از «» فارسی استفاده کن.
          'مهم: داخل هیچ‌یک از مقادیر، نویسهٔ " (دابل‌کوتیشن انگلیسی) به کار نبر؛ به‌جای آن از «» استفاده کن.',
          'فقط JSON معتبر بده: {"slug": "...", "title": "...", "h1": "...", "metaTitle": "...", "metaDescription": "...", "keyword": "..."}',
          'خروجی باید دقیقاً با { شروع و با } تمام شود. هیچ متن، توضیح یا کدفنس قبل و بعد از JSON ننویس.',
        ].join('\n'),
        // فارسی توکن‌بر است؛ ۸۰۰ توکن خروجی را وسط JSON می‌برید (ریشه‌ی بریدگی).
        { system: SYSTEM_WORKER, temperature: 0.5, maxTokens: 1500 },
      );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[seo] تولید سئو برای اسلاگ ${slug} پس از همه‌ی تلاش‌ها ناموفق بود: ${msg.slice(0, 150)}`);
        continue;
      }
      // خروجی LLM ممکن است آبجکت نباشد (مثلاً عدد)؛ قبل از مقداردهی اعتبارسنجی می‌کنیم
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
        console.warn(`[seo] خروجی نامعتبر LLM برای اسلاگ ${slug}:`, String(rawItem).slice(0, 100));
        continue;
      }
      const item: SeoItem = rawItem;
      item.slug = slug;
      item.pageType = page.type;
      item.title = page.title;
      item.h1 = sanitizePersian(item.h1);
      item.metaTitle = sanitizePersian(item.metaTitle);
      item.metaDescription = sanitizePersian(item.metaDescription);
      const err = validateItem(item, page.title);
      if (err) {
        console.warn(`[seo] قلم نامعتبر برای اسلاگ ${slug}: ${err}`);
        continue;
      }
      items.push(item);
    }
    if (skipped.length > 0) {
      console.warn(`[seo] اسلاگ‌های ناشناخته رد شدند (در هیچ منبع صفحه‌ای نیستند): ${skipped.join('، ')}`);
    }
    return items;
  };

  /**
   * runWorkers: سرپرست (دور ۱) + مجری هر دور.
   * دور ۱: اگر تسک صف اسلاگ اجباری داده، همان‌ها (بدون انتخاب سرپرست)؛
   *        وگرنه سرپرست ۱ تا ۳ اسلاگ اولویت‌دار انتخاب می‌کند؛
   * دور ۲/۳: تولید دوبارهٔ همان اسلاگ‌ها با دستور منتقد.
   */
  const runWorkers = async (
    round: number,
    prevInstruction?: string,
  ): Promise<WorkerRoundOutput> => {
    if (round === 1) {
      if (forcedSlugs.length > 0) {
        // تسک صف بالاترین اولویت را دارد؛ سرپرست دور زده می‌شود تا دقیقاً
        // همان اسلاگ‌های خواسته‌شده کار شوند، نه حدس تازه.
        await reportLive?.(`تسک صف: بازتولید سئو برای ${forcedSlugs.length} اسلاگ اجباری`, 20);
        cachedSlugs = forcedSlugs;
      } else {
        // سرپرست: انتخاب ۱ تا ۳ اسلاگ اولویت‌دار
        await reportLive?.('سرپرست: انتخاب اسلاگ‌ها', 20);
        const typeLabel = (t: SeoPageType) =>
          t === 'tour' ? 'تور' : t === 'category' ? 'دسته' : 'راهنما';
        const candidates = missing
          .slice(0, 12)
          .map((p) => `- ${p.slug} [${typeLabel(p.type)}]: ${p.title}`)
          .join('\n');
        const pickRaw = await callLLM(
          [
            ...(outerDirective
              ? [
                  'دستور رهبر برای این دور (حتماً در انتخاب اسلاگ رعایت کن):',
                  outerDirective,
                  '',
                ]
              : []),
            'اسلاگ‌های بدون h1/متای اختصاصی:',
            candidates,
            '',
            'خلاصه تیم محتوا:',
            contentSummary,
            '',
            combinedKnowledge ? `دانش:\n${combinedKnowledge}\n` : '',
            `حداکثر ${MAX_SLUGS_PER_CYCLE} اسلاگ پراولویت (تازه‌ها و پرترافیک‌ها اول) انتخاب کن.`,
            'فقط JSON معتبر بده: {"slugs": ["slug-1", "slug-2"]}',
            'خروجی باید دقیقاً با { شروع و با } تمام شود. هیچ متن، توضیح یا کدفنس قبل و بعد از JSON ننویس.',
          ].join('\n'),
          { system: SYSTEM_SUPERVISOR, temperature: 0.3 },
        );
        let slugs: string[] = [];
        try {
          const parsed = JSON.parse(pickRaw.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as { slugs?: string[] };
          slugs = (Array.isArray(parsed.slugs) ? parsed.slugs : [])
            .map((s) => String(s).trim())
            .filter((s) => missing.some((m) => m.slug === s))
            .slice(0, MAX_SLUGS_PER_CYCLE);
        } catch {
          slugs = [];
        }
        if (slugs.length === 0) {
          slugs = missing.slice(0, Math.min(2, missing.length)).map((m) => m.slug);
        }
        cachedSlugs = slugs;
      }
    } else {
      await reportLive?.(`دور ${round}: اصلاح با دستور منتقد`, 50);
    }

    const slugs = cachedSlugs;
    if (slugs.length === 0) {
      throw new Error('اسلاگی برای تولید سئو در کش پیدا نشد.');
    }

    await reportLive?.('مجری: تولید h1 و متا تگ', 60);
    const items = await generateSeoItems(
      slugs,
      combineReviewDirectives(outerDirective, prevInstruction),
    );
    if (items.length === 0) {
      throw new Error('هیچ قلم سئوی معتبری در این دور تولید نشد.');
    }
    return { slugs, items };
  };

  /**
   * runCritic: منتقد فعلی، با تبدیل خروجی به CriticVerdictV2.
   * دور ۳: حق رد ندارد؛ فقط نظر نهایی.
   */
  const runCritic = async (
    output: WorkerRoundOutput,
    round: number,
  ): Promise<CriticVerdictV2> => {
    await reportLive?.(`منتقد: داوری خروجی (دور ${round})`, 80);
    const verdict = await callLLMJson<CriticVerdict>(
      [
        'خروجی سئو:',
        ...output.items.flatMap((it) => [
          `اسلاگ: ${it.slug} (نوع صفحه: ${it.pageType === 'tour' ? 'تور' : it.pageType === 'category' ? 'دسته‌بندی' : 'راهنما'})`,
          `تیتر: ${it.title}`,
          `h1: ${it.h1}`,
          `متا تایتل: ${it.metaTitle}`,
          `متا دیسکریپشن: ${it.metaDescription}`,
          '',
        ]),
        'داوری کن. معیارها: h1 واقعاً از تایتل جداست؟ طول‌ها در بازه‌اند؟ فارسی طبیعی است؟ خط تیرهٔ بلند ندارد؟ کلیک‌بیت گمراه‌کننده نیست؟',
        'فقط JSON معتبر بده: {"approved": true/false, "score": ۰ تا ۱۰۰, "reason": "یک جمله"}',
        CRITIC_SCORE_PROMPT_LINE,
        'خروجی باید دقیقاً با { شروع و با } تمام شود. هیچ متن، توضیح یا کدفنس قبل و بعد از JSON ننویس.',
      ].join('\n'),
      { system: SYSTEM_CRITIC, temperature: 0.2 },
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
        domain: 'سئوی تکنیکال',
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
    blockers.push(`اجرای حلقه نقد ناموفق بود: ${msg}`);
    return { team: TEAM, summary: blockers[0], blockers, tasks: [], approved: false };
  }

  const items = loopResult.output.items;

  // کدژن قطعی: پچ h1 و پچ متا.
  // - اسلاگ‌های اجباری (تسک صف): بازنویسی؛ ورودی کهنه حذف و تازه درج می‌شود
  //   (یافتهٔ ممیزی: پیش‌تر متای موجود هرگز به‌روز نمی‌شد)؛
  // - بقیه: فقط درج برای اسلاگ‌هایی که ورودی ندارند.
  try {
    const h1Items = items.filter((it) => forcedSet.has(it.slug) || !h1Keys.has(it.slug));
    if (h1Items.length > 0) {
      const h1Base = removeH1Entries(h1File, forcedSet);
      patches.push({ path: SEO_H1_PATH, content: insertH1Overrides(h1Base, h1Items) });
    }
    const metaItems = items.filter((it) => forcedSet.has(it.slug) || !metaKeys.has(it.slug));
    if (metaItems.length > 0) {
      const metaContent = metaFile
        ? insertMetaOverrides(removeMetaEntries(metaFile, forcedSet), metaItems)
        : buildSeoMetaFile(metaItems);
      patches.push({ path: SEO_META_PATH, content: metaContent });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    blockers.push(`ساخت پچ ناموفق بود: ${msg}`);
    return { team: TEAM, summary: blockers[0], blockers, tasks: [], approved: false };
  }
  if (patches.length === 0) {
    blockers.push('پچی ساخته نشد (همهٔ موارد از قبل پوشش داشتند).');
    return { team: TEAM, summary: blockers[0], blockers, tasks: [], approved: false };
  }

  // ثبت حافظه (غنی‌شده با تاریخچه دورهای حلقه)
  await reportLive?.('ثبت آموخته‌ها در حافظه', 95);
  await writeMemory({
    team: TEAM,
    key: `learned:${runId}`,
    value: JSON.stringify({
      slugs: items.map((it) => it.slug),
      forced: forcedSlugs,
      claimedTask: claimedTask?.title ?? null,
      approved: loopResult.approved,
      finalRound: loopResult.finalRound,
      rounds: loopResult.verdicts.map((v, i) => ({
        round: i + 1,
        approved: v.approved,
        reason: v.reason || v.finalOpinion || '',
      })),
    }),
  });

  const tasks: QueuedTask[] = [];
  const hadRejection = loopResult.verdicts.some((v) => !v.approved);
  if (hadRejection) {
    tasks.push({
      title: 'بازبینی خروجی سئو',
      description: `منتقد در دورهای اول خروجی را رد کرد و حلقه در دور ${loopResult.finalRound} با نظر نهایی تمام شد: ${loopResult.finalOpinion}. پچ ساخته شد ولی نیاز به بازبینی دارد.`,
      files_hint: `${SEO_H1_PATH}، ${SEO_META_PATH}`,
      priority: 'high',
    });
  }

  // ---------- گزارش صادقانهٔ سرنوشت تسک صف ----------
  // ارکستر تسک claimشده را بر اساس همین خلاصه «موفق» می‌بندد؛ پس خلاصه
  // باید دقیق بگوید کدام هدف تسک انجام شد و کدام نه.
  const doneSlugs = new Set(items.map((it) => it.slug));
  const forcedDone = forcedSlugs.filter((s) => doneSlugs.has(s));
  const forcedMissed = forcedSlugs.filter((s) => !doneSlugs.has(s));
  const taskNotes: string[] = [];
  if (claimedTask) {
    if (forcedSlugs.length > 0) {
      taskNotes.push(
        `تسک صف «${claimedTask.title}»: ${forcedDone.length} اسلاگ بازتولید شد (${forcedDone.join('، ') || 'هیچ‌کدام'})` +
        (forcedMissed.length > 0 ? `؛ ${forcedMissed.length} اسلاگ ناموفق ماند (${forcedMissed.join('، ')})` : '') +
        '.',
      );
    } else {
      taskNotes.push(
        `تسک صف «${claimedTask.title}» هیچ اسلاگ شناخته‌شده‌ای نداشت؛ حالت خودکار اجرا شد.`,
      );
    }
  }
  if (targets.unknown.length > 0) {
    taskNotes.push(
      `اسلاگ‌های ناشناخته در تسک (در هیچ منبع صفحه‌ای نیستند و کاری برایشان نشد): ${targets.unknown.join('، ')}.`,
    );
  }
  for (const spId of targets.staticTargets) {
    const sp = STATIC_PAGES.find((s) => s.id === spId);
    if (!sp) continue;
    taskNotes.push(
      `صفحهٔ استاتیک «${sp.title}»: متایش در page.tsx خودش است، نه در نگاشت‌های سئو؛ در پچ نیامد.`,
    );
    // پیشنهاد به رهبر: این کارِ تیم dev است، نه سئو.
    tasks.push({
      title: `سئوی صفحه استاتیک ${sp.title}`,
      description:
        `متای صفحهٔ ${sp.title} داخل کامپوننت page.tsx خودش تعریف می‌شود و نگاشت‌های H1_OVERRIDES/META_OVERRIDES آن را پوشش نمی‌دهند. ` +
        `کار: متا تایتل و دیسکریپشن بهینهٔ فارسی برای این صفحه مستقیم در page.tsx بنویس (تیم dev).`,
      files_hint: `site/app/${sp.id}/page.tsx`,
      priority: 'medium',
    });
  }

  const summary =
    `برای ${items.length} صفحه h1 و متا تگ واقعی تولید شد (${items.map((it) => it.slug).join('، ')}) و پچ آماده است. ` +
    `حلقه نقد در دور ${loopResult.finalRound} تمام شد. ` +
    `نظر نهایی منتقد: ${loopResult.finalOpinion}. ` +
    (taskNotes.length > 0 ? taskNotes.join(' ') + ' ' : '') +
    lastKnowledgeLog;

  return {
    team: TEAM,
    summary,
    blockers,
    tasks: tasks.slice(0, 3),
    approved: loopResult.approved,
    patches,
  };
}
