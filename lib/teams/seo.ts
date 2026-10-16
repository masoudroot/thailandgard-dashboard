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
 *   ۱. خواندن اسلاگ‌های راهنماها و h1های موجود از ریپوی سایت
 *   ۲. حلقه نقد ۳ دوره‌ای (lib/critic-loop.ts):
 *      دور ۱: سرپرست (انتخاب ۱ تا ۳ اسلاگ اولویت‌دار) ← مجری (h1+متا)
 *      دور ۲: منتقد داوری می‌کند؛ رد ← دستور دقیق ← مجری همان اسلاگ‌ها را اصلاح می‌کند
 *      دور ۳: فقط نظارت و نظر نهایی (حق رد ندارد)
 *   ۳. کدژن قطعی: درج در H1_OVERRIDES و META_OVERRIDES
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
}

const GUIDES_PATH = 'site/lib/guides.ts';
const SEO_H1_PATH = 'site/lib/seo-h1.ts';
const SEO_META_PATH = 'site/lib/seo-meta.ts';

/** حداکثر اسلاگ در هر چرخه. */
const MAX_SLUGS_PER_CYCLE = 3;

/** یک قلم خروجی سئو برای یک اسلاگ */
interface SeoItem {
  slug: string;
  title: string;
  h1: string;
  metaTitle: string;
  metaDescription: string;
  keyword: string;
}

interface CriticVerdict {
  approved: boolean;
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
 */
function insertH1Overrides(fileContent: string, items: SeoItem[]): string {
  const marker = '/** قاعدهٔ مشتق‌سازی';
  const markerIdx = fileContent.indexOf(marker);
  if (markerIdx < 0) {
    throw new Error('ساختار فایل seo-h1.ts شناخته نشد.');
  }
  const closeIdx = fileContent.lastIndexOf('};', markerIdx);
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
 */
function insertMetaOverrides(fileContent: string, items: SeoItem[]): string {
  const markerIdx = fileContent.indexOf('export function resolveMeta');
  if (markerIdx < 0) {
    throw new Error('ساختار فایل seo-meta.ts شناخته نشد.');
  }
  const closeIdx = fileContent.lastIndexOf('};', markerIdx);
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

  // ۰. خواندن وضعیت جاری سئوی سایت
  await reportLive?.('خواندن وضعیت سئوی سایت', 5);
  let guidesFile: string | null = null;
  let h1File: string | null = null;
  let metaFile: string | null = null;
  try {
    [guidesFile, h1File] = await Promise.all([
      readSiteFile(GUIDES_PATH),
      readSiteFile(SEO_H1_PATH),
    ]);
    metaFile = await readSiteFile(SEO_META_PATH).catch(() => null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    blockers.push(`خواندن فایل‌های سئو از ریپوی سایت ناموفق بود: ${msg}`);
    return { team: TEAM, summary: blockers[0], blockers, tasks: [], approved: false };
  }
  if (!guidesFile || !h1File) {
    blockers.push('فایل‌های guides.ts یا seo-h1.ts در ریپوی سایت پیدا نشد.');
    return { team: TEAM, summary: blockers[0], blockers, tasks: [], approved: false };
  }

  const guides = extractGuides(guidesFile);
  const h1Keys = new Set(extractH1Keys(h1File));
  const metaKeys = new Set(extractMetaKeys(metaFile));
  const missing = guides.filter((g) => !h1Keys.has(g.slug) || !metaKeys.has(g.slug));
  if (missing.length === 0) {
    const summary = 'همهٔ راهنماها h1 و متا تگ اختصاصی دارند؛ کاری برای این چرخه نبود.';
    await writeMemory({ team: TEAM, key: `learned:${runId}`, value: JSON.stringify({ noop: true }) });
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
    for (const slug of slugs) {
      const guide = guides.find((g) => g.slug === slug);
      if (!guide) continue;
      const rawItem = await callLLMJson<SeoItem>(
        [
          ...(prevInstruction
            ? ['دستور منتقد برای اصلاح این دور (حتماً رعایت کن):', prevInstruction, '']
            : []),
          `اسلاگ: ${slug}`,
          `تیتر صفحه: ${guide.title}`,
          '',
          'برای این صفحه تولید کن:',
          '۱. h1: مستقل از تایتل، دربردارندهٔ کلمهٔ کلیدی اصلی، حداکثر ۶۰ نویسه، فارسی طبیعی',
          '۲. metaTitle: ۵۰ تا ۶۰ نویسه برای SERP، کلمهٔ کلیدی در ابتدا، ترغیب‌کننده (بدون پسوند برند؛ برند جدا اضافه می‌شود)',
          '۳. metaDescription: ۱۲۰ تا ۱۶۰ نویسه، فارسی طبیعی، خلاصهٔ مفید + فراخوان ملایم',
          '۴. keyword: کلمهٔ کلیدی اصلی صفحه',
          '',
          'قوانین: کاراکتر U+2014 مطلقاً ممنوع. هیچ تکنیک خاکستری. فقط واقعیت.',
          'فقط JSON معتبر بده: {"slug": "...", "title": "...", "h1": "...", "metaTitle": "...", "metaDescription": "...", "keyword": "..."}',
          'خروجی باید دقیقاً با { شروع و با } تمام شود. هیچ متن، توضیح یا کدفنس قبل و بعد از JSON ننویس.',
        ].join('\n'),
        { system: SYSTEM_WORKER, temperature: 0.5, maxTokens: 800 },
      );
      // خروجی LLM ممکن است آبجکت نباشد (مثلاً عدد)؛ قبل از مقداردهی اعتبارسنجی می‌کنیم
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
        console.warn(`[seo] خروجی نامعتبر LLM برای اسلاگ ${slug}:`, String(rawItem).slice(0, 100));
        continue;
      }
      const item: SeoItem = rawItem;
      item.slug = slug;
      item.title = guide.title;
      item.h1 = sanitizePersian(item.h1);
      item.metaTitle = sanitizePersian(item.metaTitle);
      item.metaDescription = sanitizePersian(item.metaDescription);
      const err = validateItem(item, guide.title);
      if (err) {
        console.warn(`[seo] قلم نامعتبر برای اسلاگ ${slug}: ${err}`);
        continue;
      }
      items.push(item);
    }
    return items;
  };

  /**
   * runWorkers: سرپرست (دور ۱) + مجری هر دور.
   * دور ۱: انتخاب ۱ تا ۳ اسلاگ اولویت‌دار + تولید اقلام؛
   * دور ۲/۳: تولید دوبارهٔ همان اسلاگ‌ها با دستور منتقد.
   */
  const runWorkers = async (
    round: number,
    prevInstruction?: string,
  ): Promise<WorkerRoundOutput> => {
    if (round === 1) {
      // سرپرست: انتخاب ۱ تا ۳ اسلاگ اولویت‌دار (منطق فعلی، بدون تغییر)
      await reportLive?.('سرپرست: انتخاب اسلاگ‌ها', 20);
      const candidates = missing
        .slice(0, 12)
        .map((g) => `- ${g.slug}: ${g.title}`)
        .join('\n');
      const pickRaw = await callLLM(
        [
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
    } else {
      await reportLive?.(`دور ${round}: اصلاح با دستور منتقد`, 50);
    }

    const slugs = cachedSlugs;
    if (slugs.length === 0) {
      throw new Error('اسلاگی برای تولید سئو در کش پیدا نشد.');
    }

    await reportLive?.('مجری: تولید h1 و متا تگ', 60);
    const items = await generateSeoItems(slugs, prevInstruction);
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
          `اسلاگ: ${it.slug}`,
          `تیتر: ${it.title}`,
          `h1: ${it.h1}`,
          `متا تایتل: ${it.metaTitle}`,
          `متا دیسکریپشن: ${it.metaDescription}`,
          '',
        ]),
        'داوری کن. معیارها: h1 واقعاً از تایتل جداست؟ طول‌ها در بازه‌اند؟ فارسی طبیعی است؟ خط تیرهٔ بلند ندارد؟ کلیک‌بیت گمراه‌کننده نیست؟',
        'فقط JSON معتبر بده: {"approved": true/false, "reason": "یک جمله"}',
        'خروجی باید دقیقاً با { شروع و با } تمام شود. هیچ متن، توضیح یا کدفنس قبل و بعد از JSON ننویس.',
      ].join('\n'),
      { system: SYSTEM_CRITIC, temperature: 0.2 },
    );
    const reason = String(verdict.reason || '').trim();

    if (round === 3) {
      return {
        approved: true,
        reason: '',
        instruction: '',
        acceptance: '',
        finalOpinion: reason || 'نظر نهایی ثبت شد.',
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

  // کدژن قطعی: پچ h1 و پچ متا (منطق فعلی)
  try {
    const h1Items = items.filter((it) => !h1Keys.has(it.slug));
    if (h1Items.length > 0) {
      patches.push({ path: SEO_H1_PATH, content: insertH1Overrides(h1File, h1Items) });
    }
    const metaItems = items.filter((it) => !metaKeys.has(it.slug));
    if (metaItems.length > 0) {
      const metaContent = metaFile
        ? insertMetaOverrides(metaFile, metaItems)
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
  await writeMemory({
    team: TEAM,
    key: `learned:${runId}`,
    value: JSON.stringify({
      slugs: items.map((it) => it.slug),
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

  const summary =
    `برای ${items.length} صفحه h1 و متا تگ واقعی تولید شد (${items.map((it) => it.slug).join('، ')}) و پچ آماده است. ` +
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
