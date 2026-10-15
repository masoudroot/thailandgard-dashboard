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

/** ارقام فارسی (۰-۹) و عربی (٠-٩) را به لاتین تبدیل می‌کند. */
export function enDigits(value: string): string {
  return String(value)
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

/**
 * ورودی عددی کاربر را تمیز می‌کند: ارقام فارسی/عربی ← لاتین، حذف بقیه کاراکترها.
 * خروجی برای Number() و ذخیره امن است.
 */
export function cleanNumberInput(value: string): string {
  return enDigits(value).replace(/[^0-9]/g, '');
}

/** parse امن عدد از ورودی فارسی/لاتین؛ نامعتبر → NaN. */
export function parseFaNumber(value: string | number): number {
  if (typeof value === 'number') return value;
  const clean = cleanNumberInput(value);
  return clean === '' ? NaN : Number(clean);
}
