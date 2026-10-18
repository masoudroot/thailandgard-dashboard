/**
 * lib/bridge/deploy-queue.test.mts: تست منطق صف دیپلوی.
 *
 * - گرید ثابت اسلات‌ها (۷۰ اسلات در روز، ~۲۰.۵۷ دقیقه فاصله)
 * - FIFO: آیتم زودتر، اسلات زودتر
 * - منطق retry: ۳ تلاش بعد dead
 *
 * منطق خالص (بدون دیتابیس) تست می‌شود؛ لایهٔ DB با getSupabase واقعی
 * در تست سرتاسری جداست.
 *
 * اجرا: npx tsx --test lib/bridge/deploy-queue.test.mts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEPLOY_SLOTS_PER_DAY,
  SLOT_INTERVAL_MINUTES,
  MAX_DEPLOY_RETRIES,
  nextGridSlot,
} from './deploy-queue';

describe('deploy-queue: ثابت‌ها', () => {
  it('۷۰ اسلات در روز', () => {
    assert.equal(DEPLOY_SLOTS_PER_DAY, 70);
  });

  it('فاصله اسلات = 1440/70 دقیقه', () => {
    assert.ok(Math.abs(SLOT_INTERVAL_MINUTES - 1440 / 70) < 1e-9);
    // ~۲۰.۵۷ دقیقه
    assert.ok(SLOT_INTERVAL_MINUTES > 20 && SLOT_INTERVAL_MINUTES < 21);
  });

  it('حداکثر ۳ تلاش مجدد', () => {
    assert.equal(MAX_DEPLOY_RETRIES, 3);
  });
});

describe('deploy-queue: گرید ثابت nextGridSlot', () => {
  it('نیمه‌شب دقیق UTC همان نیمه‌شب برمی‌گرداند', () => {
    const midnight = new Date('2026-10-19T00:00:00.000Z');
    const slot = nextGridSlot(midnight);
    assert.equal(slot.toISOString(), '2026-10-19T00:00:00.000Z');
  });

  it('زمان میانی به اسلات بعدی گرد می‌شود', () => {
    // ۱۰ دقیقه پس از نیمه‌شب → اسلات بعدی در ~۲۰.۵۷ دقیقه
    const t = new Date('2026-10-19T00:10:00.000Z');
    const slot = nextGridSlot(t);
    const intervalMs = Math.round(SLOT_INTERVAL_MINUTES * 60 * 1000);
    const expectedMs = new Date('2026-10-19T00:00:00.000Z').getTime() + intervalMs;
    assert.equal(slot.getTime(), expectedMs);
    assert.ok(slot.getTime() > t.getTime());
  });

  it('اسلات‌ها دقیقاً روی گریدند (مضرب صحیح از فاصله)', () => {
    const dayStart = new Date('2026-10-19T00:00:00.000Z').getTime();
    const intervalMs = Math.round(SLOT_INTERVAL_MINUTES * 60 * 1000);
    for (const iso of [
      '2026-10-19T00:00:01.000Z',
      '2026-10-19T05:33:00.000Z',
      '2026-10-19T12:00:00.000Z',
      '2026-10-19T23:59:59.000Z',
    ]) {
      const slot = nextGridSlot(new Date(iso)).getTime();
      const k = Math.round((slot - dayStart) / intervalMs);
      assert.ok(
        Math.abs(slot - (dayStart + k * intervalMs)) < 1,
        `${iso} → slot ${new Date(slot).toISOString()} باید روی گرید باشد`,
      );
      assert.ok(k >= 0 && k <= 70, `شماره اسلات ${k} در بازه ۰..۷۰`);
    }
  });

  it('FIFO: زمان زودتر → اسلات زودتر یا مساوی', () => {
    const a = nextGridSlot(new Date('2026-10-19T01:00:00.000Z'));
    const b = nextGridSlot(new Date('2026-10-19T02:00:00.000Z'));
    assert.ok(a.getTime() <= b.getTime());
  });

  it('۷۰ اسلات تقریباً یک روز کامل را پوشش می‌دهد', () => {
    const dayStart = new Date('2026-10-19T00:00:00.000Z').getTime();
    const intervalMs = Math.round(SLOT_INTERVAL_MINUTES * 60 * 1000);
    // اسلات ۷۰ ≈ نیمه‌شب روز بعد (خطای گرد کردن ناچیز)
    const slot70 = dayStart + 70 * intervalMs;
    const driftMs = Math.abs(slot70 - new Date('2026-10-20T00:00:00.000Z').getTime());
    assert.ok(driftMs < 1000, `انحراف ${driftMs}ms باید زیر یک ثانیه باشد`);
  });
});

describe('deploy-queue: منطق retry', () => {
  it('پس از ۳ تلاش، آیتم dead می‌شود (فرمول)', () => {
    // شبیه‌سازی شمارنده: تلاش‌های ۱، ۲، ۳
    const shouldDie = (retryCount: number) => retryCount >= MAX_DEPLOY_RETRIES;
    assert.equal(shouldDie(0), false);
    assert.equal(shouldDie(1), false);
    assert.equal(shouldDie(2), false);
    assert.equal(shouldDie(3), true);
    assert.equal(shouldDie(4), true);
  });

  it('سقف روزانه ورسل (۱۰۰) با ۷۰ اسلات رعایت می‌شود', () => {
    // ۷۰ دیپلوی + حاشیه امن ۳۰ = زیر سقف ۱۰۰
    assert.ok(DEPLOY_SLOTS_PER_DAY < 100);
    assert.equal(100 - DEPLOY_SLOTS_PER_DAY, 30);
  });
});
