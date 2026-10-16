/**
 * lib/__tests__/llm-response-quality.test.mts
 * تست اعتبارسنجی کیفیت پاسخ مدل (validateResponseQuality).
 * ریشه‌ی باگ seo: مدل فقط `{"` برمی‌گرداند؛ روتر آن را «موفق» ثبت می‌کرد و
 * در تلاش‌های بعدی همان مدل خراب را اولویت می‌داد.
 * اجرا: npx tsx --test lib/__tests__/llm-response-quality.test.mts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateResponseQuality } from '../llm.js';

describe('validateResponseQuality', () => {
  it('پاسخ منحط `{"` با expectJson رد می‌شود', () => {
    const err = validateResponseQuality('{"', { expectJson: true });
    assert.ok(err, 'باید خطا برگرداند');
    assert.match(err as string, /منحط/);
  });

  it('پاسخ خالی با expectJson رد می‌شود', () => {
    assert.ok(validateResponseQuality('   ', { expectJson: true }));
  });

  it('JSON کوتاه ولی واقعی قبول می‌شود', () => {
    assert.equal(
      validateResponseQuality('{"approved": true}', { expectJson: true }),
      null,
    );
  });

  it('بدون expectJson و minLength، هیچ محدودیتی نیست (رفتار قدیمی)', () => {
    assert.equal(validateResponseQuality('{"', {}), null);
    assert.equal(validateResponseQuality('بله', {}), null);
  });

  it('minLength صریح اعمال می‌شود', () => {
    assert.ok(validateResponseQuality('short', { minLength: 10 }));
    assert.equal(validateResponseQuality('long enough text', { minLength: 10 }), null);
  });

  it('expectJson با minLength صریح، minLength را مقدم می‌دارد', () => {
    // ۲۰ نویسه با حداقل ۵۰ رد می‌شود
    assert.ok(
      validateResponseQuality('{"a": "123456789012"}', { expectJson: true, minLength: 50 }),
    );
  });
});
