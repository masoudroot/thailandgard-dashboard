/**
 * تست‌های طبقه‌بندی سلامت تیم (lib/team-health.ts).
 *
 * منطق خالص classifyTeamRun بدون دیتابیس تست می‌شود؛ سناریوی اصلی،
 * بازتولید باگ «نگهبان هنگ را نمی‌بیند» است: تیمی که ضربان می‌زند ولی
 * پیشرفتی نمی‌کند باید hung شناخته شود، نه healthy.
 *
 * اجرا: npx tsx --test worker/__tests__/team-health.test.mts
 * (پسوند mts. عمدی است تا از tsc سخت‌گیرانه‌ی ریپو خارج بماند)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTeamRun, HANG_NO_PROGRESS_MS, DEAD_HEARTBEAT_MS } from '../../lib/team-health';

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60 * 1000;

describe('classifyTeamRun', () => {
  it('آستانه‌ها همان مقادیر قراردادی‌اند (هنگ ۱۰ دقیقه، مرگ ۱۵ دقیقه)', () => {
    assert.equal(HANG_NO_PROGRESS_MS, 10 * MIN);
    assert.equal(DEAD_HEARTBEAT_MS, 15 * MIN);
  });

  it('تیم سالم: ضربان تازه + پیشرفت تازه → healthy', () => {
    assert.equal(
      classifyTeamRun({
        status: 'running',
        heartbeatAt: iso(30 * 1000),
        updatedAt: iso(2 * MIN),
        startedAt: iso(20 * MIN),
        now: NOW,
      }),
      'healthy',
    );
  });

  it('سناریوی باگ: ضربان زنده ولی ۱۱ دقیقه بدون پیشرفت → hung', () => {
    // قلب باگ قدیمی: heartbeat هر ۶۰ ثانیه updated_at را تازه نگه می‌داشت
    // و تیم هنگ‌کرده «سالم» دیده می‌شد. حالا updated_at فقط پیشرفت واقعی است.
    assert.equal(
      classifyTeamRun({
        status: 'running',
        heartbeatAt: iso(45 * 1000), // ضربان ۴۵ ثانیه پیش: فرایند زنده است
        updatedAt: iso(11 * MIN), // آخرین پیشرفت واقعی ۱۱ دقیقه پیش
        startedAt: iso(30 * MIN),
        now: NOW,
      }),
      'hung',
    );
  });

  it('مرز آستانه: ۹ دقیقه بی‌پیشرفت هنوز healthy است', () => {
    assert.equal(
      classifyTeamRun({
        status: 'running',
        heartbeatAt: iso(30 * 1000),
        updatedAt: iso(9 * MIN),
        startedAt: iso(30 * MIN),
        now: NOW,
      }),
      'healthy',
    );
  });

  it('مرگ فرایند: ۱۶ دقیقه بدون ضربان → dead (حتی اگر پیشرفتی هم بوده)', () => {
    assert.equal(
      classifyTeamRun({
        status: 'running',
        heartbeatAt: iso(16 * MIN),
        updatedAt: iso(16 * MIN),
        startedAt: iso(40 * MIN),
        now: NOW,
      }),
      'dead',
    );
  });

  it('مرگ بر هنگ اولویت دارد', () => {
    assert.equal(
      classifyTeamRun({
        status: 'running',
        heartbeatAt: iso(20 * MIN),
        updatedAt: iso(25 * MIN),
        startedAt: iso(60 * MIN),
        now: NOW,
      }),
      'dead',
    );
  });

  it('تیم غیر-running نادیده گرفته می‌شود (healthy)', () => {
    for (const status of ['success', 'failed', 'pending', 'stopped', 'rejected', 'skipped']) {
      assert.equal(
        classifyTeamRun({ status, heartbeatAt: iso(60 * MIN), updatedAt: iso(60 * MIN), now: NOW }),
        'healthy',
      );
    }
  });

  it('ردیف قدیمی بدون heartbeat_at: به updated_at برمی‌گردد', () => {
    // سازگاری با ردیف‌های پیش از مایگریشن ضربان
    assert.equal(
      classifyTeamRun({ status: 'running', updatedAt: iso(11 * MIN), startedAt: iso(30 * MIN), now: NOW }),
      'hung',
    );
    assert.equal(
      classifyTeamRun({ status: 'running', updatedAt: iso(20 * MIN), startedAt: iso(30 * MIN), now: NOW }),
      'dead',
    );
    assert.equal(
      classifyTeamRun({ status: 'running', updatedAt: iso(2 * MIN), startedAt: iso(30 * MIN), now: NOW }),
      'healthy',
    );
  });

  it('تیمی که تازه شروع شده healthy است', () => {
    assert.equal(
      classifyTeamRun({ status: 'running', startedAt: iso(30 * 1000), now: NOW }),
      'healthy',
    );
  });

  it('نمایش باگ قدیمی: منطق قبلی (مبنای updated_atِ آلوده به ضربان) هرگز hung نمی‌داد', () => {
    // شبیه‌سازی منطق قدیمی cycle-worker: teamHeartbeat از روی updated_at
    // خوانده می‌شد که ضربان هر ۶۰ ثانیه تازه‌اش می‌کرد.
    const oldClassify = (updatedAtMs: number, nowMs: number) =>
      nowMs - updatedAtMs > 15 * MIN ? 'stuck' : 'healthy';
    // تیم ۴۵ دقیقه است که پیشرفتی نکرده ولی ضربان updated_at را تازه نگه داشته:
    const pollutedUpdatedAt = NOW - 45 * 1000;
    assert.equal(oldClassify(pollutedUpdatedAt, NOW), 'healthy'); // باگ: همیشه سالم
    // منطق جدید با همان ورودیِ واقعی:
    assert.equal(
      classifyTeamRun({
        status: 'running',
        heartbeatAt: iso(45 * 1000),
        updatedAt: iso(45 * MIN), // پیشرفت واقعی ۴۵ دقیقه پیش
        startedAt: iso(60 * MIN),
        now: NOW,
      }),
      'hung',
    );
  });
});
