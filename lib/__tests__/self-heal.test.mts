/**
 * lib/__tests__/self-heal.test.mts
 * تست خودترمیمی در لحظه (lib/self-heal.ts).
 * دستور مسعود: اگه خروجی خراب بود، سیستم و اون تیم باید در لحظه درست بشن.
 * اجرا: npx tsx --test lib/__tests__/self-heal.test.mts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { errorSignature } from '../self-heal.js';

describe('errorSignature', () => {
  it('خطاهای یکسان با اعداد متفاوت، امضای یکسان می‌گیرند', () => {
    const a = errorSignature('LLM output was not valid JSON: { at line 123}');
    const b = errorSignature('LLM output was not valid JSON: { at line 456}');
    assert.equal(a, b);
  });

  it('خطاهای متفاوت، امضای متفاوت می‌گیرند', () => {
    const a = errorSignature('LLM output was not valid JSON');
    const b = errorSignature('timeout after 30000ms');
    assert.notEqual(a, b);
  });

  it('خطای خالی امضای خالی می‌دهد', () => {
    assert.equal(errorSignature(''), '');
    assert.equal(errorSignature(null), '');
    assert.equal(errorSignature(undefined), '');
  });

  it('حروف بزرگ/کوچک یکسان‌سازی می‌شود', () => {
    const a = errorSignature('Rate Limit Exceeded');
    const b = errorSignature('rate limit exceeded');
    assert.equal(a, b);
  });

  it('شناسه‌های طولانی حذف می‌شوند', () => {
    const a = errorSignature('failed for team run 550e8400-e29b-41d4-a716-446655440000');
    const b = errorSignature('failed for team run 6ba7b810-9dad-11d1-80b4-00c04fd430c8');
    assert.equal(a, b);
  });
});
