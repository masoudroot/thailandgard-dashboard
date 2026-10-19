/**
 * lib/critic-prompt.ts : پرامپت‌ساز مشترک منتقد همه تیم‌ها.
 *
 * قرارداد تازه (دستور مسعود):
 * - دور ۱ و ۲: منتقد اگر رد می‌کند، «شرح کامل با جزئیات» دلیل رد می‌دهد
 *   (نه یک جمله کلی) و «دستور دقیق» می‌دهد که چه کاری باید انجام شود؛
 *   انگار دارد برای مجری پرامپت می‌نویسد. دستور باید آن‌قدر دقیق باشد
 *   که مجری بدون هیچ سؤالی بتواند اجرایش کند. منتقد خودش اصلاح نمی‌کند؛
 *   فقط دستور می‌دهد و تیم می‌رود اجرایش می‌کند.
 * - دور ۳: منتقد دیگر حق رد ندارد؛ فقط «نظارت» می‌کند و نظر نهایی‌اش را
 *   می‌گوید تا در دانش تیم ثبت شود.
 *
 * امضای اصلی: buildCriticPrompt(team, output, round)
 * پارامتر چهارم (اختیاری) برای معیارهای اختصاصی هر تیم و بازخورد دورهای قبل.
 *
 * خروجی JSON منتقد همیشه این چهار کلید را دارد (SmartCriticVerdict):
 *   approved            بولین؛ در دور ۳ همیشه true
 *   rejection_detail    شرح کامل دلیل رد (دور ۱ و ۲، وقتی approved=false)
 *   fix_instructions    دستور دقیق قدم‌به‌قدم برای مجری (همان دورها)
 *   final_opinion       نظر نهایی منتقد (همیشه؛ در دور ۳ برای ثبت در دانش)
 */

import type { TeamName } from './types';

/** دور داوری: ۱ و ۲ رد مجاز است، ۳ فقط نظارت. */
export type CriticRound = 1 | 2 | 3;

/** بیشترین دور داوری در هر نوبت تیم. */
export const MAX_CRITIC_ROUNDS = 3;

export interface CriticPromptOptions {
  /** معیارهای اختصاصی داوری این تیم (چک‌لیست). اگر نباشد، معیار عمومی به کار می‌رود. */
  criteria?: string;
  /** خلاصه بازخورد دورهای قبل (برای دور ۲ و ۳). */
  previousFeedback?: string;
  /** سقف کاراکتر خروجی مجری در پرامپت؛ پیش‌فرض ۲۵۰۰۰. */
  maxOutputChars?: number;
}

export interface BuiltCriticPrompt {
  /** پیام system برای فراخوانی LLM. */
  system: string;
  /** پیام user (پرامپت اصلی داوری). */
  prompt: string;
  /** آیا در این دور رد مجاز است؟ (دور ۳: خیر) */
  canReject: boolean;
}

/** شکل استاندارد حکم منتقد در قرارداد تازه. */
export interface SmartCriticVerdict {
  approved: boolean;
  /**
   * امتیاز کیفی ۰ تا ۱۰۰؛ تعیین‌کننده نهایی: تأیید فقط با امتیاز ≥ ۸۰
   * (CRITIC_PASS_SCORE در lib/critic-loop.ts).
   */
  score?: number;
  /** شرح کامل با جزئیات دلیل رد؛ وقتی approved=true رشته خالی. */
  rejection_detail: string;
  /** دستور دقیق قدم‌به‌قدم برای مجری؛ وقتی approved=true رشته خالی. */
  fix_instructions: string;
  /** نظر نهایی منتقد؛ همیشه پر می‌شود. */
  final_opinion: string;
}

const DEFAULT_MAX_OUTPUT_CHARS = 25000;

/** معیار عمومی داوری وقتی تیم معیار اختصاصی نداده است. */
const GENERIC_CRITERIA = [
  'خروجی با مأموریت تیم می‌خواند و کامل است (ناقص یا placeholder نیست).',
  'ادعاها واقعی‌اند؛ عدد و ادعای مهم سند یا منبع دارد.',
  'فارسی طبیعی و تمیز است؛ بدون لحن ماشینی.',
  'اگر خروجی کد است: سینتکس معتبر، ایمپورت درست، بدون secret.',
].join('\n');

function truncateOutput(output: string, maxChars: number): string {
  const text = (output ?? '').trim();
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n... [خروجی بریده شد؛ بقیه برای داوری لازم نبود]';
}

/** ارقام فارسی برای متن‌های نمایشی. */
const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
const faNum = (n: number): string =>
  String(n).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]);

const JSON_KEYS_LINE =
  'فقط JSON معتبر بده با دقیقاً این پنج کلید: ' +
  '"approved" (بولین)، "score" (عدد صحیح ۰ تا ۱۰۰؛ تأیید فقط با ۸۰ یا بالاتر)، "rejection_detail" (رشته)، ' +
  '"fix_instructions" (رشته)، "final_opinion" (رشته). ' +
  'هیچ متنی بیرون از JSON ننویس.';

/**
 * پرامپت داوری دور ۱ و ۲: رد با شرح کامل + دستور دقیق.
 */
function buildRejectablePrompt(
  team: TeamName,
  output: string,
  round: 1 | 2,
  criteria: string,
  previousFeedback?: string,
): BuiltCriticPrompt {
  const system = `تو منتقد سخت‌گیر تیم ${team} تایلندگرد هستی. فقط JSON معتبر می‌دهی.`;
  const lines = [
    `این دور ${faNum(round)} از حداکثر ${faNum(MAX_CRITIC_ROUNDS)} دور داوری است. در این دور «رد» مجاز است.`,
    '',
    'خروجی مجری برای داوری:',
    truncateOutput(output, DEFAULT_MAX_OUTPUT_CHARS),
    '',
    'معیارهای داوری:',
    criteria,
  ];
  if (previousFeedback?.trim()) {
    lines.push('', 'بازخورد دورهای قبل (ببین چه خواسته شده بود):', previousFeedback.trim());
  }
  lines.push(
    '',
    'قوانین داوری (سفت):',
    '۱. خروجی را بندبه‌بند با معیارها بسنج. فقط ایراد «واقعی» رد می‌شود؛ سلیقه‌ای نه.',
    '۲. اگر ایراد واقعی دیدی، رد کن (approved=false) و هر دو بخش زیر را «کامل» بده:',
    '   الف) rejection_detail (شرح کامل دلیل رد): دقیقاً چه چیزی ایراد دارد، «کجا» (کدام بخش، خط یا فایل)، «چرا» مشکل است، و «شاهد» (نقل‌قول کوتاه از همان بخش خروجی). یک جمله کلی کافی نیست.',
    '   ب) fix_instructions (دستور دقیق اصلاح): انگار داری برای مجری «پرامپت» می‌نویسی. قدم‌به‌قدم و بدون ابهام؛ مجری باید بتواند بدون هیچ سؤالی اجرایش کند. هر قدم این سه را داشته باشد: چه چیزی ← کجا ← دقیقاً چطور. چیزهایی که «نباید» عوض شود را هم بنویس تا رگرسیون پیش نیاید.',
    '۳. خودت خروجی را اصلاح نکن؛ فقط دستور دقیق بده. اجرا با تیم است.',
    '۴. اگر ایراد واقعی نیست، تأیید کن (approved=true) و rejection_detail و fix_instructions را رشته خالی بگذار.',
    '۵. final_opinion را همیشه در یک تا دو جمله بنویس: خلاصه داوری‌ات در این دور.',
    '',
    JSON_KEYS_LINE,
  );
  return { system, prompt: lines.join('\n'), canReject: true };
}

/**
 * پرامپت داوری دور ۳: داوری نهایی، بدون دور اصلاح.
 */
function buildFinalReviewPrompt(
  team: TeamName,
  output: string,
  criteria: string,
  previousFeedback?: string,
): BuiltCriticPrompt {
  const system = `تو منتقد سخت‌گیر تیم ${team} تایلندگرد هستی. فقط JSON معتبر می‌دهی.`;
  const lines = [
    `این دور ${faNum(MAX_CRITIC_ROUNDS)} و پایانی است.`,
    '',
    'قانون این دور: دور اصلاح دیگری وجود ندارد. اگر ایراد واقعی باقی است، صادقانه رد کن (approved=false) و دلیل نهایی را کامل در final_opinion بنویس. اگر خروجی قابل تحویل است، تأیید کن (approved=true).',
    'کارت:',
    '۱. ببین در دورهای قبل چه گذشت و چه دستورهایی داده شد.',
    '۲. ایرادهایی که هنوز مانده را با جزئیات بنویس (چه چیزی، کجا، چرا مهم است).',
    '۳. بگو چه چیزی درست شد و چه درسی برای چرخه‌های بعد دارد.',
    '۴. نظر نهایی‌ات را کامل بنویس؛ این نظر در «دانش تیم» ثبت می‌شود.',
    '',
    'خروجی نهایی مجری:',
    truncateOutput(output, DEFAULT_MAX_OUTPUT_CHARS),
  ];
  if (previousFeedback?.trim()) {
    lines.push('', 'روند دورهای قبل:', previousFeedback.trim());
  }
  lines.push(
    '',
    'معیارهای داوری:',
    criteria,
    '',
    JSON_KEYS_LINE,
    'در این دور fix_instructions را خالی بگذار (دور بعدی نیست)؛ در صورت رد، rejection_detail را کامل بده.',
  );
  return { system, prompt: lines.join('\n'), canReject: true };
}

/**
 * پرامپت‌ساز مشترک منتقد همه تیم‌ها.
 *
 * @param team   نام تیم
 * @param output خروجی مجری برای داوری
 * @param round  دور داوری (۱، ۲ یا ۳)
 * @param opts   معیارهای اختصاصی تیم و بازخورد دورهای قبل
 */
export function buildCriticPrompt(
  team: TeamName,
  output: string,
  round: CriticRound,
  opts: CriticPromptOptions = {},
): BuiltCriticPrompt {
  const criteria = opts.criteria?.trim() || GENERIC_CRITERIA;
  if (round === 3) {
    return buildFinalReviewPrompt(team, output, criteria, opts.previousFeedback);
  }
  return buildRejectablePrompt(team, output, round, criteria, opts.previousFeedback);
}

/**
 * پرامپت دور بعدی مجری، ساخته‌شده از دستور دقیق منتقد.
 * مجری این را می‌گیرد و بدون سؤال اجرا می‌کند.
 *
 * @param team            نام تیم
 * @param fixInstructions دستور دقیق منتقد (فیلد fix_instructions حکم)
 * @param round           دور بعدی اجرا (۲ یا ۳)
 * @param previousOutput  خروجی قبلی مجری (زمینه؛ بریده‌شده)
 */
export function buildWorkerRetryPrompt(
  team: TeamName,
  fixInstructions: string,
  round: 2 | 3,
  previousOutput?: string,
): string {
  const lines = [
    `تو مجری تیم ${team} تایلندگرد هستی. این دور ${faNum(round)} اجراست.`,
    '',
    'دستور دقیق منتقد برای این دور (بدون هیچ تغییری اجرا کن؛ سؤال نپرس):',
    (fixInstructions ?? '').trim() || '(دستوری ثبت نشده؛ خروجی را با معیارهای تیم بازبینی و کامل کن)',
  ];
  if (previousOutput?.trim()) {
    lines.push(
      '',
      'خروجی قبلی‌ات (فقط برای زمینه؛ همان را دوباره تحویل نده):',
      truncateOutput(previousOutput, 8000),
    );
  }
  lines.push('', 'خروجی نهایی کامل را تحویل بده.');
  return lines.join('\n');
}

/**
 * خلاصه بازخورد دورهای قبل برای تزریق به دور بعد.
 * از احکام دورهای ۱ و ۲ ساخته می‌شود.
 */
export function summarizePreviousFeedback(
  verdicts: Array<Pick<SmartCriticVerdict, 'approved' | 'rejection_detail' | 'fix_instructions'>>,
): string {
  const parts: string[] = [];
  verdicts.forEach((v, i) => {
    const roundFa = faNum(i + 1);
    if (v.approved) {
      parts.push(`دور ${roundFa}: تأیید شد.`);
    } else {
      parts.push(
        `دور ${roundFa}: رد شد. دلیل: ${(v.rejection_detail || '').trim() || '(ثبت نشده)'} ` +
          `دستور داده‌شده: ${(v.fix_instructions || '').trim() || '(ثبت نشده)'}`,
      );
    }
  });
  return parts.join('\n');
}
