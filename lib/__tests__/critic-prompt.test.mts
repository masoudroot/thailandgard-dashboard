/**
 * lib/__tests__/critic-prompt.test.mts
 * تست پرامپت‌ساز مشترک منتقد (lib/critic-prompt.ts).
 * اجرا: npx tsx --test lib/__tests__/critic-prompt.test.mts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCriticPrompt,
  buildWorkerRetryPrompt,
  summarizePreviousFeedback,
  MAX_CRITIC_ROUNDS,
} from '../critic-prompt.js';

describe('buildCriticPrompt', () => {
  it('دور ۱: رد مجاز است و شرح کامل + دستور دقیق خواسته می‌شود', () => {
    const r = buildCriticPrompt('dev', 'خروجی نمونه', 1, {
      criteria: 'کد باید معتبر باشد.',
    });
    assert.equal(r.canReject, true);
    assert.match(r.prompt, /rejection_detail/);
    assert.match(r.prompt, /fix_instructions/);
    assert.match(r.prompt, /شاهد/); // مطالبه شاهد از خروجی
    assert.match(r.prompt, /چه چیزی ← کجا ← دقیقاً چطور/);
    assert.match(r.prompt, /خودت خروجی را اصلاح نکن/);
    assert.match(r.prompt, /کد باید معتبر باشد/); // معیار اختصاصی تزریق شد
  });

  it('دور ۲: رد مجاز است و بازخورد دور قبل تزریق می‌شود', () => {
    const r = buildCriticPrompt('seo', 'خروجی نمونه', 2, {
      previousFeedback: 'دور ۱: رد شد چون متا طولانی بود.',
    });
    assert.equal(r.canReject, true);
    assert.match(r.prompt, /دور ۱: رد شد چون متا طولانی بود/);
    assert.match(r.prompt, /دور ۲ از حداکثر ۳/);
  });

  it('دور ۳: داوری نهایی با حق رد صادقانه، بدون دور اصلاح', () => {
    const r = buildCriticPrompt('content', 'خروجی نمونه', 3);
    assert.equal(r.canReject, true);
    assert.match(r.prompt, /پایانی/);
    assert.match(r.prompt, /approved=false/);
    assert.match(r.prompt, /final_opinion/);
    assert.match(r.prompt, /دانش تیم/);
  });

  it('بدون معیار اختصاصی، معیار عمومی به کار می‌رود', () => {
    const r = buildCriticPrompt('qa', 'خروجی', 1);
    assert.match(r.prompt, /معیارهای داوری/);
    assert.match(r.prompt, /placeholder/);
  });

  it('خروجی طولانی بریده می‌شود', () => {
    const big = 'x'.repeat(60000);
    const r = buildCriticPrompt('dev', big, 1);
    assert.ok(r.prompt.length < big.length);
    assert.match(r.prompt, /بریده شد/);
  });

  it('هیچ خط تیره بلندی (U+2014) در پرامپت‌ها نیست', () => {
    for (const round of [1, 2, 3] as const) {
      const r = buildCriticPrompt('dev', 'خروجی', round);
      assert.ok(!r.system.includes('\u2014'), `system دور ${round}`);
      assert.ok(!r.prompt.includes('\u2014'), `prompt دور ${round}`);
    }
    const w = buildWorkerRetryPrompt('dev', 'دستور', 2, 'قبلی');
    assert.ok(!w.includes('\u2014'));
  });

  it('کلیدهای JSON در همه دورها یکسان‌اند', () => {
    for (const round of [1, 2, 3] as const) {
      const r = buildCriticPrompt('branding', 'خروجی', round);
      for (const key of ['approved', 'rejection_detail', 'fix_instructions', 'final_opinion']) {
        assert.match(r.prompt, new RegExp(key), `دور ${round} کلید ${key}`);
      }
    }
  });
});

describe('buildWorkerRetryPrompt', () => {
  it('دستور منتقد را بی‌کم‌وکاست می‌آورد و سؤال را ممنوع می‌کند', () => {
    const p = buildWorkerRetryPrompt('design', '۱. فایل a را بساز.', 2, 'خروجی قبلی');
    assert.match(p, /۱. فایل a را بساز/);
    assert.match(p, /سؤال نپرس/);
    assert.match(p, /دور ۲ اجراست/);
    assert.match(p, /خروجی قبلی/);
  });

  it('بدون دستور هم خروجی معتبر می‌دهد', () => {
    const p = buildWorkerRetryPrompt('dev', '', 3);
    assert.match(p, /دور ۳ اجراست/);
  });
});

describe('summarizePreviousFeedback', () => {
  it('خلاصه دورهای قبل را می‌سازد', () => {
    const s = summarizePreviousFeedback([
      { approved: false, rejection_detail: 'کد ناقص بود', fix_instructions: 'فایل کامل بده' },
      { approved: true, rejection_detail: '', fix_instructions: '' },
    ]);
    assert.match(s, /دور ۱: رد شد/);
    assert.match(s, /کد ناقص بود/);
    assert.match(s, /دور ۲: تأیید شد/);
  });
});

describe('ثابت‌ها', () => {
  it('حداکثر ۳ دور است', () => {
    assert.equal(MAX_CRITIC_ROUNDS, 3);
  });
});
