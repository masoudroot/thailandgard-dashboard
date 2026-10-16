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

  for (let round = 1; round <= 3; round++) {
    await onProgress?.(`دور ${round}: اجرای مجری`);

    // اجرای مجری (با دستور دور قبل در دور ۲ و ۳)
    try {
      output = await runWorkers(round, prevInstruction);
    } catch (err) {
      // خطای مجری در دور ۲/۳ حلقه را نمی‌کشد؛ با بهترین خروجی موجود ادامه می‌دهیم
      if (round === 1 || !output) throw err;
      await onProgress?.(`دور ${round}: خطای مجری؛ با خروجی دور قبل ادامه می‌دهیم.`);
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
  };
}
