/**
 * تست حلقه نقد سه‌مرحله‌ای → دانش (lib/knowledge/critic-knowledge.ts).
 *
 * اجرا: npx tsx --test lib/knowledge/__tests__/critic-feedback-loop.test.mts
 * (پسوند mts. عمدی است تا از tsc سخت‌گیرانه‌ی ریپو خارج بماند)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFeedbackRoundContent,
  buildFinalVerdictContent,
  recordFeedbackRound,
  recordCriticFinalVerdict,
  extractCriticKnowledge,
  feedbackRoundLog,
  type CriticRoundRecord,
} from '../critic-knowledge';
import { storeCriticFinalVerdict } from '../../knowledge-subagent';

// بدون env سوپابیس: مسیر fail-soft باید بدون throw برگردد
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const ROUNDS: CriticRoundRecord[] = [
  {
    round: 1,
    approved: false,
    reason: 'شعار فقط یک کاراکتر بی‌معنی «#» است؛ هیچ متنی برای ارزیابی لحن وجود ندارد.',
    instruction: 'سه شعار فارسی ۵ تا ۷ کلمه‌ای بنویس؛ هر کدام با فعل امر شروع شود و بدون کلیشه «بهترین» باشد.',
    outcome: 'سه شعار نوشته شد ولی هر سه با «بهترین» شروع شدند.',
  },
  {
    round: 2,
    approved: false,
    reason: 'هر سه شعار با واژه ممنوعه «بهترین» شروع شدند؛ دستور دور ۱ رعایت نشد.',
    instruction: 'همان سه شعار را بازنویسی کن؛ واژه «بهترین» و هر صفت تفضیلی حذف شود.',
    outcome: 'شعارها بازنویسی شدند؛ دو شعار سالم، یکی هنوز کلیشه‌ای.',
  },
  {
    round: 3,
    approved: true,
    reason: 'دو شعار استاندارد لحن را پاس کردند؛ سومی با اصلاح جزئی قابل قبول است.',
  },
];

describe('buildFeedbackRoundContent', () => {
  it('دلیل کامل، دستور منتقد و نتیجه را در محتوا می‌آورد', () => {
    const { title, content } = buildFeedbackRoundContent('branding', 'run-abc123', ROUNDS[0], 'لحن برند');
    assert.match(title, /دور 1/);
    assert.match(title, /رد شد/);
    assert.match(content, /شعار فقط یک کاراکتر بی‌معنی/);
    assert.match(content, /دستور منتقد برای اصلاح: سه شعار فارسی/);
    assert.match(content, /نتیجه اجرای دستور توسط تیم: سه شعار نوشته شد/);
    assert.match(content, /قاعده آینده/);
  });

  it('دور تأییدشده بخش دستور ندارد ولی قاعده تکرار دارد', () => {
    const { content } = buildFeedbackRoundContent('branding', 'run-abc123', ROUNDS[2]);
    assert.match(content, /تأیید شد/);
    assert.doesNotMatch(content, /دستور منتقد برای اصلاح/);
    assert.match(content, /تکرار شود/);
  });
});

describe('buildFinalVerdictContent', () => {
  it('تاریخچه هر سه دور + نظر نهایی را می‌آورد', () => {
    const { title, content } = buildFinalVerdictContent(
      'branding',
      'run-abc123',
      ROUNDS,
      'الگوی «شروع با صفت تفضیلی» در این تیم ممنوع است؛ قبل از تحویل با لیست واژگان ممنوعه کنترل شود.',
      'لحن برند',
    );
    assert.match(title, /نظر نهایی منتقد/);
    assert.match(content, /دور ۳: فقط نظارت، بدون رد/);
    assert.match(content, /دور 1: رد شد/);
    assert.match(content, /دور 2: رد شد/);
    assert.match(content, /دور 3: تأیید شد/);
    assert.match(content, /دستور داده‌شده: سه شعار فارسی/);
    assert.match(content, /نظر نهایی منتقد: الگوی «شروع با صفت تفضیلی»/);
  });

  it('دورها را مرتب می‌کند حتی اگر نامرتب داده شوند', () => {
    const { content } = buildFinalVerdictContent('branding', 'r1', [ROUNDS[2], ROUNDS[0]], 'نظر');
    const i1 = content.indexOf('دور 1:');
    const i3 = content.indexOf('دور 3:');
    assert.ok(i1 < i3, 'دور ۱ باید قبل از دور ۳ بیاید');
  });
});

describe('fail-soft بدون دیتابیس', () => {
  it('recordFeedbackRound بدون throw و با ok:false برمی‌گردد', async () => {
    const res = await recordFeedbackRound('branding', 'run-x', ROUNDS[0]);
    assert.equal(res.ok, false);
    assert.ok(res.error);
  });

  it('recordCriticFinalVerdict بدون throw و با ok:false برمی‌گردد', async () => {
    const res = await recordCriticFinalVerdict('branding', 'run-x', ROUNDS, 'نظر نهایی');
    assert.equal(res.ok, false);
  });

  it('storeCriticFinalVerdict ساب‌ایجنت دانش هم fail-soft است', async () => {
    const res = await storeCriticFinalVerdict('branding', 'run-x', ROUNDS, 'نظر نهایی');
    assert.equal(res.ok, false);
    assert.ok(res.error);
  });

  it('extractCriticKnowledge غنی‌شده هم fail-soft است', async () => {
    const res = await extractCriticKnowledge(
      'branding',
      {
        approved: false,
        reason: 'رد شد',
        instruction: 'دستور دقیق',
        round: 2,
        rounds: ROUNDS.slice(0, 2),
      },
      'run-x',
    );
    assert.equal(res.ok, false);
  });
});

describe('feedbackRoundLog', () => {
  it('پیام فارسی موفق و ناموفق می‌سازد', () => {
    assert.match(feedbackRoundLog({ ok: true, title: 'ت' }, 2), /درس دور 2 حلقه نقد ثبت شد/);
    assert.match(feedbackRoundLog({ ok: false, error: 'خطا' }, 1), /ثبت درس دور 1 ناموفق/);
  });
});
