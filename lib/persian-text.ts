/**
 * lib/persian-text.ts: ابزارهای متن فارسی برای خروجی تیم‌ها.
 *
 * قانون مطلق مسعود: خط تیرهٔ بلند (U+2014) در هیچ خروجی فارسی نمی‌آید.
 * این ماژول متن تولیدشدهٔ مدل را پیش از ثبت در پچ تمیز می‌کند.
 */

/** خط تیرهٔ بلند و نیم‌بلند؛ هر دو ممنوع‌اند. */
const FORBIDDEN_DASHES = /[\u2014\u2013]/g;

/**
 * تمیزکاری متن فارسی:
 * - حذف U+2014 و U+2013 (جایگزینی با «؛» یا «،» بر اساس بافت ساده)
 * - حذف فاصله‌های تکراری
 */
export function sanitizePersian(text: string): string {
  if (!text) return text;
  let out = String(text);
  // خط تیرهٔ بلند/نیم‌بلند بین دو بخش جمله معمولاً نقش «؛» دارد
  out = out.replace(/(\S)\s*[\u2014\u2013]\s*(\S)/g, '$1؛ $2');
  // باقی‌مانده‌ها (ابتدا/انتهای خط) حذف می‌شوند
  out = out.replace(FORBIDDEN_DASHES, '');
  // فاصله‌های چندتایی
  out = out.replace(/ {2,}/g, ' ');
  return out.trim();
}

/** بررسی سریع: آیا متن خط تیرهٔ ممنوعه دارد؟
 * نکتهٔ فنی: از رگ‌اکس جدا بدون پرچم g استفاده می‌شود؛ رگ‌اکس سراسری
 * مشترک با test حالت‌مند است (lastIndex) و یک‌درمیان جواب اشتباه می‌داد —
 * همین باگ باعث رد شدن U+2014 از گیت نهایی تیم content شده بود. */
export function hasForbiddenDash(text: string): boolean {
  return /\u2014|\u2013/.test(String(text ?? ''));
}

/**
 * گریز (escape) رشته برای قرار گرفتن در آبجکت TypeScript با دابل‌کوتیشن.
 * بک‌اسلش، دابل‌کوتیشن و کاراکترهای کنترلی گریز می‌شوند.
 */
export function escapeTsString(value: string): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '')
    .replace(/\t/g, '\\t');
}
