/** ابزارهای فارسی‌سازی عدد برای لایهٔ نمایش (مشترک بین کامپوننت‌ها). */

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** ارقام لاتین را به فارسی تبدیل می‌کند؛ جداکنندهٔ هزارگان را هم فارسی می‌کند. */
export function faNum(value: number | string): string {
  return String(value)
    .replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)])
    .replace(/,/g, '٬');
}
