/**
 * تست حلقهٔ بازبینی منتقد (دستور مسعود): حداکثر ۳ دور، دستور دقیق، لاگ دورها.
 *
 * از یک تیم تستی موقت (lib/teams/__reviewlooptest.ts) استفاده می‌کند که رفتارش
 * از REVIEW_LOOP_SCRIPT خوانده می‌شود؛ پس مسیر واقعی runSingleTeam در
 * lib/orchestrator.ts بدون هیچ تغییری تست می‌شود.
 *
 * اجرا: npx tsx --test worker/__tests__/review-loop.test.mts
 * (پسوند mts. عمدی است تا از tsc سخت‌گیرانه‌ی ریپو خارج بماند)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startFakePostgrest, seedDb } from './fake-postgrest.mjs';

const LOG = '/tmp/review-loop-log.json';
const TEST_TEAM = '__reviewlooptest';

let fake: Awaited<ReturnType<typeof startFakePostgrest>>;
let runSingleTeam: (
  cycleId: string,
  team: any,
  wave: number,
  ctx: { runId: string; previousWavesOutput: Record<string, any> },
) => Promise<any>;

function resetLog() {
  try {
    fs.unlinkSync(LOG);
  } catch {
    /* نبودن فایل اشکال ندارد */
  }
}

function readLog(): any[] {
  return JSON.parse(fs.readFileSync(LOG, 'utf-8'));
}

async function tables() {
  const res = await fetch(`${fake.url}/__tables__`);
  return (await res.json()) as Record<string, any[]>;
}

before(async () => {
  fake = await startFakePostgrest();
  process.env.SUPABASE_URL = fake.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  const orch = (await import('../../lib/orchestrator')) as typeof import('../../lib/orchestrator');
  runSingleTeam = orch.runSingleTeam as any;
});

after(async () => {
  await fake.close();
});

async function seedCycle() {
  await seedDb(fake.url, {
    cycles: [{ id: 'cycle-1', run_id: 'run-test-loop', status: 'running', started_at: new Date().toISOString() }],
    team_runs: [],
    agent_state: [],
    subagents: [],
    team_memory: [],
    notifications: [],
    settings: [],
  });
}

describe('حلقهٔ بازبینی منتقد', () => {
  it('تأیید در دور ۱ → فقط یک دور، بدون بازاجرا', async () => {
    resetLog();
    process.env.REVIEW_LOOP_SCRIPT = JSON.stringify(['approve']);
    process.env.REVIEW_LOOP_LOG = LOG;
    await seedCycle();
    const result = await runSingleTeam('cycle-1', TEST_TEAM, 1, { runId: 'run-test-loop', previousWavesOutput: {} });
    assert.equal(result.approved, true);
    const log = readLog();
    assert.equal(log.length, 1, `باید فقط ۱ دور اجرا شود، شد ${log.length}`);
    assert.equal(log[0].round, 1);
    const t = await tables();
    const row = t.team_runs.find((r: any) => r.team === TEST_TEAM);
    assert.ok(row, 'ردیف team_runs باید ساخته شده باشد');
    assert.equal(row.status, 'success');
    assert.ok(Array.isArray(row.review_rounds), 'review_rounds باید آرایه باشد');
    assert.equal(row.review_rounds.length, 1);
    assert.equal(row.review_rounds[0].approved, true);
  });

  it('رد در دور ۱ و تأیید در دور ۲ → دستور منتقد به دور ۲ می‌رسد', async () => {
    resetLog();
    process.env.REVIEW_LOOP_SCRIPT = JSON.stringify(['reject', 'approve']);
    process.env.REVIEW_LOOP_LOG = LOG;
    await seedCycle();
    const result = await runSingleTeam('cycle-1', TEST_TEAM, 1, { runId: 'run-test-loop', previousWavesOutput: {} });
    assert.equal(result.approved, true, 'نتیجهٔ نهایی باید تأیید دور ۲ باشد');
    const log = readLog();
    assert.equal(log.length, 2, `باید ۲ دور اجرا شود، شد ${log.length}`);
    assert.equal(log[0].round, 1);
    assert.equal(log[0].hasDirective, false, 'دور ۱ نباید دستور داشته باشد');
    assert.equal(log[1].round, 2);
    assert.equal(log[1].hasDirective, true, 'دور ۲ باید دستور منتقد را بگیرد');
    assert.match(log[1].directivePreview, /دلیل رد دور ۱/, 'دستور باید دلیل رد را داشته باشد');
    assert.equal(log[1].ragHasDirective, true, 'دستور باید در ragContext هم باشد');
    const t = await tables();
    const row = t.team_runs.find((r: any) => r.team === TEST_TEAM);
    assert.equal(row.status, 'success');
    assert.equal(row.review_rounds.length, 2);
    assert.equal(row.review_rounds[0].approved, false);
    assert.match(row.review_rounds[0].reason, /دلیل رد دور ۱/);
    assert.equal(row.review_rounds[1].approved, true);
  });

  it('رد در هر ۳ دور → دقیقاً ۳ دور، وضعیت rejected، بدون دور چهارم', async () => {
    resetLog();
    process.env.REVIEW_LOOP_SCRIPT = JSON.stringify(['reject', 'reject', 'reject']);
    process.env.REVIEW_LOOP_LOG = LOG;
    await seedCycle();
    const result = await runSingleTeam('cycle-1', TEST_TEAM, 1, { runId: 'run-test-loop', previousWavesOutput: {} });
    assert.equal(result.approved, false);
    const log = readLog();
    assert.equal(log.length, 3, `باید دقیقاً ۳ دور اجرا شود (نه بیشتر)، شد ${log.length}`);
    assert.deepEqual(log.map((l: any) => l.round), [1, 2, 3]);
    // دور ۳: پیام «دور پایانی» باید در زمینه باشد
    const t = await tables();
    const row = t.team_runs.find((r: any) => r.team === TEST_TEAM);
    assert.equal(row.status, 'rejected', 'بعد از ۳ رد، وضعیت باید rejected باشد');
    assert.equal(row.review_rounds.length, 3);
    assert.ok(row.review_rounds.every((r: any) => r.approved === false));
    assert.match(row.current_task, /۳ دور/);
  });
});
