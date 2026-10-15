/**
 * تست یکپارچگی lib/lock.ts — با دیتابیس واقعی (از طریق تونل pg).
 *
 * اجرا: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx --test lib/lock.test.mts
 * اگر env ست نباشد، تست‌ها skip می‌شوند (نه fail).
 *
 * احتیاط: تست روی ردیف واقعی agent_state با کلید 'orchestrator:lock' کار می‌کند،
 * ولی فقط با owner ساختگی 'lock-test' و در پایان قفل را به حالت اول برمی‌گرداند.
 * برای claimTeam یک چرخه‌ی تستی می‌سازد و در finally پاکش می‌کند (cascade).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const hasEnv = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

let lock: typeof import('./lock.js');
let sb: { from: (t: string) => any };

const OWNER_A = { engine: 'lock-test', runId: 'owner-a' };
const OWNER_B = { engine: 'lock-test', runId: 'owner-b' };

before(async () => {
  if (!hasEnv) return;
  lock = await import('./lock.js');
  const { getSupabase } = await import('./api.js');
  sb = getSupabase();
});

async function readRawLock() {
  const { data } = await sb.from('agent_state').select('state, updated_at').eq('agent', 'orchestrator:lock').maybeSingle();
  return data as { state: any; updated_at: string } | null;
}

test('acquire → touch → release lifecycle', { skip: !hasEnv }, async () => {
  const beforeLock = await readRawLock();

  await lock.acquireLock(OWNER_A, 'cycle-test-1');
  let cur = await readRawLock();
  assert.equal(cur?.state?.status, 'running');
  assert.equal(cur?.state?.owner?.runId, 'owner-a');

  const hb1 = cur?.state?.heartbeatAt;
  await new Promise((r) => setTimeout(r, 1100));
  await lock.touchLock(OWNER_A);
  cur = await readRawLock();
  assert.ok(cur?.state?.heartbeatAt && cur.state.heartbeatAt !== hb1, 'heartbeat باید heartbeatAt را تازه کند');

  // دارنده‌ی دیگر نمی‌تواند heartbeat بزند
  await assert.rejects(() => lock.touchLock(OWNER_B), lock.LockAcquisitionError);

  await lock.releaseLock(OWNER_A);
  cur = await readRawLock();
  assert.equal(cur?.state?.status, 'idle');

  // بازگرداندن وضعیت اول (اگر قبلاً قفلی بود)
  if (beforeLock) {
    await sb.from('agent_state').upsert({ agent: 'orchestrator:lock', state: beforeLock.state, updated_at: beforeLock.updated_at }, { onConflict: 'agent' });
  }
});

test('acquire روی قفل تازه‌ی دیگری خطا می‌دهد', { skip: !hasEnv }, async () => {
  const beforeLock = await readRawLock();
  try {
    await lock.acquireLock(OWNER_A, 'cycle-test-2');
    await assert.rejects(() => lock.acquireLock(OWNER_B, 'cycle-test-2'), lock.LockAcquisitionError);
  } finally {
    await lock.releaseLock(OWNER_A);
    if (beforeLock) {
      await sb.from('agent_state').upsert({ agent: 'orchestrator:lock', state: beforeLock.state, updated_at: beforeLock.updated_at }, { onConflict: 'agent' });
    }
  }
});

test('قفل stale تصاحب می‌شود', { skip: !hasEnv }, async () => {
  const beforeLock = await readRawLock();
  try {
    await lock.acquireLock(OWNER_A, 'cycle-test-3');
    // شبیه‌سازی مرگ ورکر: heartbeat را ۱۱ دقیقه به عقب ببر
    const staleAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const cur = await readRawLock();
    await sb.from('agent_state')
      .update({ state: { ...cur!.state, heartbeatAt: staleAt }, updated_at: staleAt })
      .eq('agent', 'orchestrator:lock');

    assert.equal(await lock.isLockStale(), true, 'قفل ۱۱ دقیقه‌ای باید stale باشد');

    // ورکر B باید بتواند تصاحبش کند
    await lock.acquireLock(OWNER_B, 'cycle-test-3');
    const after = await readRawLock();
    assert.equal(after?.state?.owner?.runId, 'owner-b');
    await lock.releaseLock(OWNER_B);
  } finally {
    if (beforeLock) {
      await sb.from('agent_state').upsert({ agent: 'orchestrator:lock', state: beforeLock.state, updated_at: beforeLock.updated_at }, { onConflict: 'agent' });
    } else {
      await sb.from('agent_state').delete().eq('agent', 'orchestrator:lock');
    }
  }
});

test('قفل تازه stale نیست', { skip: !hasEnv }, async () => {
  const beforeLock = await readRawLock();
  try {
    await lock.acquireLock(OWNER_A, 'cycle-test-4');
    assert.equal(await lock.isLockStale(), false);
  } finally {
    await lock.releaseLock(OWNER_A);
    if (beforeLock) {
      await sb.from('agent_state').upsert({ agent: 'orchestrator:lock', state: beforeLock.state, updated_at: beforeLock.updated_at }, { onConflict: 'agent' });
    }
  }
});

test('claimTeam اتمیک است: دومی null می‌گیرد', { skip: !hasEnv }, async () => {
  // ساخت چرخه‌ی تستی
  const runId = `lock-test-${Date.now()}`;
  const { data: cycle, error: cErr } = await sb.from('cycles').insert({ run_id: runId, status: 'running' }).select('id').single();
  assert.ok(!cErr, `ساخت چرخه‌ی تستی: ${cErr?.message}`);
  const cycleId = cycle.id as string;
  try {
    const first = await lock.claimTeam(cycleId, 'artdir', 1, OWNER_A);
    assert.ok(first, 'اولین claim باید موفق شود');

    const second = await lock.claimTeam(cycleId, 'artdir', 1, OWNER_B);
    assert.equal(second, null, 'دومین claim هم‌زمان باید null بگیرد');

    // تیم دیگر همچنان قابل claim است
    const other = await lock.claimTeam(cycleId, 'branding', 1, OWNER_B);
    assert.ok(other, 'تیم متفاوت باید claim شود');
  } finally {
    await sb.from('cycles').delete().eq('id', cycleId); // cascade پاک می‌کند team_runs را
  }
});

test('releaseTeamClaim ردیف running را failed می‌کند', { skip: !hasEnv }, async () => {
  const runId = `lock-test-${Date.now()}`;
  const { data: cycle } = await sb.from('cycles').insert({ run_id: runId, status: 'running' }).select('id').single();
  const cycleId = cycle.id as string;
  try {
    const teamRunId = await lock.claimTeam(cycleId, 'qa', 1, OWNER_A);
    assert.ok(teamRunId);
    await lock.releaseTeamClaim(teamRunId!, 'ورکر مرد');
    const { data: row } = await sb.from('team_runs').select('status').eq('id', teamRunId!).single();
    assert.equal((row as any).status, 'failed');
    // حالا ورکر دیگری می‌تواند دوباره claim کند
    const again = await lock.claimTeam(cycleId, 'qa', 1, OWNER_B);
    assert.ok(again, 'پس از release باید دوباره claim شود');
  } finally {
    await sb.from('cycles').delete().eq('id', cycleId);
  }
});

after(async () => {
  // اطمینان نهایی: هیچ قفل تستی جا نماند
  if (!hasEnv) return;
  const cur = await readRawLock();
  if (cur?.state?.owner?.engine === 'lock-test') {
    await sb.from('agent_state').delete().eq('agent', 'orchestrator:lock');
  }
});
