/**
 * هوک resolve برای تست یکپارچگی نقد←دانش.
 *
 * ایمپورت‌های '../rag' و '../api'ِ ماژول زیر تست را به فیکسچرهای
 * حافظه‌ای fixtures/ هدایت می‌کند تا تست بدون شبکه و دیتابیس واقعی
 * اجرا شود. ثبت با module.register در ابتدای فایل تست انجام می‌شود
 * و باید پیش از ایمپورت critic-knowledge باشد.
 */
const dir = new URL('./fixtures/', import.meta.url);

export async function resolve(specifier, context, next) {
  if (specifier === '../rag') {
    return { url: new URL('fake-rag.mjs', dir).href, shortCircuit: true };
  }
  if (specifier === '../api') {
    return { url: new URL('fake-api.mjs', dir).href, shortCircuit: true };
  }
  return next(specifier, context);
}
