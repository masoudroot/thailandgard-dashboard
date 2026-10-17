/**
 * تست‌های رگرسیون باگ‌های ۱۴۰۵/۰۷/۲۵ (چرخه‌ی run-20261017044522-rq2ho6):
 *
 * ۱. «enqueueTask failed: [object Object]» : خطای بی‌پیام لبه‌ی سوپابیس
 *    (آبجکت خالی {}) نباید به «[object Object]» فروکاسته شود؛ formatError
 *    باید وضعیت HTTP را نشان بدهد.
 * ۲. تسک یتیم : وقتی فرایند تیم بدون settle می‌میرد (ری‌بوت ماشین)،
 *    sweepHungTeams باید تسک in_progress تیم را با سرنوشت interrupted ببندد
 *    تا چرخه‌ی بعدی همان تسک کهنه را دوباره تحویل نگیرد.
 *
 * اجرا: npx tsx --test worker/__tests__/taskqueue-errors.test.mts
 * (پسوند mts. عمدی است تا از tsc سخت‌گیرانه‌ی ریپو خارج بماند)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakePostgrest, seedDb, readTables } from './fake-postgrest.mjs';

let fake: Awaited<ReturnType<typeof startFakePostgrest>>;

before(async () => {
  fake = await startFakePostgrest();
  process.env.SUPABASE_URL = fake.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  // ایمپورت دیرهنگام: getSupabase تنبل است ولی برای اطمینان env اول ست می‌شود
  const tq = await import('../../lib/taskqueue');
  const th = await import('../../lib/team-health');
  (globalThis as any).__tq = tq;
  (globalThis as any).__th = th;
});

after(async () => {
  await fake.close();
});

const tq = () => (globalThis as any).__tq as typeof import('../../lib/taskqueue');
const th = () => (globalThis as any).__th as typeof import('../../lib/team-health');

describe('formatError: هرگز [object Object] برنگردان', () => {
  it('آبجکت خالی (خطای بی‌پیام لبه) → نشانگر خوانا، نه [object Object]', () => {
    const out = tq().formatError({});
    assert.notEqual(out, '[object Object]');
    assert.match(out, /بدون پیام/);
  });

  it('خطای بی‌پیام با وضعیت HTTP → وضعیت HTTP دیده می‌شود', () => {
    // همان چیزی که insertRow حالا روی خطای خام سوپابیس می‌چسباند
    const out = tq().formatError(Object.assign({}, { status: 502, statusText: 'Bad Gateway' }));
    assert.notEqual(out, '[object Object]');
    assert.match(out, /502/);
  });

  it('رفتار قبلی برای خطاهای معمولی حفظ شده', () => {
    assert.equal(tq().formatError(new Error('boom')), 'boom');
    const pg = tq().formatError({ message: 'duplicate key', code: '23505' });
    assert.match(pg, /duplicate key/);
    assert.match(pg, /23505/);
    assert.equal(tq().formatError('plain string'), 'plain string');
    assert.equal(tq().formatError(null), 'null');
  });
});

describe('settleOrphanedClaimedTasks: بستن تسک یتیم', () => {
  it('تسک in_progress همین چرخه → done با سرنوشت interrupted؛ بقیه دست‌نخورده', async () => {
    await seedDb(fake.url, {
      cycles: [{ id: 'cycle-1', run_id: 'run-1', status: 'running', started_at: new Date().toISOString() }],
      build_queue: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          team: 'content',
          run_id: 'cycle-1',
          title: 'تسک یتیم',
          status: 'in_progress',
          result: null,
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          team: 'content',
          run_id: 'cycle-1',
          title: 'تسک تمام‌شده',
          status: 'done',
          result: 'قبلاً بسته شده',
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          team: 'seo',
          run_id: 'cycle-1',
          title: 'تسک تیم دیگر',
          status: 'in_progress',
          result: null,
        },
      ],
    });
    const n = await tq().settleOrphanedClaimedTasks('content', 'cycle-1', 'دلیل تست');
    assert.equal(n, 1);
    const tables = await readTables(fake.url);
    const rows = tables['build_queue'] as any[];
    const orphan = rows.find((r) => r.id === '11111111-1111-4111-8111-111111111111');
    assert.equal(orphan.status, 'done');
    assert.match(orphan.result, /نقطهٔ پایانی شناخته‌شده/);
    assert.match(orphan.result, /دلیل تست/);
    const doneOne = rows.find((r) => r.id === '22222222-2222-4222-8222-222222222222');
    assert.equal(doneOne.result, 'قبلاً بسته شده');
    const otherTeam = rows.find((r) => r.id === '33333333-3333-4333-8333-333333333333');
    assert.equal(otherTeam.status, 'in_progress');
  });

  it('سناریوی واقعی ری‌بوت: تسک از چرخه‌ی تمام‌شده‌ی قدیمی هم یتیم است و بسته می‌شود؛ تسک چرخه‌ی فعال دیگر نه', async () => {
    await seedDb(fake.url, {
      cycles: [
        { id: 'cycle-1', run_id: 'run-1', status: 'running', started_at: new Date().toISOString() },
        { id: 'cycle-old', run_id: 'run-old', status: 'failed', started_at: new Date().toISOString() },
        { id: 'cycle-other', run_id: 'run-other', status: 'running', started_at: new Date().toISOString() },
      ],
      build_queue: [
        {
          id: '55555555-5555-4555-8555-555555555555',
          team: 'content',
          run_id: 'cycle-old', // مثل تسک b3fdc18c در حادثه‌ی واقعی
          title: 'تسک یتیم از چرخه‌ی قدیمی',
          status: 'in_progress',
          result: null,
        },
        {
          id: '66666666-6666-4666-8666-666666666666',
          team: 'content',
          run_id: 'cycle-other', // چرخه‌ی فعال دیگر: دست نزن
          title: 'تسک چرخه‌ی فعال دیگر',
          status: 'in_progress',
          result: null,
        },
      ],
    });
    const n = await tq().settleOrphanedClaimedTasks('content', 'cycle-1', 'دلیل تست');
    assert.equal(n, 1);
    const tables = await readTables(fake.url);
    const rows = tables['build_queue'] as any[];
    assert.equal(
      rows.find((r) => r.id === '55555555-5555-4555-8555-555555555555').status,
      'done',
    );
    assert.equal(
      rows.find((r) => r.id === '66666666-6666-4666-8666-666666666666').status,
      'in_progress',
    );
  });

  it('بدون تسک یتیم → صفر و بدون خطا', async () => {
    await seedDb(fake.url, { build_queue: [] });
    const n = await tq().settleOrphanedClaimedTasks('content', 'cycle-1', 'دلیل تست');
    assert.equal(n, 0);
  });
});

describe('sweepHungTeams: تیم ازکارافتاده + تسک یتیمش', () => {
  it('تیم hung → failed و تسکش interrupted بسته می‌شود', async () => {
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    await seedDb(fake.url, {
      team_runs: [
        {
          id: 'tr-content',
          cycle_id: 'cycle-1',
          team: 'content',
          wave: 2,
          status: 'running',
          started_at: iso(30 * 60_000),
          finished_at: null,
          heartbeat_at: iso(45_000), // ضربان زنده
          updated_at: iso(11 * 60_000), // ولی ۱۱ دقیقه بدون پیشرفت → hung
        },
      ],
      build_queue: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          team: 'content',
          run_id: 'cycle-1',
          title: 'تسک نیمه‌کاره',
          status: 'in_progress',
          result: null,
        },
      ],
    });
    const { getSupabase } = await import('../../lib/api');
    const results = await th().sweepHungTeams(getSupabase(), 'cycle-1', now);
    assert.equal(results.length, 1);
    assert.equal(results[0].team, 'content');
    const tables = await readTables(fake.url);
    const run = (tables['team_runs'] as any[]).find((r) => r.id === 'tr-content');
    assert.equal(run.status, 'failed');
    const task = (tables['build_queue'] as any[]).find(
      (r) => r.id === '44444444-4444-4444-8444-444444444444',
    );
    assert.equal(task.status, 'done');
    assert.match(task.result, /نقطهٔ پایانی شناخته‌شده/);
  });
});
