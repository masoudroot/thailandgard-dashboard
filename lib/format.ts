/** ابزارهای فارسی‌سازی عدد برای لایهٔ نمایش (مشترک بین کامپوننت‌ها). */

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/**
 * ارقام لاتین را به فارسی تبدیل می‌کند (بدون تغییر قالب‌بندی).
 * برای هر عددی که کاربر می‌بیند (شمارش، درصد، زمان، امتیاز...) از همین استفاده کنید.
 */
export function faDigits(value: number | string): string {
  return String(value).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]);
}

/** مثل faDigits؛ جداکنندهٔ هزارگان لاتین را هم به فارسی (٬) تبدیل می‌کند. */
export function faNum(value: number | string): string {
  return faDigits(value).replace(/,/g, '٬');
}

/** عدد با جداکنندهٔ هزارگان فارسی (٬). */
export function faNumGrouped(value: number | string): string {
  return faNum(Number(value).toLocaleString('en-US'));
}

/** درصد فارسی، مثلاً «۶۸٪». */
export function faPct(value: number): string {
  return `${faDigits(Math.round(value))}٪`;
}
