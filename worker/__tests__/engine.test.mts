/**
 * تست‌های یکپارچگی موتور اجرا (ورکر چرخه + ارکستراتور).
 *
 * کد واقعی (worker/cycle-worker.ts و lib/orchestrator.ts) بدون هیچ تغییری
 * در برابر یک PostgREST جعلی درون‌حافظه‌ای اجرا می‌شود؛ بنابراین مسیر واقعی
 * کلاینت supabase-js هم تست می‌شود، نه فقط منطق.
 *
 * اجرا: npx tsx --test worker/__tests__/engine.test.mts
 * (پسوند mts. عمدی است تا از tsc سخت‌گیرانه‌ی ریپو خارج بماند)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakePostgrest, seedDb, readTables } from './fake-postgrest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const tsxBin = path.resolve(repoRoot, 'node_modules', '.bin', 'tsx');

const ALL_TEAMS = [
  'artdir', 'branding', 'content',
  'analytics', 'intel', 'lead',
  'design', 'seo', 'seocontent',
  'design-ir', 'dev', 'farsiui',
  'vibefarsi', 'qa',
  'inspector',
];

const nowIso = () => new Date().toISOString();
const minAgoIso = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

let fake: Awaited<ReturnType<typeof startFakePostgrest>>;
let orch: typeof import('../../lib/orchestrator');

function activeCycleSeed(runId = 'run-test-1') {
  return {
    id: 'cycle-1',
    run_id: runId,
    status: 'running',
    started_at: minAgoIso(30),
  };
}

function teamRun(team: string, status: string, startedMinAgo = 5) {
  return {
    id: `tr-${team}`,
    cycle_id: 'cycle-1',
    team,
    wave: 1,
    status,
    started_at: minAgoIso(startedMinAgo),
    finished_at: status === 'running' ? null : nowIso(),
  };
}

async function seed(seed: Record<string, unknown[]>) {
  await seedDb(fake.url, seed);
}

async function tables() {
  return readTables(fake.url);
}

interface WorkerResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  tables: Record<string, any[]>;
}

function runWorker(args: string[] = [], timeoutMs = 150_000): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const child = execFile(
      tsxBin,
      ['worker/cycle-worker.ts', ...args],
      {
        cwd: repoRoot,
        timeout: timeoutMs,
        env: {
          ...process.env,
          SUPABASE_URL: fake.url,
          SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
        },
      },
      (error: any, stdout: any, stderr: any) => {
        resolve({
          code: error ? (error.code ?? null) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut: Boolean(error && error.killed),
        } as WorkerResult);
      },
    );
    // خروجی را زنده نگه دار تا در صورت گیر کردن، لاگ گم نشود
    void child;
  }).then(async (r) => ({ ...r, tables: await tables() }));
}

function runningTeamLines(stdout: string): string[] {
  return stdout.split('\n').filter((l) => /running team \S+ \(wave \d+\)/.test(l));
}

before(async () => {
  fake = await startFakePostgrest();
  process.env.SUPABASE_URL = fake.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  orch = await import('../../lib/orchestrator');
});

after(async () => {
  await fake.close();
});

describe('تست ۱: بدون چرخه‌ی فعال، ورکر چرخه‌ی جدید نمی‌سازد', () => {
  it('بدون آرگومان و بدون چرخه‌ی فعال → خروج تمیز و هیچ چرخه‌ای ساخته نمی‌شود', async () => {
    await seed({ cycles: [], team_runs: [], agent_state: [] });
    const r = await runWorker([]);
    assert.equal(r.timedOut, false, `worker timed out. stderr: ${r.stderr.slice(0, 500)}`);
    assert.match(r.stdout, /no active cycle/);
    assert.equal(r.tables.cycles.length, 0, 'نباید چرخه‌ی جدید ساخته شود');
  });

  it('با آرگومان start-cycle و بدون چرخه‌ی فعال → دقیقاً یک چرخه ساخته می‌شود', async () => {
    await seed({ cycles: [], team_runs: [], agent_state: [] });
    const r = await runWorker(['start-cycle']);
    assert.equal(r.timedOut, false);
    assert.match(r.stdout, /new cycle started/);
    assert.equal(r.tables.cycles.length, 1);
    assert.equal(r.tables.cycles[0].status, 'running');
    const lock = r.tables.agent_state.find((x: any) => x.agent === 'orchestrator:lock');
    assert.ok(lock, 'قفل باید گرفته شده باشد');
    assert.equal(lock.state.status, 'running');
  });

  it('با آرگومان start-cycle ولی چرخه‌ی فعال موجود → چرخه‌ی جدید ساخته نمی‌شود', async () => {
    await seed({ cycles: [activeCycleSeed()], team_runs: [], agent_state: [] });
    const r = await runWorker(['start-cycle']);
    assert.match(r.stdout, /active cycle exists/);
    assert.equal(r.tables.cycles.length, 1, 'نباید چرخه‌ی دوم ساخته شود');
  });
});

describe('تست ۲: ورکر در هر اجرا دقیقاً یک تیم انتخاب می‌کند', () => {
  it('موج اول خالی → فقط artdir انتخاب و اجرا می‌شود', async () => {
    await seed({ cycles: [activeCycleSeed()], team_runs: [], agent_state: [] });
    const r = await runWorker([]);
    const lines = runningTeamLines(r.stdout);
    assert.equal(lines.length, 1, `باید دقیقاً یک تیم انتخاب شود، شد: ${JSON.stringify(lines)}`);
    assert.match(lines[0], /running team artdir \(wave 1\)/);
    const rows = r.tables.team_runs.filter((x: any) => x.cycle_id === 'cycle-1');
    assert.equal(rows.length, 1, 'باید دقیقاً یک ردیف team_runs ساخته شود');
    assert.equal(rows[0].team, 'artdir');
  });

  it('موج اول تمام‌شده و analytics موفق → فقط intel انتخاب می‌شود', async () => {
    await seed({
      cycles: [activeCycleSeed()],
      team_runs: [
        teamRun('artdir', 'success'),
        teamRun('branding', 'success'),
        teamRun('content', 'success'),
        teamRun('analytics', 'success'),
      ],
      agent_state: [],
    });
    const r = await runWorker([]);
    const lines = runningTeamLines(r.stdout);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /running team intel \(wave 2\)/);
    const rows = r.tables.team_runs.filter((x: any) => x.cycle_id === 'cycle-1');
    // ۴ ردیف قبلی + دقیقاً یک ردیف جدید
    assert.equal(rows.length, 5);
    const fresh = rows.filter((x: any) => x.team === 'intel');
    assert.equal(fresh.length, 1);
  });
});

describe('تست ۳: پایان همه‌ی تیم‌ها → چرخه بسته و قفل آزاد می‌شود', () => {
  it('همه موفق → وضعیت success و قفل دیگر running نیست', async () => {
    await seed({
      cycles: [activeCycleSeed()],
      team_runs: ALL_TEAMS.map((t) => teamRun(t, 'success')),
      agent_state: [
        {
          agent: 'orchestrator:lock',
          state: { status: 'running', run_id: 'run-test-1', cycle_id: 'cycle-1' },
          updated_at: minAgoIso(30),
        },
      ],
    });
    const r = await runWorker([]);
    assert.equal(runningTeamLines(r.stdout).length, 0, 'نباید تیمی اجرا شود');
    assert.match(r.stdout, /cycle finished: success/);
    const cycle = r.tables.cycles.find((x: any) => x.id === 'cycle-1');
    assert.equal(cycle.status, 'success');
    assert.ok(cycle.finished_at, 'finished_at باید ثبت شود');
    const lock = r.tables.agent_state.find((x: any) => x.agent === 'orchestrator:lock');
    assert.notEqual(lock.state.status, 'running', 'قفل باید آزاد شده باشد');
  });

  it('یکی ناموفق → وضعیت failed ولی قفل باز هم آزاد می‌شود', async () => {
    await seed({
      cycles: [activeCycleSeed()],
      team_runs: ALL_TEAMS.map((t, i) => teamRun(t, i === 0 ? 'failed' : 'success')),
      agent_state: [
        {
          agent: 'orchestrator:lock',
          state: { status: 'running', run_id: 'run-test-1', cycle_id: 'cycle-1' },
          updated_at: minAgoIso(30),
        },
      ],
    });
    const r = await runWorker([]);
    assert.match(r.stdout, /cycle finished: failed/);
    const cycle = r.tables.cycles.find((x: any) => x.id === 'cycle-1');
    assert.equal(cycle.status, 'failed');
    const lock = r.tables.agent_state.find((x: any) => x.agent === 'orchestrator:lock');
    assert.notEqual(lock.state.status, 'running');
  });
});

describe('تست ۴: دو ورکر هم‌زمان نمی‌توانند یک تیم را اجرا کنند', () => {
  it('تیمی در حال اجراست → ورکر دوم صبر می‌کند و تیم تازه‌ای شروع نمی‌کند', async () => {
    await seed({
      cycles: [activeCycleSeed()],
      team_runs: [teamRun('artdir', 'running', 1)],
      agent_state: [],
    });
    const r = await runWorker([]);
    assert.equal(r.timedOut, false);
    assert.match(r.stdout, /has a running team; waiting/);
    assert.equal(runningTeamLines(r.stdout).length, 0);
    assert.equal(r.tables.team_runs.length, 1, 'نباید ردیف تازه‌ای ساخته شود');
  });

  it('سطح ارکستراتور: beginCycle دوم در حالی که قفل تازه است → CycleLockedError', async () => {
    await seed({ cycles: [], team_runs: [], agent_state: [] });
    const first = await orch.beginCycle();
    assert.ok(first.runId);
    await assert.rejects(() => orch.beginCycle(), orch.CycleLockedError);
    // فقط یک چرخه ساخته شده باشد
    const t = await tables();
    assert.equal(t.cycles.length, 1);
  });
});

describe('تست ۵: ورکر مرده → قفل stale آزاد می‌شود', () => {
  it('سطح ارکستراتور: قفل running با قدمت بیش از ۱۵۰ دقیقه → beginCycle موفق می‌شود', async () => {
    await seed({
      cycles: [],
      team_runs: [],
      agent_state: [
        {
          agent: 'orchestrator:lock',
          state: { status: 'running', run_id: 'run-dead', started_at: minAgoIso(200) },
          updated_at: minAgoIso(200),
        },
      ],
    });
    const { runId } = await orch.beginCycle();
    assert.ok(runId);
    assert.notEqual(runId, 'run-dead', 'باید run_id تازه ساخته شود');
    const t = await tables();
    const lock = t.agent_state.find((x: any) => x.agent === 'orchestrator:lock');
    assert.equal(lock.state.status, 'running');
    assert.equal(lock.state.run_id, runId);
  });

  it('سطح ورکر: تیم گیرکرده‌ی بیش از ۱۵ دقیقه → failed می‌شود و چرخه بسته می‌شود', async () => {
    const doneTeams = ALL_TEAMS.filter((t) => t !== 'inspector');
    await seed({
      cycles: [activeCycleSeed()],
      team_runs: [
        ...doneTeams.map((t) => teamRun(t, 'success')),
        teamRun('inspector', 'running', 20),
      ],
      agent_state: [
        {
          agent: 'orchestrator:lock',
          state: { status: 'running', run_id: 'run-test-1', cycle_id: 'cycle-1' },
          updated_at: minAgoIso(30),
        },
      ],
    });
    const r = await runWorker([]);
    assert.match(r.stdout, /timing out stuck team.*: inspector/);
    const insp = r.tables.team_runs.find((x: any) => x.team === 'inspector');
    assert.equal(insp.status, 'failed', 'تیم گیرکرده باید failed شود');
    // حالا همه تمام شده‌اند → چرخه بسته می‌شود
    assert.match(r.stdout, /cycle finished: failed/);
    const cycle = r.tables.cycles.find((x: any) => x.id === 'cycle-1');
    assert.equal(cycle.status, 'failed');
    const lock = r.tables.agent_state.find((x: any) => x.agent === 'orchestrator:lock');
    assert.notEqual(lock.state.status, 'running');
  });
});
