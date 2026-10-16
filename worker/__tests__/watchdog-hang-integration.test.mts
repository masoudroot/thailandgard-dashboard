/**
 * تست یکپارچه‌ی واقعی تشخیص هنگ (مسئله‌ی ۴: «نگهبان تیم هنگ را نمی‌بیند»).
 *
 * برخلاف تست واحد (classifyTeamRun خالص)، اینجا مسیر واقعی اجرا می‌شود:
 * ردیف‌های واقعی در دیتابیس واقعی، تابع‌های واقعی lib/team-health و
 * worker/cycle-watchdog، و تریگر واقعی دیتابیس.
 *
 * سناریوها:
 *  ۱. تریگر: ضربانِ خالصِ heartbeat_at نباید updated_at را جلو ببرد
 *     (این دقیقاً ریشه‌ی باگ بود)؛ ولی گزارش پیشرفت واقعی باید ببرد.
 *  ۲. تیم مصنوعیِ هنگ‌کرده (ضربان زنده + ۱۱ دقیقه بی‌پیشرفت) باید hung
 *     شناخته شود؛ تیم سالم نه؛ تیم بی‌ضربان dead.
 *  ۳. checkHungTimes واقعی واچ‌داگ باید برای hung/dead هشدار بدهد
 *     (ارسال تلگرام استاب شده؛ ثبت پنل واقعی است تا ضداسپم هم واقعی تست شود)
 *     و برای تیم سالم هیچ هشداری ندهد.
 *  ۴. اجرای دوم واچ‌داگ نباید هشدار تکراری بدهد (پنجره‌ی ۶۰ دقیقه‌ای).
 *  ۵. sweepHungTeams واقعی (مسیر ورکر) باید hung/dead را «ناموفق» ثبت کند
 *     تا موج جلو برود (ری‌استارت)، و تیم سالم را دست نزند.
 *
 * نیازمند: تونل pg روی 127.0.0.1:15432 (در غیر این صورت تست skip می‌شود).
 * اجرا: npx tsx --test worker/__tests__/watchdog-hang-integration.test.mts
 *
 * درباره‌ی «≤۱۰ دقیقه»: ردیف هنگ با updated_atِ ۱۱ دقیقه پیش ساخته می‌شود
 * (شبیه‌سازی عبور از آستانه)؛ واچ‌داگ در اولین اجرایش پس از آستانه آن را
 * می‌گیرد. باند واقعی = آستانه‌ی ۱۰ دقیقه + اجرای هر ۱۰ دقیقه‌ی واچ‌داگ.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { findUnhealthyTeams, sweepHungTeams } from '../../lib/team-health';
import { checkHungTeams } from '../cycle-watchdog';

const MIN = 60_000;
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

type Row = Record<string, unknown>;

/** شیم حداقلی PostgREST روی pg؛ فقط سطحی که کد واقعی استفاده می‌کند. */
class SelectBuilder {
  private wheres: string[] = [];
  private params: unknown[] = [];
  private lim?: number;
  constructor(
    private pool: Pool,
    private table: string,
    private cols: string,
  ) {}
  eq(col: string, val: unknown): this {
    this.params.push(val);
    this.wheres.push(`"${col}" = $${this.params.length}`);
    return this;
  }
  gte(col: string, val: unknown): this {
    this.params.push(val);
    this.wheres.push(`"${col}" >= $${this.params.length}`);
    return this;
  }
  ilike(col: string, pattern: unknown): this {
    this.params.push(pattern);
    this.wheres.push(`"${col}" ILIKE $${this.params.length}`);
    return this;
  }
  limit(n: number): this {
    this.lim = n;
    return this;
  }
  private build(): { text: string; params: unknown[] } {
    let text = `select ${this.cols} from "${this.table}"`;
    if (this.wheres.length) text += ` where ${this.wheres.join(' and ')}`;
    if (this.lim !== undefined) text += ` limit ${this.lim}`;
    return { text, params: this.params };
  }
  then(
    onF?: ((v: { data: Row[]; error: null }) => unknown) | null,
    onR?: ((e: unknown) => unknown) | null,
  ): Promise<unknown> {
    const { text, params } = this.build();
    return this.pool
      .query(text, params as unknown[])
      .then((res) => ({ data: res.rows as Row[], error: null }))
      .then(onF as never, onR as never);
  }
}

class UpdateBuilder {
  private wheres: string[] = [];
  private params: unknown[] = [];
  private sets: string[] = [];
  constructor(
    private pool: Pool,
    private table: string,
    obj: Row,
  ) {
    for (const [k, v] of Object.entries(obj)) {
      this.params.push(v);
      this.sets.push(`"${k}" = $${this.params.length}`);
    }
  }
  eq(col: string, val: unknown): this {
    this.params.push(val);
    this.wheres.push(`"${col}" = $${this.params.length}`);
    return this;
  }
  then(
    onF?: ((v: { data: null; error: null }) => unknown) | null,
    onR?: ((e: unknown) => unknown) | null,
  ): Promise<unknown> {
    const text = `update "${this.table}" set ${this.sets.join(', ')} where ${this.wheres.join(' and ')}`;
    return this.pool
      .query(text, this.params as unknown[])
      .then(() => ({ data: null, error: null }))
      .then(onF as never, onR as never);
  }
}

function makeShim(pool: Pool): SupabaseClient {
  return {
    from(table: string) {
      return {
        select: (cols: string) => new SelectBuilder(pool, table, cols),
        update: (obj: Row) => new UpdateBuilder(pool, table, obj),
      };
    },
  } as unknown as SupabaseClient;
}

function makePool(): Pool {
  const password = readFileSync('/home/hatch/.config/thailandgard/db-password', 'utf8').trim();
  return new Pool({
    host: '127.0.0.1',
    port: 15432,
    database: 'postgres',
    user: 'postgres',
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
}

test('تریگر واقعی: ضربانِ خالص updated_at را جلو نمی‌برد (ریشه‌ی باگ)', async (t) => {
  const pool = makePool();
  try {
    await pool.query('select 1');
  } catch {
    t.skip('تونل pg بالا نیست؛ تست یکپارچه رد شد');
    return;
  }
  let rowId: string | null = null;
  let cycleId: string | null = null;
  try {
    const c = await pool.query(`insert into cycles (run_id, status) values ($1,'running') returning id`, [
      `trigger-test-${Date.now()}`,
    ]);
    cycleId = c.rows[0].id as string;
    // ردیف «هنگِ ضربان‌زن»: آخرین پیشرفت واقعی ۱۱ دقیقه پیش
    const r = await pool.query(
      `insert into team_runs (cycle_id, team, wave, status, started_at, updated_at, heartbeat_at, current_task)
       values ($1,'trigger-probe',1,'running',$2,$3,$4,'تست') returning id`,
      [cycleId, isoAgo(30 * MIN), isoAgo(11 * MIN), isoAgo(30_000)],
    );
    rowId = r.rows[0].id as string;
    const updatedAt = async () =>
      (await pool.query(`select updated_at from team_runs where id=$1`, [rowId])).rows[0].updated_at as string;

    const before = await updatedAt();
    // شبیه‌سازی ۵ ضربان ۶۰ ثانیه‌ای ارکستراتور: فقط heartbeat_at
    for (let i = 0; i < 5; i++) {
      await pool.query(`update team_runs set heartbeat_at = now() where id=$1`, [rowId]);
    }
    const afterBeats = await updatedAt();
    assert.equal(
      new Date(afterBeats).getTime(),
      new Date(before).getTime(),
      'پس از ۵ ضربان خالص، updated_at نباید تکان خورده باشد (وگرنه هنگ نامرئی می‌ماند)',
    );
    // ولی گزارش پیشرفت واقعی (مثل reportProgress) باید updated_at را جلو ببرد
    await pool.query(`update team_runs set current_task='پیشرفت واقعی', progress=50 where id=$1`, [rowId]);
    const afterProgress = await updatedAt();
    assert.ok(
      new Date(afterProgress).getTime() > new Date(afterBeats).getTime(),
      'گزارش پیشرفت واقعی باید updated_at را جلو ببرد',
    );
  } finally {
    if (rowId) await pool.query(`delete from team_runs where id=$1`, [rowId]);
    if (cycleId) await pool.query(`delete from cycles where id=$1`, [cycleId]);
    await pool.end();
  }
});

test('شناسایی/هشدار/ری‌استارت واقعی تیم هنگ‌کرده روی دیتابیس واقعی', async (t) => {
  const pool = makePool();
  try {
    await pool.query('select 1');
  } catch {
    t.skip('تونل pg بالا نیست؛ تست یکپارچه رد شد');
    return;
  }
  const shim = makeShim(pool);
  const runId = `watchdog-hang-test-${Date.now()}`;
  let cycleId: string | null = null;
  const sent: Array<{ team: string; message: string; cycleId?: string }> = [];
  // استاب اطلاع‌رسانی: به‌جای تلگرام واقعی، فقط ثبت می‌کند؛ ولی «ثبت پنل»
  // را واقعاً در notifications می‌نویسد تا مسیر ضداسپم هم واقعی تست شود.
  const stubNotify = async (input: { team: string; message: string; cycleId?: string }) => {
    sent.push(input);
    await pool.query(
      `insert into notifications (cycle_id, team, message, channel, status) values ($1,$2,$3,'telegram','sent')`,
      [input.cycleId ?? null, input.team, input.message],
    );
    return { panelId: 'stub', telegramMessageId: null };
  };
  try {
    const c = await pool.query(`insert into cycles (run_id, status) values ($1,'running') returning id`, [runId]);
    cycleId = c.rows[0].id as string;
    const mk = (team: string, startedAgo: number, updatedAgo: number, hbAgoMs: number | null) =>
      pool.query(
        `insert into team_runs (cycle_id, team, wave, status, started_at, updated_at, heartbeat_at, current_task)
         values ($1,$2,1,'running',$3,$4,$5,'مرحله‌ی تست')`,
        [cycleId, team, isoAgo(startedAgo), isoAgo(updatedAgo), hbAgoMs === null ? null : isoAgo(hbAgoMs)],
      );
    // تیم هنگ‌کرده‌ی مصنوعی: ضربان می‌زند (۳۰ ثانیه پیش) ولی ۱۱ دقیقه بی‌پیشرفت
    await mk('team-hung', 30 * MIN, 11 * MIN, 30_000);
    // تیم سالم: پیشرفت ۲ دقیقه پیش
    await mk('team-healthy', 20 * MIN, 2 * MIN, 30_000);
    // فرایند مرده: ۱۶ دقیقه بی‌ضربان
    await mk('team-dead', 40 * MIN, 16 * MIN, 16 * MIN);

    // ۱. شناسایی با منطق واقعی مشترک
    const bad = await findUnhealthyTeams(shim, cycleId);
    assert.deepEqual(
      bad.map((b) => b.team).sort(),
      ['team-dead', 'team-hung'],
      'فقط hung و dead باید ناسالم شناخته شوند',
    );
    assert.equal(bad.find((b) => b.team === 'team-hung')!.health, 'hung');
    assert.equal(bad.find((b) => b.team === 'team-dead')!.health, 'dead');

    // ۲. هشدار واچ‌داگ واقعی (با notify استاب‌شده)
    await checkHungTeams(shim, { id: cycleId, run_id: runId }, stubNotify as never);
    assert.equal(sent.length, 2, 'باید دقیقاً ۲ هشدار ثبت شود (hung و dead)');
    const hungMsg = sent.find((s) => s.message.includes('[hang:team-hung:hung]'))!.message;
    const deadMsg = sent.find((s) => s.message.includes('[hang:team-dead:dead]'))!.message;
    assert.match(hungMsg, /هشدار: تیم هنگ کرده است/);
    assert.match(hungMsg, /ضربان: زنده/);
    assert.match(deadMsg, /هشدار: فرایند تیم به نظر مرده می‌رسد/);
    assert.ok(!sent.some((s) => s.message.includes('team-healthy')), 'تیم سالم نباید هشدار بگیرد');

    // ۳. اجرای دوم: ضداسپم واقعی (رکورد notifications نوشته شده) → بدون هشدار تازه
    await checkHungTeams(shim, { id: cycleId, run_id: runId }, stubNotify as never);
    assert.equal(sent.length, 2, 'اجرای دوم نباید هشدار تکراری بدهد');

    // ۴. ری‌استارت واقعی مسیر ورکر: hung/dead ناموفق می‌شوند، سالم می‌ماند
    const swept = await sweepHungTeams(shim, cycleId);
    assert.equal(swept.length, 2);
    const st = await pool.query(`select team, status, error from team_runs where cycle_id=$1`, [cycleId]);
    const byTeam: Record<string, { status: string; error: string | null }> = Object.fromEntries(
      st.rows.map((r) => [r.team as string, { status: r.status as string, error: r.error as string | null }]),
    );
    assert.equal(byTeam['team-hung'].status, 'failed');
    assert.match(byTeam['team-hung'].error ?? '', /هنگ/);
    assert.equal(byTeam['team-dead'].status, 'failed');
    assert.match(byTeam['team-dead'].error ?? '', /تایم‌اوت ورکر/);
    assert.equal(byTeam['team-healthy'].status, 'running', 'تیم سالم نباید دست بخورد');
    assert.equal(byTeam['team-healthy'].error, null);
  } finally {
    if (cycleId) {
      await pool.query(`delete from notifications where cycle_id=$1`, [cycleId]);
      await pool.query(`delete from cycles where id=$1`, [cycleId]); // team_runs با cascade پاک می‌شود
    }
    await pool.end();
  }
});
