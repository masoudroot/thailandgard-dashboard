/**
 * lib/bridge/bridge.test.mts: تست سرتاسری منطق پل با mock.
 *
 * کل چرخهٔ عمر پچ (proposed ← gated ← committed ← approved ← merged ← rolledback)
 * در برابر منطق واقعی lib/bridge/pipeline.ts اجرا می‌شود؛ فقط لایهٔ شبکه mock است:
 * - fetch سراسری با گیت‌هاب جعلی درون‌حافظه‌ای جایگزین می‌شود؛ هیچ تماس واقعی
 *   به api.github.com گرفته نمی‌شود.
 * - دروازهٔ کیفیت (lib/quality-gate) واقعی اجرا می‌شود، نه mock.
 * - ذخیره‌سازی پچ حافظه‌ای است (createMemoryStore)؛ دیتابیس واقعی لمس نمی‌شود.
 * - احراز مدیر با تابع تزریقی انجام می‌شود، نه Supabase واقعی.
 *
 * سناریوها:
 *  ۱. پچ سالم ← gate سبز ← وضعیت committed (کامیت از مسیر واقعی کد ولی با fetch جعلی)
 *  ۲. پچ با مسیر ناامن ← gate قرمز ← وضعیت همان proposed می‌ماند و gate_errors ثبت می‌شود
 *  ۳. approve بدون احراز مدیر ← ۴۰۱
 *  ۴. rollback روی پچ merged ← revert ساخته می‌شود؛ rollback روی پچ proposed ← خطا
 *
 * اجرا: npx tsx --test lib/bridge/bridge.test.mts
 * (پسوند mts عمدی است تا از tsc سخت‌گیرانهٔ ریپو خارج بماند)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMemoryStore,
  proposePatch,
  gateAndCommit,
  approvePatch,
  mergePatch,
  rollbackPatch,
  HttpError,
} from './pipeline';
import type { PatchStore, BridgePatch } from './pipeline';
import type { PatchFile } from '../github';

/* ------------------------------------------------------------------ */
/* گیت‌هاب جعلی: همهٔ تماس‌های fetch این‌جا پاسخ می‌گیرند              */
/* ------------------------------------------------------------------ */

const GITHUB_API = 'https://api.github.com';
const DEV_HEAD = 'd3adbeef00000000000000000000000000000000';
const COMMIT_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const MERGE_SHA = 'aa11bb22cc33dd44ee55ff660011223344556677';
const PARENT_SHA = 'bb22cc33dd44ee55ff660011223344556677889900';
const PARENT_TREE = 'cc33dd44ee55ff66001122334455667788990011';
const REVERT_SHA = 'dd44ee55ff660011223344556677889900112233';

interface CapturedCall {
  url: string;
  method: string;
  body: unknown;
}

let calls: CapturedCall[] = [];
let realFetch: typeof fetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function fakeFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  let body: unknown;
  try {
    body = init?.body ? JSON.parse(String(init.body)) : undefined;
  } catch {
    body = undefined;
  }
  calls.push({ url, method, body });

  if (!url.startsWith(GITHUB_API)) {
    return jsonResponse({ message: 'external call blocked in test' }, 500);
  }
  const path = new URL(url).pathname;

  // رأس dev (هم برای ساخت شاخهٔ پل، هم برای revert)
  if (method === 'GET' && path.endsWith('/git/refs/heads/dev')) {
    return jsonResponse({ object: { sha: DEV_HEAD } });
  }
  // ساخت شاخهٔ پل
  if (method === 'POST' && path.endsWith('/git/refs')) {
    return jsonResponse({ ref: 'refs/heads/ai-bridge/x', object: { sha: DEV_HEAD } }, 201);
  }
  // بلاب هر فایل
  if (method === 'POST' && path.endsWith('/git/blobs')) {
    const n = String(calls.length).padStart(2, '0');
    return jsonResponse({ sha: `b10b${n}0000000000000000000000000000000000`.slice(0, 40) }, 201);
  }
  // درخت
  if (method === 'POST' && path.endsWith('/git/trees')) {
    return jsonResponse({ sha: '7ree000000000000000000000000000000000001' }, 201);
  }
  // کامیت: عادی یا revert (با پیشوند Revert)
  if (method === 'POST' && path.endsWith('/git/commits')) {
    const msg = (body as { message?: string } | undefined)?.message ?? '';
    if (msg.startsWith('Revert')) return jsonResponse({ sha: REVERT_SHA }, 201);
    return jsonResponse({ sha: COMMIT_SHA }, 201);
  }
  // به‌روزرسانی رأس شاخه
  if (method === 'PATCH' && path.includes('/git/refs/heads/')) {
    return jsonResponse({ ref: 'updated', object: { sha: 'updated' } });
  }
  // مرج شاخهٔ پل در dev
  if (method === 'POST' && path.endsWith('/merges')) {
    return jsonResponse({ sha: MERGE_SHA, merged: true }, 201);
  }
  // خوانش کامیت مرج و والدش (مسیر revert)
  if (method === 'GET' && path.includes('/git/commits/')) {
    const seg = path.split('/').pop() ?? '';
    if (seg.startsWith(MERGE_SHA.slice(0, 7))) {
      return jsonResponse({
        sha: MERGE_SHA,
        parents: [{ sha: PARENT_SHA }],
        tree: { sha: 'mergedtree000000000000000000000000000002' },
      });
    }
    if (seg.startsWith(PARENT_SHA.slice(0, 7))) {
      return jsonResponse({
        sha: PARENT_SHA,
        tree: { sha: PARENT_TREE },
        parents: [{ sha: DEV_HEAD }],
      });
    }
  }
  return jsonResponse({ message: `not mocked: ${method} ${path}` }, 404);
}

/* ------------------------------------------------------------------ */
/* کمک‌تابع‌های تست                                                    */
/* ------------------------------------------------------------------ */

const healthyFiles: PatchFile[] = [
  {
    path: 'site/components/TestCard.tsx',
    content: 'export function TestCard() {\n  return <div>سلام دنیا</div>;\n}\n',
  },
];

const evilFiles: PatchFile[] = [{ path: '../../.env', content: 'SECRET=1' }];

const verifyManager = async (token: string): Promise<boolean> =>
  token === 'manager-valid-token';

const MANAGER_CTX = { verifyManagerToken: verifyManager };

/** کل جریان تا merged؛ برای سناریوی rollback. */
async function flowToMerged(store: PatchStore): Promise<BridgePatch> {
  const p = proposePatch(store, 'dev', healthyFiles, 'کارت تست');
  const g = await gateAndCommit(store, p.id);
  assert.equal(g.gatePassed, true, 'پیش‌نیاز: gate باید سبز باشد');
  await approvePatch(store, p.id, { ...MANAGER_CTX, managerToken: 'manager-valid-token' });
  return mergePatch(store, p.id);
}

function isHttp401(err: unknown): boolean {
  return err instanceof HttpError && err.status === 401;
}

before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch as typeof fetch;
  // دیتابیس واقعی در دسترس نباشد تا getSetting به fallback env برود
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  // توکن جعلی گیت‌هاب؛ فقط fetch جعلی آن را می‌بیند
  process.env.GITHUB_TOKEN = 'gh-test-token-not-real';
});

after(() => {
  globalThis.fetch = realFetch;
});

/* ------------------------------------------------------------------ */
/* سناریو ۱: پچ سالم ← gate سبز ← committed                            */
/* ------------------------------------------------------------------ */

describe('سناریو ۱: پچ سالم از دروازه رد می‌شود و کامیت می‌شود', () => {
  it('proposePatch پچ را با وضعیت proposed می‌سازد', () => {
    const store = createMemoryStore();
    const p = proposePatch(store, 'dev', healthyFiles, 'کارت تست');
    assert.equal(p.status, 'proposed');
    assert.equal(p.team, 'dev');
    assert.equal(p.files.length, 1);
    assert.equal(store.get(p.id)?.status, 'proposed');
  });

  it('gateAndCommit روی پچ سالم: وضعیت committed و ثبت SHA', async () => {
    const store = createMemoryStore();
    const p = proposePatch(store, 'dev', healthyFiles, 'کارت تست');
    const { gatePassed, patch } = await gateAndCommit(store, p.id);
    assert.equal(gatePassed, true);
    assert.equal(patch.status, 'committed');
    assert.ok(patch.branch?.startsWith('ai-bridge/'), 'شاخهٔ پل باید ساخته شده باشد');
    assert.equal(patch.commit_sha, COMMIT_SHA.slice(0, 7));
    assert.equal(patch.gate_errors, undefined);
  });

  it('کامیت از مسیر واقعی GitHub API گذشته است (ولی mock)', async () => {
    calls = [];
    const store = createMemoryStore();
    const p = proposePatch(store, 'dev', healthyFiles, 'کارت تست');
    await gateAndCommit(store, p.id);
    assert.ok(calls.length > 0, 'باید دست‌کم یک فراخوانی fetch ثبت شده باشد');
    assert.ok(
      calls.every((c) => c.url.startsWith(GITHUB_API)),
      'همهٔ تماس‌ها باید به api.github.com رفته باشند، نه جای دیگر',
    );
    const commitCall = calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/git/commits'),
    );
    assert.ok(commitCall, 'باید POST /git/commits صدا زده شده باشد');
    const msg = (commitCall?.body as { message?: string } | undefined)?.message ?? '';
    assert.ok(msg.startsWith('[dev]'), `پیام کامیت باید با [dev] شروع شود، شد: ${msg}`);
  });

  it('کامیت دوباره روی پچ committed خطا می‌دهد', async () => {
    const store = createMemoryStore();
    const p = proposePatch(store, 'dev', healthyFiles);
    await gateAndCommit(store, p.id);
    await assert.rejects(() => gateAndCommit(store, p.id), /فقط پچ proposed/);
  });
});

/* ------------------------------------------------------------------ */
/* سناریو ۲: پچ با مسیر ناامن ← gate قرمز ← proposed + gate_errors     */
/* ------------------------------------------------------------------ */

describe('سناریو ۲: پچ با مسیر ناامن از دروازه رد نمی‌شود', () => {
  it('وضعیت همان proposed می‌ماند و کامیت ثبت نمی‌شود', async () => {
    const store = createMemoryStore();
    const p = proposePatch(store, 'dev', evilFiles, 'تلاش نفوذ');
    const { gatePassed, patch } = await gateAndCommit(store, p.id);
    assert.equal(gatePassed, false);
    assert.equal(patch.status, 'proposed');
    assert.equal(patch.commit_sha, undefined);
    assert.equal(patch.branch, undefined);
  });

  it('gate_errors ثبت می‌شود و به مسیر ناامن اشاره می‌کند', async () => {
    const store = createMemoryStore();
    const p = proposePatch(store, 'dev', evilFiles);
    const { patch } = await gateAndCommit(store, p.id);
    assert.ok(
      Array.isArray(patch.gate_errors) && patch.gate_errors.length > 0,
      'gate_errors نباید خالی باشد',
    );
    const joined = (patch.gate_errors ?? []).join('\n');
    assert.ok(joined.includes('ساختار مسیر'), 'باید خطای چک «ساختار مسیر» ثبت شده باشد');
    assert.ok(
      joined.includes('..') || joined.includes('.env'),
      'باید به مسیر ناامن اشاره کند',
    );
  });

  it('وقتی gate قرمز است هیچ تماسی با GitHub گرفته نمی‌شود', async () => {
    calls = [];
    const store = createMemoryStore();
    const p = proposePatch(store, 'dev', evilFiles);
    await gateAndCommit(store, p.id);
    assert.equal(calls.length, 0, 'نباید هیچ fetchای زده شده باشد');
  });
});

/* ------------------------------------------------------------------ */
/* سناریو ۳: approve بدون احراز مدیر ← ۴۰۱                             */
/* ------------------------------------------------------------------ */

describe('سناریو ۳: تأیید مدیر بدون احراز، ۴۰۱ می‌دهد', () => {
  it('approve بدون توکن ← خطای ۴۰۱ و بدون تغییر وضعیت', async () => {
    const store = createMemoryStore();
    const p = proposePatch(store, 'dev', healthyFiles);
    await gateAndCommit(store, p.id);
    await assert.rejects(() => approvePatch(store, p.id, MANAGER_CTX), isHttp401);
    assert.equal(store.get(p.id)?.status, 'committed', 'وضعیت نباید عوض شده باشد');
  });

  it('approve با توکن نامعتبر ← خطای ۴۰۱', async () => {
    const store = createMemoryStore();
    const p = proposePatch(store, 'dev', healthyFiles);
    await gateAndCommit(store, p.id);
    await assert.rejects(
      () => approvePatch(store, p.id, { ...MANAGER_CTX, managerToken: 'wrong-token' }),
      isHttp401,
    );
    assert.equal(store.get(p.id)?.status, 'committed');
  });

  it('approve با توکن معتبر ← وضعیت approved', async () => {
    const store = createMemoryStore();
    const p = proposePatch(store, 'dev', healthyFiles);
    await gateAndCommit(store, p.id);
    const patch = await approvePatch(store, p.id, {
      ...MANAGER_CTX,
      managerToken: 'manager-valid-token',
    });
    assert.equal(patch.status, 'approved');
    assert.equal(patch.decided_by, 'manager');
    assert.ok(patch.decided_at, 'decided_at باید ثبت شده باشد');
  });
});

/* ------------------------------------------------------------------ */
/* سناریو ۴: rollback                                                  */
/* ------------------------------------------------------------------ */

describe('سناریو ۴: بازگردانی', () => {
  it('جریان کامل approve ← merge: وضعیت merged و ثبت merge_sha', async () => {
    const store = createMemoryStore();
    const merged = await flowToMerged(store);
    assert.equal(merged.status, 'merged');
    assert.equal(merged.merge_sha, MERGE_SHA.slice(0, 7));
  });

  it('rollback روی پچ merged ← revert ساخته می‌شود و وضعیت rolledback', async () => {
    calls = [];
    const store = createMemoryStore();
    const merged = await flowToMerged(store);
    const rolled = await rollbackPatch(store, merged.id);
    assert.equal(rolled.status, 'rolledback');
    assert.equal(rolled.revert_sha, REVERT_SHA.slice(0, 7));

    const revertCall = calls.find(
      (c) =>
        c.method === 'POST' &&
        c.url.endsWith('/git/commits') &&
        String((c.body as { message?: string } | undefined)?.message ?? '').startsWith(
          'Revert',
        ),
    );
    assert.ok(revertCall, 'باید کامیت revert ساخته شده باشد');
    assert.equal(
      (revertCall?.body as { tree?: string } | undefined)?.tree,
      PARENT_TREE,
      'درخت revert باید درخت والد کامیت مرج باشد',
    );
    const refUpdate = calls.find(
      (c) => c.method === 'PATCH' && c.url.endsWith('/git/refs/heads/dev'),
    );
    assert.ok(refUpdate, 'رأس dev باید به کامیت revert اشاره کند');
  });

  it('rollback روی پچ proposed ← خطا و بدون هیچ تماسی با GitHub', async () => {
    calls = [];
    const store = createMemoryStore();
    const p = proposePatch(store, 'dev', healthyFiles);
    await assert.rejects(() => rollbackPatch(store, p.id), /فقط برای پچ merged/);
    assert.equal(calls.length, 0, 'نباید هیچ fetchای زده شده باشد');
    assert.equal(store.get(p.id)?.status, 'proposed');
  });

  it('rollback دوباره روی پچ rolledback ← خطا', async () => {
    const store = createMemoryStore();
    const merged = await flowToMerged(store);
    await rollbackPatch(store, merged.id);
    await assert.rejects(() => rollbackPatch(store, merged.id), /قبلاً بازگردانی/);
  });
});
