/**
 * lib/critic-loop.ts — حلقه نقد ۳ مرحله‌ای مشترک همه تیم‌ها.
 *
 * معماری (سند: docs/critic-3round-loop.md):
 * - دور ۱: مجری → منتقد (تأیید/رد + دستور دقیق)
 * - دور ۲: مجری (با دستور) → منتقد (تأیید/رد + دستور دقیق)
 * - دور ۳: نظارت — منتقد فقط نظر نهایی می‌دهد، حق رد ندارد
 *
 * قرارداد حکم (CriticVerdictV2):
 * - approved: بولین
 * - reason: شرح کامل دلیل رد (حداقل ۳۰ نویسه)
 * - instruction: دستور دقیق قدم‌به‌قدم (حداقل ۵۰ نویسه، امری)
 * - acceptance: معیار قبولی — «وقتی درست است که...»
 * - finalOpinion: نظر نهایی (دور ۳)
 *
 * اعتبارسنجی خودکار: حکم رد بدون دستور کافی = نامعتبر، یک بار retry.
 *
 * گیت اعتبارسنجی خروجی (دستور مسعود):
 * خروجی نامعتبر مجری (خالی، ناقص/قطع‌شده، بی‌معنا) «هرگز» تأیید نمی‌شود.
 * این چک «ساختاری و قطعی» است و «قبل» از داوری کیفی منتقد انجام می‌شود؛
 * خروجی نامعتبر اصلاً به مرحله امتیازدهی نمی‌رسد. در دورهای ۱ و ۲ حکم رد
 * خودکار با دستور دقیق صادر می‌شود و در دور ۳ هم خروجی نامعتبر تأیید نمی‌شود
 * (فقط نظر نهایی ثبت می‌شود).
 */

export interface CriticVerdictV2 {
  approved: boolean;
  /** شرح کامل با جزئیات دلیل رد؛ وقتی approved=true خالی. */
  reason: string;
  /** دستور دقیق قدم‌به‌قدم برای مجری؛ وقتی approved=true خالی. */
  instruction: string;
  /** معیار قبولی؛ وقتی approved=true خالی. */
  acceptance: string;
  /** نظر نهایی منتقد (دور ۳). */
  finalOpinion?: string;
}

export interface CriticLoopOptions<WorkerOutput> {
  team: string;
  runId: string;
  /** اجرای مجری: (دور، دستور دور قبل) => خروجی */
  runWorkers: (round: number, prevInstruction?: string) => Promise<WorkerOutput>;
  /** اجرای منتقد: (خروجی، دور) => حکم */
  runCritic: (output: WorkerOutput, round: number) => Promise<CriticVerdictV2>;
  /**
   * اعتبارسنجی ساختاری خروجی مجری، پیش از داوری کیفی.
   * اگر تیم ندهد، اعتبارسنج عمومی به کار می‌رود.
   * برمی‌گرداند: true (معتبر) یا false یا {valid, detail}.
   */
  isOutputValid?: (output: WorkerOutput) => boolean | { valid: boolean; detail?: string };
  /** ثبت دانش هر دور */
  onRoundKnowledge?: (round: number, verdict: CriticVerdictV2) => Promise<void>;
  /** گزارش پیشرفت */
  onProgress?: (msg: string) => void | Promise<void>;
}

export interface CriticLoopResult<WorkerOutput> {
  /** خروجی نهایی (بهترین موجود). */
  output: WorkerOutput;
  /** آیا تأیید شد؟ */
  approved: boolean;
  /** در کدام دور تمام شد؟ */
  finalRound: number;
  /** همه احکام برای ثبت در دانش. */
  verdicts: CriticVerdictV2[];
  /** نظر نهایی منتقد. */
  finalOpinion: string;
  /** تعداد تلاش‌های مجدد مجری در همین چرخه (برای ردیابی). */
  workerRetries: number;
}

/** سقف تلاش مجری در هر دور — همه در همین چرخه، بدون موکول به چرخه بعد. */
const MAX_WORKER_ATTEMPTS_PER_ROUND = 3;

/**
 * تلاش مجدد یک کار ناپایدار (مثل ساخت پلن سرپرست) در همین چرخه.
 * دستور مسعود: هیچ کاری به چرخهٔ بعد موکول نمی‌شود؛ تا سقف تلاش، همین‌جا تکرار می‌شود.
 *
 * @param fn کاری که باید موفق شود
 * @param isValid اعتبارسنج نتیجه (خروجی معتبر؟)؛ اگر false برگرداند، تلاش بعدی
 * @param opts.maxAttempts سقف تلاش (پیش‌فرض ۳)
 * @param opts.label نام کار برای لاگ
 * @param opts.onProgress گزارش پیشرفت
 * @returns نتیجهٔ معتبر، یا null اگر همهٔ تلاش‌ها ناموفق بودند
 */
export async function retryInCycle<T>(
  fn: () => Promise<T>,
  isValid: (result: T) => boolean,
  opts: {
    maxAttempts?: number;
    label?: string;
    onProgress?: (msg: string) => void | Promise<void>;
  } = {},
): Promise<T | null> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const label = opts.label ?? 'کار';
  let lastResult: T | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      if (isValid(result)) return result;
      lastResult = result;
      if (attempt < maxAttempts) {
        await opts.onProgress?.(
          `${label}: خروجی نامعتبر (تلاش ${attempt} از ${maxAttempts})؛ تلاش مجدد در همین چرخه.`,
        );
      }
    } catch (err) {
      if (attempt < maxAttempts) {
        await opts.onProgress?.(
          `${label}: خطا در تلاش ${attempt} از ${maxAttempts}؛ تلاش مجدد در همین چرخه.`,
        );
      }
    }
  }
  return lastResult && isValid(lastResult) ? lastResult : null;
}

/** افعال امری فارسی برای اعتبارسنجی دستور. */
const IMPERATIVE_VERBS = [
  'بنویس', 'بازنویسی', 'حذف', 'اضافه', 'تغییر', 'اصلاح', 'جایگزین',
  'بگذار', 'بردار', 'عوض', 'کوتاه', 'بلند', 'شفاف', 'مشخص', 'دقیق',
  'بازسازی', 'مرتب', 'ساده', 'تقویت', 'حفظ', 'نگه', 'استفاده', 'بخوان',
];

/**
 * اعتبارسنجی حکم رد: دلیل کافی؟ دستور کافی و امری؟ معیار قبولی هست؟
 * برمی‌گرداند: {valid, issues[]}
 */
export function validateRejection(v: CriticVerdictV2): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!v.reason || v.reason.trim().length < 30) {
    issues.push('دلیل رد کمتر از ۳۰ نویسه است؛ شرح کامل با جزئیات لازم است.');
  }
  if (!v.instruction || v.instruction.trim().length < 50) {
    issues.push('دستور کمتر از ۵۰ نویسه است؛ دستور دقیق قدم‌به‌قدم لازم است.');
  } else {
    const hasImperative = IMPERATIVE_VERBS.some((verb) => v.instruction.includes(verb));
    if (!hasImperative) {
      issues.push('دستور باید امری باشد (فعل امری فارسی داشته باشد).');
    }
  }
  if (!v.acceptance || v.acceptance.trim().length < 20) {
    issues.push('معیار قبولی مشخص نیست؛ بنویس «وقتی درست است که...».');
  }
  return { valid: issues.length === 0, issues };
}

/**
 * اعمال اعتبارسنج تیم (در صورت وجود) وگرنه اعتبارسنج عمومی.
 */
function checkWorkerOutputValidity(
  hook: ((output: unknown) => boolean | { valid: boolean; detail?: string }) | undefined,
  output: unknown,
): OutputValidity {
  if (hook) {
    const r = hook(output);
    if (typeof r === 'boolean') {
      return r
        ? { valid: true, detail: '' }
        : { valid: false, detail: 'اعتبارسنج تیم خروجی را نامعتبر دانست.' };
    }
    return r.valid
      ? { valid: true, detail: '' }
      : { valid: false, detail: r.detail?.trim() || 'اعتبارسنج تیم خروجی را نامعتبر دانست.' };
  }
  return validateWorkerOutput(output);
}

/** نتیجه اعتبارسنجی ساختاری خروجی مجری. */
export interface OutputValidity {
  valid: boolean;
  /** وقتی نامعتبر است: «خروجی نامعتبر است: ...» */
  detail: string;
}

/**
 * کلیدهای «تحویلی» خروجی تیم‌ها (نه زمینه/مأموریت).
 * اعتبارسنج عمومی محتوای همین زیردرخت‌ها را می‌سنجد؛
 * کلیدهایی مثل missions و plan زمینه‌اند و نادیده گرفته می‌شوند.
 */
const DELIVERABLE_KEYS = new Set([
  'outputs', 'workeroutputs', 'workersoutput', 'texts',
  'draft', 'items', 'patches', 'files', 'component',
]);

/** سقف حداقلی محتوای معنادار (حرف/رقم) برای یک تحویلی معتبر. */
const MIN_SUBSTANTIVE_CHARS = 40;

/** شمارش حروف و ارقام واقعی متن (بدون نقطه‌گذاری و فاصله)؛ ES5-safe. */
function substantiveLength(text: string): number {
  const stripped = text.replace(/[\s\u2000-\u206F!-/:-@\[-`{-~\u060C\u061B\u061F\u00AB\u00BB\u2026\u066B\u066C]/g, '');
  return stripped.length;
}

/** همه رشته‌های برگ یک زیردرخت را جمع می‌کند. */
function collectLeafStrings(value: unknown, acc: string[]): void {
  if (typeof value === 'string') {
    acc.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectLeafStrings(v, acc);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectLeafStrings(v, acc);
  }
}

/** آیا رشته نشانه بریدگی/قطع‌شدگی دارد؟ */
function isTruncatedLeaf(text: string): boolean {
  const t = text.trimEnd();
  if (!t) return false;
  if (t.endsWith('…') || t.endsWith('...')) return true;
  if (/\[بریده/.test(t) || /\[خروجی بریده/.test(t) || /truncated/i.test(t)) return true;
  const fences = (t.match(/```/g) || []).length;
  if (fences % 2 === 1) return true; // بلاک کد باز مانده
  return false;
}

/**
 * اعتبارسنج عمومی ساختاری خروجی مجری — قطعی و بدون LLM.
 * ترتیب چک: نبود خروجی ← خالی بودن تحویلی‌ها ← بریدگی ← بی‌معنایی.
 */
export function validateWorkerOutput(output: unknown): OutputValidity {
  if (output === null || output === undefined) {
    return { valid: false, detail: 'خروجی‌ای تولید نشده است.' };
  }

  // زیردرخت‌های تحویلی را پیدا کن؛ اگر کلیدی نبود، کل خروجی را بسنج.
  let deliverableSubtrees: unknown[] = [];
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
      if (DELIVERABLE_KEYS.has(key.toLowerCase())) deliverableSubtrees.push(value);
    }
  }
  if (deliverableSubtrees.length === 0) deliverableSubtrees = [output];

  const leaves: string[] = [];
  for (const subtree of deliverableSubtrees) collectLeafStrings(subtree, leaves);

  const nonEmpty = leaves.filter((s) => s.trim().length > 0);
  if (nonEmpty.length === 0) {
    return { valid: false, detail: 'خروجی خالی است؛ هیچ محتوایی از مجری تحویل گرفته نشد.' };
  }

  for (const leaf of nonEmpty) {
    if (isTruncatedLeaf(leaf)) {
      const preview = leaf.trim().slice(-60);
      return { valid: false, detail: `خروجی ناقص و قطع‌شده است (پایان بریده: «…${preview}»).` };
    }
  }

  const total = nonEmpty.reduce((sum, s) => sum + substantiveLength(s), 0);
  if (total < MIN_SUBSTANTIVE_CHARS) {
    return { valid: false, detail: 'خروجی بی‌معناست؛ دادهٔ قابل ارزیابی ندارد.' };
  }

  return { valid: true, detail: '' };
}

/**
 * حکم رد خودکار برای خروجی نامعتبر — امتیاز صفر، بدون داوری کیفی.
 * متن‌ها عمداً شرط‌های validateRejection را می‌گذرانند (دلیل ۳۰+، دستور ۵۰+ امری، معیار قبولی).
 */
export function buildAutoRejection(detail: string): CriticVerdictV2 {
  return {
    approved: false,
    reason:
      `خروجی نامعتبر است: ${detail} ` +
      'چنین خروجی‌ای هرگز تأیید نمی‌شود؛ مجری موظف است خروجی کامل و قابل ارزیابی تحویل بدهد.',
    instruction:
      `خروجی قبلی‌ات نامعتبر بود (${detail}). ` +
      'دوباره بنویس و این بار خروجی را «کامل» تحویل بده: بدون بریدگی، بدون بخش خالی، با محتوای واقعی و قابل ارزیابی. ' +
      'خروجی را پیش از تحویل بازبینی و اصلاح کن؛ اگر ناقص است کاملش کن و بعد تحویل بده. کم‌کاری پذیرفته نیست.',
    acceptance: 'وقتی خروجی کامل، بدون بریدگی و با محتوای واقعی قابل ارزیابی باشد.',
  };
}

/**
 * اجرای حلقه نقد ۳ دوره‌ای.
 */
export async function runCriticLoop<WorkerOutput>(
  opts: CriticLoopOptions<WorkerOutput>,
): Promise<CriticLoopResult<WorkerOutput>> {
  const { team, runId, runWorkers, runCritic, isOutputValid, onRoundKnowledge, onProgress } = opts;
  const verdicts: CriticVerdictV2[] = [];
  let output: WorkerOutput | undefined;
  let prevInstruction: string | undefined;
  let workerRetries = 0;

  /**
   * اجرای مجری با تلاش مجدد در همین چرخه (دستور مسعود: رد باید در همان چرخه حل شود).
   * هر دور تا ۳ تلاش؛ هیچ‌چیز به چرخهٔ بعد موکول نمی‌شود.
   */
  const runWorkersWithRetry = async (
    round: number,
    instruction: string | undefined,
  ): Promise<WorkerOutput> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_WORKER_ATTEMPTS_PER_ROUND; attempt++) {
      try {
        const attemptInstruction =
          attempt === 1
            ? instruction
            : [
                instruction,
                '',
                `تذکر تلاش ${attempt}: خروجی قبلی‌ات ناقص/نامعتبر بود. این بار خروجی را کامل و بدون نقص بده؛`,
                'کم‌کاری یا خروجی خالی پذیرفته نیست.',
              ]
              .filter(Boolean)
              .join('\n');
        return await runWorkers(round, attemptInstruction);
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_WORKER_ATTEMPTS_PER_ROUND) {
          workerRetries++;
          await onProgress?.(
            `دور ${round}: خطای مجری (تلاش ${attempt} از ${MAX_WORKER_ATTEMPTS_PER_ROUND})؛ تلاش مجدد در همین چرخه.`,
          );
        }
      }
    }
    throw lastErr;
  };

  for (let round = 1; round <= 3; round++) {
    await onProgress?.(`دور ${round}: اجرای مجری`);

    // اجرای مجری (با دستور دور قبل در دور ۲ و ۳) — با تلاش مجدد در همین چرخه
    try {
      output = await runWorkersWithRetry(round, prevInstruction);
    } catch (err) {
      // هر ۳ تلاش هر دور ناموفق بود.
      // دور ۱: بدون هیچ خروجی نمی‌شود ادامه داد → خطا به تیم برمی‌گردد تا بلوکر در همین چرخه ثبت شود.
      // دور ۲/۳: با بهترین خروجی موجود (دور قبل) ادامه می‌دهیم؛ چیزی به چرخهٔ بعد موکول نمی‌شود.
      if (round === 1 || !output) throw err;
      await onProgress?.(`دور ${round}: مجری پس از ${MAX_WORKER_ATTEMPTS_PER_ROUND} تلاش خروجی نداد؛ با خروجی دور قبل ادامه می‌دهیم (همین چرخه).`);
    }

    // گیت اعتبارسنجی ساختاری (دستور مسعود): خروجی نامعتبر هرگز به داوری کیفی نمی‌رسد.
    // خالی، ناقص/قطع‌شده یا بی‌معنا = رد خودکار با امتیاز صفر، بدون امتیازدهی.
    const validity = checkWorkerOutputValidity(
      isOutputValid as ((output: unknown) => boolean | { valid: boolean; detail?: string }) | undefined,
      output!,
    );
    if (!validity.valid) {
      await onProgress?.(`دور ${round}: خروجی نامعتبر است (${validity.detail})؛ به داوری کیفی نرفت.`);
      if (round === 3) {
        // دور ۳: رد کیفی مجاز نیست، ولی خروجی نامعتبر هم هرگز تأیید نمی‌شود؛ فقط نظر نهایی.
        const invalidVerdict: CriticVerdictV2 = {
          approved: false,
          reason: `خروجی نامعتبر است: ${validity.detail}`,
          instruction: '',
          acceptance: '',
          finalOpinion:
            `خروجی نامعتبر بود (${validity.detail}) و تأیید نشد؛ فقط نظر نهایی ثبت شد. ` +
            'در چرخهٔ بعد مجری باید خروجی کامل و قابل ارزیابی تحویل بدهد.',
        };
        verdicts.push(invalidVerdict);
        await onRoundKnowledge?.(round, invalidVerdict);
        return {
          output: output!,
          approved: false,
          finalRound: 3,
          verdicts,
          finalOpinion: invalidVerdict.finalOpinion!,
          workerRetries,
        };
      }
      const autoVerdict = buildAutoRejection(validity.detail);
      verdicts.push(autoVerdict);
      await onRoundKnowledge?.(round, autoVerdict);
      prevInstruction = [
        `دستور منتقد (دور ${round}):`,
        autoVerdict.instruction,
        '',
        `معیار قبولی: ${autoVerdict.acceptance}`,
      ].join('\n');
      await onProgress?.(`دور ${round}: رد خودکار خروجی نامعتبر؛ دستور اصلاح برای دور بعد آماده است.`);
      continue;
    }

    await onProgress?.(`دور ${round}: داوری منتقد`);
    let verdict = await runCritic(output!, round > 3 ? 3 : round as 1 | 2 | 3);

    // دور ۳: رد مجاز نیست؛ به‌عنوان نظر نهایی تفسیر می‌شود
    if (round === 3) {
      verdict = { ...verdict, approved: true };
      verdicts.push(verdict);
      await onRoundKnowledge?.(round, verdict);
      return {
        output: output!,
        approved: true,
        finalRound: 3,
        verdicts,
        finalOpinion: verdict.finalOpinion || verdict.reason || 'نظر نهایی ثبت شد.',
        workerRetries,
      };
    }

    // اعتبارسنجی حکم رد
    if (!verdict.approved) {
      const validation = validateRejection(verdict);
      if (!validation.valid) {
        await onProgress?.(`دور ${round}: حکم رد نامعتبر است (${validation.issues.join(' ')})؛ یک بار از منتقد می‌خواهیم کاملش کند.`);
        // یک بار retry
        verdict = await runCritic(output!, round as 1 | 2);
        const revalidation = validateRejection(verdict);
        if (!verdict.approved && !revalidation.valid) {
          // با همان حکم ناقص ادامه می‌دهیم ولی ثبت می‌شود
          await onProgress?.(`دور ${round}: دستور همچنان ناقص است؛ در دانش ثبت می‌شود.`);
        }
      }
    }

    verdicts.push(verdict);
    await onRoundKnowledge?.(round, verdict);

    if (verdict.approved) {
      return {
        output: output!,
        approved: true,
        finalRound: round,
        verdicts,
        finalOpinion: verdict.finalOpinion || 'تأیید شد.',
        workerRetries,
      };
    }

    // رد شد؛ دستور برای دور بعد
    prevInstruction = [
      `دستور منتقد (دور ${round}):`,
      verdict.instruction,
      '',
      `معیار قبولی: ${verdict.acceptance}`,
    ].join('\n');

    await onProgress?.(`دور ${round}: رد شد؛ دستور برای اصلاح آماده است.`);
  }

  // نباید به اینجا برسیم (دور ۳ همیشه برمی‌گردد)
  return {
    output: output!,
    approved: false,
    finalRound: 3,
    verdicts,
    finalOpinion: 'حلقه بدون نتیجه نهایی تمام شد.',
    workerRetries,
  };
}
