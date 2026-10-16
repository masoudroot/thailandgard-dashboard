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
 * اجرای حلقه نقد ۳ دوره‌ای.
 */
export async function runCriticLoop<WorkerOutput>(
  opts: CriticLoopOptions<WorkerOutput>,
): Promise<CriticLoopResult<WorkerOutput>> {
  const { team, runId, runWorkers, runCritic, onRoundKnowledge, onProgress } = opts;
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
