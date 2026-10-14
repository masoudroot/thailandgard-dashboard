/* ابزارهای نمایشی فارسی: مشترک بین همهٔ کامپوننت‌های دیتاویز. */

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** تبدیل ارقام لاتین به فارسی. */
export function faNum(value: number | string): string {
  return String(value).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]);
}

/** عدد با جداکنندهٔ هزارگان فارسی (٬). */
export function faNumGrouped(value: number | string): string {
  const latin = Number(value).toLocaleString('en-US');
  return faNum(latin).replace(/,/g, '٬');
}

/** درصد فارسی، مثلاً «۶۸٪». */
export function faPct(value: number): string {
  return `${faNum(Math.round(value))}٪`;
}
