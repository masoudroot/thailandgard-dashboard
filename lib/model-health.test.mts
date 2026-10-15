/**
 * lib/model-health.test.mts: تست توابع خالص ردیابی سلامت مدل‌ها.
 * اجرا: npx tsx --test lib/model-health.test.mts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COOLDOWN_POLICY,
  classifyError,
  endpointKey,
  normModelKey,
  isModelHealthy,
  recordModelFailure,
  recordModelSuccess,
  getCooldownKeys,
  getUnhealthyModels,
  type ModelErrorType,
} from './model-health.ts';

describe('classifyError', () => {
  it('وضعیت 429 از آبجکت خطا', () => {
    assert.equal(classifyError({ status: 429, message: 'x' }), 'rate_limit_429');
  });
  it('وضعیت 503', () => {
    assert.equal(classifyError({ status: 503 }), 'service_503');
  });
  it('وضعیت 401 و 403', () => {
    assert.equal(classifyError({ status: 401 }), 'auth_401');
    assert.equal(classifyError({ status: 403 }), 'auth_403');
  });
  it('وضعیت 404', () => {
    assert.equal(classifyError({ status: 404 }), 'not_found_404');
  });
  it('کد داخل متن فارسی («خطای 429»)', () => {
    assert.equal(classifyError('خطای 429'), 'rate_limit_429');
    assert.equal(classifyError('خطای 503'), 'service_503');
    assert.equal(classifyError('خطای 401 (کلید)'), 'auth_401');
    assert.equal(classifyError('خطای 404'), 'not_found_404');
  });
  it('تایم‌اوت فارسی و انگلیسی', () => {
    assert.equal(classifyError('تایم‌اوت'), 'timeout');
    assert.equal(classifyError(new Error('request timed out')), 'timeout');
  });
  it('خطای شبکه', () => {
    assert.equal(classifyError(new Error('fetch failed')), 'network');
  });
  it('مدل منسوخ گوگل', () => {
    assert.equal(
      classifyError(new Error('This model models/gemini-2.5-flash is no longer available')),
      'not_found_404',
    );
  });
  it('ناشناخته', () => {
    assert.equal(classifyError(new Error('چیز عجیبی شد')), 'unknown');
    assert.equal(classifyError(null), 'unknown');
  });
});

describe('COOLDOWN_POLICY', () => {
  it('همه‌ی انواع خطا سیاست دارند', () => {
    const types: ModelErrorType[] = [
      'rate_limit_429', 'service_503', 'timeout', 'network',
      'auth_401', 'auth_403', 'not_found_404', 'unknown',
    ];
    for (const t of types) {
      const r = COOLDOWN_POLICY[t];
      assert.ok(r.baseMin > 0, t);
      assert.ok(r.capMin >= r.baseMin, t);
      assert.ok(r.fa.length > 0, t);
    }
  });
  it('429 پایه ۵ دقیقه، 404 پایه ۲۴ ساعت', () => {
    assert.equal(COOLDOWN_POLICY.rate_limit_429.baseMin, 5);
    assert.equal(COOLDOWN_POLICY.not_found_404.baseMin, 1440);
  });
});

describe('helpers', () => {
  it('normModelKey: حذف models/ و حروف کوچک', () => {
    assert.equal(normModelKey('models/gemini-3.8-flash'), 'gemini-3.8-flash');
    assert.equal(normModelKey('GLM-5.3-Flash'), 'glm-5.3-flash');
  });
  it('endpointKey: ترجیح endpointId', () => {
    assert.equal(endpointKey('abc', 'https://x'), 'abc');
    assert.equal(endpointKey('', 'https://x'), 'env:https://x');
    assert.equal(endpointKey(null, undefined), 'env:default');
  });
});

describe('fail-soft بدون دیتابیس', () => {
  it('isModelHealthy بدون env سالم برمی‌گرداند (هرگز تماس را نمی‌شکند)', async () => {
    const s = await isModelHealthy('nope', 'nope');
    assert.equal(s.healthy, true);
  });
  it('recordModelFailure بدون env null برمی‌گرداند', async () => {
    const r = await recordModelFailure('nope', 'nope', 'rate_limit_429');
    assert.equal(r, null);
  });
  it('recordModelSuccess بدون env خطا نمی‌دهد', async () => {
    await recordModelSuccess('nope', 'nope');
  });
  it('getCooldownKeys بدون env مجموعه‌ی خالی', async () => {
    const s = await getCooldownKeys(['a', 'b']);
    assert.equal(s.size, 0);
  });
  it('getUnhealthyModels بدون env آرایه‌ی خالی', async () => {
    const arr = await getUnhealthyModels();
    assert.deepEqual(arr, []);
  });
});
