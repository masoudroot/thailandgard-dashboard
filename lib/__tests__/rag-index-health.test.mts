/**
 * lib/__tests__/rag-index-health.test.mts: تست سلامت مسیر ایندکس دانش (تیم ۳).
 *
 * اجرا: npx tsx --test lib/__tests__/rag-index-health.test.mts
 *
 * پوشش:
 * - منطق خالص تصمیم هشدار (آستانه + cooldown)
 * - قالب لاگ ساخت‌یافته و پیام هشدار
 * - ارکستراسیون reportIndexOutcome با کلاینت/notify تزریقی:
 *   لاگ همیشه، فراخوانی RPC با آرگومان درست، هشدار دقیقاً روی آستانه،
 *   عدم هشدار زیر آستانه و داخل cooldown، ثبت alert_sent_at،
 *   و هرگز throw نکردن (حتی وقتی دیتابیس/notify می‌میرد).
 * - سیم‌کشی tryIndexKnowledge: خطای ایندکس دیگر بی‌صدا نیست (لاگ ساخت‌یافته).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  formatIndexAlertMessage,
  formatIndexLogLine,
  INDEX_ALERT_COOLDOWN_HOURS,
  reportIndexOutcome,
  shouldSendIndexAlert,
  type ReportIndexDeps,
} from '../rag-index-health.js';
import { tryIndexKnowledge } from '../knowledge.js';

interface FakeState {
  consecutive: number;
  totalF: number;
  totalS: number;
  alertSentAt: string | null;
  failRpc: boolean;
}

function makeHarness(state?: Partial<FakeState>) {
  const s: FakeState = {
    consecutive: 0,
    totalF: 0,
    totalS: 0,
    alertSentAt: null,
    failRpc: false,
    ...state,
  };
  const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const updateCalls: Array<{ table: string; values: Record<string, unknown> }> = [];
  const notifyCalls: Array<{ team: string; message: string }> = [];
  const logs: string[] = [];
  const errorLogs: string[] = [];

  const client = {
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, params });
      if (s.failRpc) return { data: null, error: { message: 'db مرده' } };
      if (params.p_ok) {
        s.consecutive = 0;
        s.totalS++;
      } else {
        s.consecutive++;
        s.totalF++;
      }
      return {
        data: [
          {
            consecutive_failures: s.consecutive,
            total_failures: s.totalF,
            total_successes: s.totalS,
            alert_sent_at: s.alertSentAt,
          },
        ],
        error: null,
      };
    },
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => ({
        eq: async () => {
          updateCalls.push({ table, values });
          return { error: null };
        },
      }),
    }),
  } as unknown as SupabaseClient;

  const deps: ReportIndexDeps = {
    client,
    notify: (async (input: { team: string; message: string }) => {
      notifyCalls.push(input);
      return { panelId: 'panel-1', telegramMessageId: null };
    }) as ReportIndexDeps['notify'],
    log: (l: string) => logs.push(l),
    errorLog: (l: string) => errorLogs.push(l),
    threshold: 3,
  };

  return { s, rpcCalls, updateCalls, notifyCalls, logs, errorLogs, deps };
}

describe('shouldSendIndexAlert', () => {
  it('زیر آستانه هشدار نمی‌دهد', () => {
    assert.equal(
      shouldSendIndexAlert({ consecutiveFailures: 2, threshold: 3, alertSentAt: null }),
      false,
    );
  });

  it('روی آستانه بدون هشدار قبلی، هشدار می‌دهد', () => {
    assert.equal(
      shouldSendIndexAlert({ consecutiveFailures: 3, threshold: 3, alertSentAt: null }),
      true,
    );
  });

  it('داخل cooldown هشدار تکراری نمی‌دهد', () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // ۱ ساعت پیش
    assert.equal(
      shouldSendIndexAlert({ consecutiveFailures: 9, threshold: 3, alertSentAt: recent }),
      false,
    );
  });

  it('بعد از پایان cooldown دوباره هشدار می‌دهد', () => {
    const old = new Date(
      Date.now() - (INDEX_ALERT_COOLDOWN_HOURS + 1) * 3_600_000,
    ).toISOString();
    assert.equal(
      shouldSendIndexAlert({ consecutiveFailures: 9, threshold: 3, alertSentAt: old }),
      true,
    );
  });
});

describe('formatIndexLogLine / formatIndexAlertMessage', () => {
  it('لاگ ساخت‌یافته‌ی JSON با tag و outcome می‌سازد', () => {
    const line = formatIndexLogLine({
      ok: false,
      knowledgeId: 'kid-1',
      team: 'qa',
      source: 'tryIndexKnowledge',
      error: 'مدل امبدینگ تنظیم نشده است',
    });
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.equal(parsed.tag, 'rag-index');
    assert.equal(parsed.outcome, 'failed');
    assert.equal(parsed.knowledge_id, 'kid-1');
    assert.equal(parsed.team, 'qa');
    assert.ok(String(parsed.error).includes('امبدینگ'));
  });

  it('پیام هشدار شامل تعداد خطای پیاپی و آخرین خطاست', () => {
    const msg = formatIndexAlertMessage({
      consecutiveFailures: 5,
      threshold: 5,
      lastError: 'تایم‌اوت درگاه',
    });
    assert.ok(msg.includes('۵') || msg.includes('5'));
    assert.ok(msg.includes('تایم‌اوت درگاه'));
  });
});

describe('reportIndexOutcome', () => {
  it('موفقیت: لاگ ساخت‌یافته + RPC با p_ok=true + بدون هشدار', async () => {
    const h = makeHarness();
    await reportIndexOutcome(
      { knowledgeId: 'kid-1', team: 'qa', ok: true, source: 'tryIndexKnowledge' },
      h.deps,
    );
    assert.equal(h.logs.length, 1);
    assert.ok(h.logs[0].includes('"outcome":"indexed"'));
    assert.equal(h.rpcCalls.length, 1);
    assert.equal(h.rpcCalls[0].name, 'record_rag_index_outcome');
    assert.equal(h.rpcCalls[0].params.p_ok, true);
    assert.equal(h.rpcCalls[0].params.p_knowledge_id, 'kid-1');
    assert.equal(h.notifyCalls.length, 0);
  });

  it('شکست زیر آستانه: لاگ خطا + RPC با p_ok=false + بدون هشدار', async () => {
    const h = makeHarness();
    await reportIndexOutcome(
      { knowledgeId: 'kid-1', team: 'qa', ok: false, error: 'boom', source: 'x' },
      h.deps,
    );
    await reportIndexOutcome(
      { knowledgeId: 'kid-2', team: 'qa', ok: false, error: 'boom', source: 'x' },
      h.deps,
    );
    assert.equal(h.errorLogs.filter((l) => l.includes('"outcome":"failed"')).length, 2);
    assert.equal(h.rpcCalls.filter((c) => c.params.p_ok === false).length, 2);
    assert.equal(h.notifyCalls.length, 0);
  });

  it('روی آستانه: دقیقاً یک هشدار با متن کامل + ثبت alert_sent_at', async () => {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) {
      await reportIndexOutcome(
        { team: 'qa', ok: false, error: `خطای ${i}`, source: 'x' },
        h.deps,
      );
    }
    assert.equal(h.notifyCalls.length, 1);
    assert.equal(h.notifyCalls[0].team, 'rag-index');
    assert.ok(h.notifyCalls[0].message.includes('۳') || h.notifyCalls[0].message.includes('3'));
    assert.ok(h.notifyCalls[0].message.includes('خطای 2'));
    const alertUpdate = h.updateCalls.find((c) => c.table === 'rag_index_health');
    assert.ok(alertUpdate, 'باید alert_sent_at ثبت شود');
    assert.ok(alertUpdate!.values.alert_sent_at);
  });

  it('داخل cooldown هشدار تکراری نمی‌رود', async () => {
    const h = makeHarness({ alertSentAt: new Date().toISOString(), consecutive: 2 });
    await reportIndexOutcome({ team: 'qa', ok: false, error: 'boom', source: 'x' }, h.deps);
    assert.equal(h.notifyCalls.length, 0);
  });

  it('موفقیت شمارنده‌ی پیاپی را ریست می‌کند', async () => {
    const h = makeHarness({ consecutive: 4, totalF: 4 });
    await reportIndexOutcome({ team: 'qa', ok: true, source: 'x' }, h.deps);
    assert.equal(h.s.consecutive, 0);
    assert.equal(h.notifyCalls.length, 0);
  });

  it('خطای RPC هم throw نمی‌کند و لاگ می‌شود', async () => {
    const h = makeHarness({ failRpc: true });
    await reportIndexOutcome({ team: 'qa', ok: false, error: 'boom', source: 'x' }, h.deps);
    assert.ok(h.errorLogs.some((l) => l.includes('ناموفق بود')));
    assert.equal(h.notifyCalls.length, 0);
  });

  it('بدون کلاینت و env هم throw نمی‌کند (مسیر واقعی getSupabase)', async () => {
    const logs: string[] = [];
    const errorLogs: string[] = [];
    await reportIndexOutcome(
      { team: 'qa', ok: false, error: 'boom', source: 'x' },
      { log: (l) => logs.push(l), errorLog: (l) => errorLogs.push(l), threshold: 3 },
    );
    assert.ok(errorLogs.some((l) => l.includes('"outcome":"failed"')));
  });
});

describe('tryIndexKnowledge wiring', () => {
  it('خطای ایندکس دیگر بی‌صدا نیست: false + لاگ ساخت‌یافته', async () => {
    const captured: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    };
    try {
      const result = await tryIndexKnowledge('', 'qa', 't', 'متن تستی');
      assert.equal(result, false);
      const structured = captured.find((l) => l.includes('"tag":"rag-index"'));
      assert.ok(structured, 'باید لاگ ساخت‌یافته‌ی rag-index در console.error باشد');
      assert.ok(structured!.includes('"outcome":"failed"'));
    } finally {
      console.error = origError;
    }
  });
});
