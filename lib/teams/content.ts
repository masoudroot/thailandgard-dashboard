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
  reason: string;
}

/** خروجی یک دور از مجری‌های حلقه نقد: موضوع + پیش‌نویس تمیزشده */
interface WorkerRoundOutput {
  pick: SupervisorPick;
  factsText: string;
  draft: GuideDraft;
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
 * ساخت آبجکت TypeScript راهنما با سبک فایل guides.ts.
 * همهٔ رشته‌ها sanitize و escape می‌شوند.
 */
function buildGuideTs(pick: SupervisorPick, draft: GuideDraft): string {
  const q = (s: string) => `"${escapeTsString(sanitizePersian(s))}"`;
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
    lines.push('    ],');
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

/** اعتبارسنجی اولیهٔ پیش‌نویس. */
function validateDraft(draft: GuideDraft): string | null {
  if (!draft.title || draft.title.trim().length < 5) return 'تیتر راهنما کوتاه یا خالی است.';
  if (!draft.excerpt || draft.excerpt.trim().length < 20) return 'چکیده خالی یا خیلی کوتاه است.';
  if (!Array.isArray(draft.sections) || draft.sections.length < 3)
    return 'راهنما حداقل ۳ بخش می‌خواهد.';
  for (const s of draft.sections) {
    if (!s.heading || !Array.isArray(s.paragraphs) || s.paragraphs.length === 0)
      return 'یک بخش بدون تیتر یا بدون پاراگراف است.';
  }
  if (!Array.isArray(draft.faqs) || draft.faqs.length < 2)
    return 'راهنما حداقل ۲ سؤال متداول می‌خواهد.';
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
    'لحن را طبیعی، انسانی و کاربردی برای مسافر واقعی نگه دار؛',
    'در پایان دوباره کنترل کن هیچ کاراکتر U+2014 و هیچ عدد بی‌سندی در متن نباشد.',
  ].join(' ');
}

/**
 * تبدیل دلیل رد به معیار قبولی (CriticVerdictV2.acceptance).
 */
function criticAcceptanceFromReason(reason: string): string {
  const r = reason.trim() || 'متن ایراد دارد';
  return `وقتی درست است که نقد «${r}» دیگر دربارهٔ متن صدق نکند و هر چهار معیار داوری (فارسی طبیعی، بدون U+2014، اعداد سنددار، کاربردی بودن) رعایت شده باشند.`;
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
          'واقعیت‌های قابل اتکا دربارهٔ این موضوع را فهرست کن؛ هر عدد باید منبعش را هم بگوید. حدس نزن؛ اگر از چیزی مطمئن نیستی بنویس «نامشخص».',
          'فقط JSON معتبر بده: {"facts": "متن واقعیت‌ها"}',
          'خروجی باید دقیقاً با { شروع و با } تمام شود. هیچ متن، توضیح یا کدفنس قبل و بعد از JSON ننویس.',
        ].join('\n'),
        { system: SYSTEM_WORKER },
      );

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
    await reportLive?.('مجری ۲: نگارش راهنما', 60);
    const draft = await callLLMJson<GuideDraft>(
      [
        ...(prevInstruction
          ? ['دستور منتقد برای اصلاح این دور (حتماً رعایت کن):', prevInstruction, '']
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
        '- ۳ تا ۵ بخش، هر بخش ۲ تا ۳ پاراگراف کوتاه و کاربردی',
        '- ۳ تا ۴ سؤال متداول با جواب مستقیم و کوتاه',
        '- چکیده (excerpt) حداکثر ۲ جمله، ترغیب‌کننده',
        '- h1 متفاوت از title و دربردارندهٔ کلمهٔ کلیدی',
        '- هیچ عددی بدون سند؛ اگر عددی سند ندارد آن را نیاور',
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
      title: sanitizePersian(draft.title),
      h1: sanitizePersian(draft.h1),
      excerpt: sanitizePersian(draft.excerpt),
      category: sanitizePersian(draft.category || pick.category),
      readingMinutes: draft.readingMinutes,
      sections: draft.sections.map((s) => ({
        heading: sanitizePersian(s.heading),
        paragraphs: s.paragraphs.map((p) => sanitizePersian(p)),
      })),
      faqs: draft.faqs.map((f) => ({
        question: sanitizePersian(f.question),
        answer: sanitizePersian(f.answer),
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
        'داوری کن. معیارها:',
        '۱. فارسی طبیعی و انسانی است یا ماشینی و کلیشه‌ای؟',
        '۲. کاراکتر U+2014 دارد؟ (اگر دارد، رد کن)',
        '۳. هر عدد سند دارد یا حدسی است؟',
        '۴. برای مسافر واقعی کاربردی است یا حرف کلی می‌زند؟',
        'فقط JSON معتبر بده: {"approved": true/false, "reason": "یک جمله"}',
        'خروجی باید دقیقاً با { شروع و با } تمام شود. هیچ متن، توضیح یا کدفنس قبل و بعد از JSON ننویس.',
      ].join('\n'),
      { system: SYSTEM_CRITIC },
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

  // کمربند نهایی: خط تیرهٔ ممنوعه (منطق فعلی)
  if (hasForbiddenDash(JSON.stringify(cleanDraft))) {
    blockers.push('متن نهایی هنوز خط تیرهٔ ممنوعه دارد؛ پچ ساخته نشد.');
    return { team: TEAM, summary: blockers[0], blockers, tasks: [], approved: false };
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
