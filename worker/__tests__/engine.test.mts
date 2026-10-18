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

function finishedCycleSeed(id = 'cycle-0', status = 'success') {
  return {
    id,
    run_id: `run-old-${id}`,
    status,
    started_at: minAgoIso(120),
    finished_at: minAgoIso(60),
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

describe('تست ۱: بدون چرخه‌ی فعال → شروع خودکار چرخه‌ی بعدی', () => {
  it('بدون هیچ چرخه‌ای → خروج تمیز و هیچ چرخه‌ای ساخته نمی‌شود (شروع اول دستی است)', async () => {
    await seed({ cycles: [], team_runs: [], agent_state: [] });
    const r = await runWorker([]);
    assert.equal(r.timedOut, false, `worker timed out. stderr: ${r.stderr.slice(0, 500)}`);
    assert.match(r.stdout, /no previous cycle/);
    assert.match(r.stdout, /no active cycle/);
    assert.equal(r.tables.cycles.length, 0, 'نباید چرخه‌ی جدید ساخته شود');
  });

  it('آخرین چرخه success بود → خودکار چرخه‌ی جدید ساخته و همان تیک جلو می‌رود', async () => {
    await seed({
      cycles: [finishedCycleSeed('cycle-0', 'success')],
      team_runs: [],
      agent_state: [],
    });
    const r = await runWorker([]);
    assert.equal(r.timedOut, false, `worker timed out. stderr: ${r.stderr.slice(0, 500)}`);
    assert.match(r.stdout, /auto-started next cycle/);
    assert.equal(r.tables.cycles.length, 2, 'باید دقیقاً یک چرخه‌ی تازه ساخته شود');
    const fresh = r.tables.cycles.find((x: any) => x.id !== 'cycle-0');
    assert.equal(fresh.status, 'running', 'چرخه‌ی تازه باید running باشد');
    // همان تیک با چرخه‌ی تازه ادامه می‌دهد: اولین تیم موج ۱ اجرا می‌شود
    const lines = runningTeamLines(r.stdout);
    assert.equal(lines.length, 1, `باید دقیقاً یک تیم انتخاب شود، شد: ${JSON.stringify(lines)}`);
    assert.match(lines[0], /running team artdir \(wave 1\)/);
    const rows = r.tables.team_runs.filter((x: any) => x.cycle_id === fresh.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].team, 'artdir');
  });

  it('آخرین چرخه failed بود → چرخه‌ی جدید ساخته نمی‌شود (نیاز به توجه دارد)', async () => {
    await seed({
      cycles: [finishedCycleSeed('cycle-0', 'failed')],
      team_runs: [],
      agent_state: [],
    });
    const r = await runWorker([]);
    assert.equal(r.timedOut, false);
    assert.match(r.stdout, /not auto-starting/);
    assert.equal(r.tables.cycles.length, 1, 'نباید چرخه‌ی تازه ساخته شود');
    assert.equal(runningTeamLines(r.stdout).length, 0);
  });

  it('تنظیم auto_start_next_cycle=false → حتی با success قبلی، چرخه‌ی جدید ساخته نمی‌شود', async () => {
    await seed({
      cycles: [finishedCycleSeed('cycle-0', 'success')],
      team_runs: [],
      agent_state: [],
      settings: [{ key: 'auto_start_next_cycle', value: false }],
    });
    const r = await runWorker([]);
    assert.equal(r.timedOut, false);
    assert.match(r.stdout, /auto-start disabled/);
    assert.equal(r.tables.cycles.length, 1, 'نباید چرخه‌ی تازه ساخته شود');
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
  it('سطح ارکستراتور: قفل running قدیمی (شکل snake_case) با قدمت بیش از TTL → beginCycle موفق می‌شود (stale-takeover)', async () => {
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
    const { runId, cycleId } = await orch.beginCycle();
    assert.ok(runId);
    assert.notEqual(runId, 'run-dead', 'باید run_id تازه ساخته شود');
    const t = await tables();
    assert.equal(t.cycles.length, 1, 'فقط یک چرخه ساخته شده باشد');
    assert.equal(t.cycles[0].id, cycleId);
    const lock = t.agent_state.find((x: any) => x.agent === 'orchestrator:lock');
    assert.equal(lock.state.status, 'running');
    // قفل جدید: هویت دارنده + cycleId روی ردیف ثبت می‌شود (نه run_id/cycle_id قدیمی)
    assert.equal(lock.state.owner?.runId, runId);
    assert.equal(lock.state.cycleId, cycleId);
  });

  it('سطح ورکر: تیمِ بی‌ضربانِ بیش از ۱۵ دقیقه («مرده») → failed می‌شود و چرخه بسته می‌شود', async () => {
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
    assert.match(r.stdout, /تیم inspector «مرده» شناخته/, 'مدل دوسیگناله: ۲۰ دقیقه بی‌ضربان = مرده');
    const insp = r.tables.team_runs.find((x: any) => x.team === 'inspector');
    assert.equal(insp.status, 'failed', 'تیم گیرکرده باید failed شود');
    // حالا همه تمام شده‌اند → چرخه بسته می‌شود
    assert.match(r.stdout, /cycle finished: failed/);
    const cycle = r.tables.cycles.find((x: any) => x.id === 'cycle-1');
    assert.equal(cycle.status, 'failed');
    const lock = r.tables.agent_state.find((x: any) => x.agent === 'orchestrator:lock');
    assert.notEqual(lock.state.status, 'running');
  });

  it('سطح ورکر: تیمِ ضربان‌زنِ بی‌پیشرفتِ بیش از ۱۰ دقیقه («هنگ») → failed می‌شود', async () => {
    // بازتولید ریشه‌ی باگ: ضربان تازه ولی آخرین پیشرفت واقعی ۱۱ دقیقه پیش.
    // در منطق قدیمی updated_at با ضربان تازه می‌ماند و تیم «سالم» دیده می‌شد.
    const doneTeams = ALL_TEAMS.filter((t) => t !== 'inspector');
    await seed({
      cycles: [activeCycleSeed()],
      team_runs: [
        ...doneTeams.map((t) => teamRun(t, 'success')),
        {
          ...teamRun('inspector', 'running', 30),
          heartbeat_at: nowIso(), // ضربان زنده
          updated_at: minAgoIso(11), // ولی ۱۱ دقیقه بدون هیچ پیشرفتی
          current_task: 'تست هنگ',
        },
      ],
      agent_state: [],
    });
    const r = await runWorker([]);
    assert.match(r.stdout, /تیم inspector «هنگ» شناخته/, 'ضربانِ زنده نباید هنگ را بپوشاند');
    const insp = r.tables.team_runs.find((x: any) => x.team === 'inspector');
    assert.equal(insp.status, 'failed', 'تیم هنگ باید failed شود تا موج جلو برود');
    assert.match(insp.error ?? '', /هنگ شناسایی شد/, 'خطا باید «هنگ» را نام ببرد');
  });
});

describe('تست ۶: ترتیب موج‌ها و عدم اجرای تکراری (باگ‌هانتی ۱۴۰۵/۰۷/۲۳)', () => {
  it('موج اول نیمه‌تمام → تیم بعدی همان موج اول انتخاب می‌شود، نه موج دوم', async () => {
    await seed({
      cycles: [activeCycleSeed()],
      team_runs: [teamRun('artdir', 'success'), teamRun('branding', 'rejected')],
      agent_state: [],
    });
    const r = await runWorker([]);
    const lines = runningTeamLines(r.stdout);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /running team content \(wave 1\)/, 'نباید به موج ۲ بپرد');
  });

  it('حلقه اصلاح درون‌چرخه‌ای: تیم ردشده با تلاش کمتر از سقف، در همین چرخه دوباره انتخاب می‌شود', async () => {
    // چرخه تازه (started_at نزدیک) تا recoverDeadCycles آن را «مرده» نداند
    const freshCycle = { ...activeCycleSeed(), started_at: minAgoIso(5) };
    await seed({
      cycles: [freshCycle],
      team_runs: [
        teamRun('leader', 'success'),
        {
          id: 'tr-tour-manager-1',
          cycle_id: 'cycle-1',
          team: 'tour-manager',
          wave: 1,
          status: 'rejected',
          started_at: minAgoIso(5),
          updated_at: minAgoIso(4),
          finished_at: nowIso(),
          review_rounds: [
            { round: 2, approved: false, reason: 'دلیل تست رد', directive: 'دستور تست اصلاح' },
          ],
        },
      ],
      agent_state: [],
    });
    const r = await runWorker([]);
    // tour-manager باید دوباره اجرا شود (ردیف دوم) و لاگ fix-loop دیده شود؛
    // دستور مسعود ۱۴۰۵/۰۷/۲۶: ردشدن به چرخهٔ بعد موکول نمی‌شود.
    const tmRows = r.tables.team_runs.filter((x: any) => x.team === 'tour-manager');
    assert.equal(tmRows.length, 2, 'تیم ردشده باید در همین چرخه دوباره اجرا شود');
    assert.match(r.stdout, /\[fix-loop\] team tour-manager: same-cycle fix attempt 2\/3/);
  });

  it('حلقه اصلاح درون‌چرخه‌ای: تیم ردشده پس از سقف تلاش، مسدود می‌شود و موج جلو می‌رود', async () => {
    const freshCycle = { ...activeCycleSeed(), started_at: minAgoIso(5) };
    const rejectedRow = (i: number) => ({
      id: `tr-tour-manager-${i}`,
      cycle_id: 'cycle-1',
      team: 'tour-manager',
      wave: 1,
      status: 'rejected',
      started_at: minAgoIso(25 - i * 5),
      updated_at: minAgoIso(20 - i * 5),
      finished_at: nowIso(),
    });
    await seed({
      cycles: [freshCycle],
      team_runs: [teamRun('leader', 'success'), rejectedRow(1), rejectedRow(2), rejectedRow(3)],
      agent_state: [],
    });
    const r = await runWorker([]);
    // tour-manager نباید ردیف تازه‌ای بگیرد (۳ تلاش تمام شده)؛ موج ۲ انتخاب می‌شود
    const tmRows = r.tables.team_runs.filter((x: any) => x.team === 'tour-manager');
    assert.equal(tmRows.length, 3, 'تیم مسدودشده نباید دوباره اجرا شود');
    assert.match(r.stdout, /running team content \(wave 2\)/);
  });

  it('تیم running با ضربان تازه → تایم‌اوت نمی‌شود و ورکر دوم صبر می‌کند', async () => {
    await seed({
      cycles: [activeCycleSeed()],
      team_runs: [
        {
          id: 'tr-artdir',
          cycle_id: 'cycle-1',
          team: 'artdir',
          wave: 1,
          status: 'running',
          started_at: minAgoIso(20),
          updated_at: minAgoIso(1), // ضربان تازه
          finished_at: null,
        },
      ],
      agent_state: [],
    });
    const r = await runWorker([]);
    assert.doesNotMatch(r.stdout, /شناخته و ناموفق ثبت شد/, 'تیم سالم نباید تایم‌اوت شود');
    assert.match(r.stdout, /has a running team; waiting/);
    const row = r.tables.team_runs.find((x: any) => x.team === 'artdir');
    assert.equal(row.status, 'running');
  });

  it('ورکر خطای heartbeat قفل چرخه تولید نمی‌کند (رگرسیون باگ ۱۴۰۵/۰۷/۲۳)', async () => {
    await seed({
      cycles: [activeCycleSeed()],
      team_runs: [],
      agent_state: [
        {
          agent: 'orchestrator:lock',
          state: { status: 'running', run_id: 'run-test-1', cycle_id: 'cycle-1' },
          updated_at: minAgoIso(30),
        },
      ],
    });
    const r = await runWorker([]);
    assert.doesNotMatch(
      r.stdout + r.stderr,
      /heartbeat failed/,
      'نباید خطای heartbeat قفل دیده شود؛ heartbeat خراب حذف شده است',
    );
  });
});

describe('تست ۷: توقف نرم — ورکر بعد از «توقف» کاربر هیچ تیمی را claim نمی‌کند', () => {
  it('چرخه‌ی paused → بدون claim و بدون ردیف تازه', async () => {
    await seed({
      cycles: [{ ...activeCycleSeed(), status: 'paused' }],
      team_runs: [],
      agent_state: [],
    });
    const r = await runWorker([]);
    assert.equal(r.timedOut, false);
    assert.match(r.stdout, /is paused; skipping team claim/);
    assert.equal(runningTeamLines(r.stdout).length, 0);
    assert.equal(r.tables.team_runs.length, 0, 'نباید هیچ تیمی claim شود');
  });

  it('چرخه‌ی pausing → بدون claim و بدون ردیف تازه', async () => {
    await seed({
      cycles: [{ ...activeCycleSeed(), status: 'pausing' }],
      team_runs: [],
      agent_state: [],
    });
    const r = await runWorker([]);
    assert.equal(r.timedOut, false);
    assert.match(r.stdout, /is pausing; skipping team claim/);
    assert.equal(runningTeamLines(r.stdout).length, 0);
    assert.equal(r.tables.team_runs.length, 0, 'نباید هیچ تیمی claim شود');
  });
});
