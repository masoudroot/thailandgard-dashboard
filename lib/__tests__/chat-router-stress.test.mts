/**
 * lib/__tests__/chat-router-stress.test.mts: تست فشار روتر هوشمند مدل‌ها.
 *
 * ۵ سناریوی کارت باگ‌گیری + سناریوهای تکمیلی، با mock سرور HTTP و
 * PostgREST جعلی؛ بدون نیاز به کلید واقعی.
 *
 * هر تست از endpoint-id و نام مدل یکتا استفاده می‌کند تا cooldownهای
 * درون‌حافظه‌ای (module-level) بین تست‌ها تداخل نکنند.
 *
 * اجرا: npx tsx --test lib/__tests__/chat-router-stress.test.mts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { startFakePostgrest, seedDb } from '../../worker/__tests__/fake-postgrest.mjs';

/** رفتار mock برای یک مدل چت */
interface ChatRoute {
  status: number;
  text: string;
  /** true یعنی پاسخ 200 ولی choices خالی (پاسخ پوچ) */
  emptyChoices?: boolean;
}

/** رفتار mock برای یک مدل امبدینگ */
interface EmbRoute {
  status: number;
  text: string;
  dim?: number;
}

interface MockLlm {
  server: Server;
  baseUrl: string;
  /** همه‌ی درخواست‌های رسیده: {path, model} */
  requests: Array<{ path: string; model: string }>;
  chatRoutes: Record<string, ChatRoute>;
  embRoutes: Record<string, EmbRoute>;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

async function startMockLlm(): Promise<MockLlm> {
  const mock: MockLlm = {
    server: null as unknown as Server,
    baseUrl: '',
    requests: [],
    chatRoutes: {},
    embRoutes: {},
    close: async () => {},
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = JSON.parse((await readBody(req)) || '{}');
    const model = String(body.model || '');
    if (req.method === 'POST' && req.url === '/chat/completions') {
      mock.requests.push({ path: '/chat/completions', model });
      const route = mock.chatRoutes[model] ?? { status: 404, text: 'model not found' };
      res.writeHead(route.status, { 'Content-Type': 'application/json' });
      if (route.status === 200 && !route.emptyChoices) {
        res.end(JSON.stringify({ choices: [{ message: { content: route.text } }] }));
      } else if (route.status === 200 && route.emptyChoices) {
        res.end(JSON.stringify({ choices: [] }));
      } else {
        res.end(JSON.stringify({ error: { message: route.text } }));
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/embeddings') {
      mock.requests.push({ path: '/embeddings', model });
      const route = mock.embRoutes[model] ?? { status: 404, text: 'model not found' };
      res.writeHead(route.status, { 'Content-Type': 'application/json' });
      if (route.status === 200) {
        const dim = route.dim ?? 1536;
        res.end(JSON.stringify({ data: [{ embedding: new Array(dim).fill(0.1) }] }));
      } else {
        res.end(JSON.stringify({ error: { message: route.text } }));
      }
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as AddressInfo;
  mock.server = server;
  mock.baseUrl = `http://127.0.0.1:${addr.port}`;
  mock.close = () => new Promise<void>((r) => server.close(() => r()));
  return mock;
}

let fake: Awaited<ReturnType<typeof startFakePostgrest>>;
let mockA: MockLlm;
let mockB: MockLlm;

function ep(id: string, name: string, mock: MockLlm) {
  return { id, name, baseUrl: mock.baseUrl, apiKey: 'test-key' };
}

async function seedSettings(settings: Record<string, unknown>) {
  const rows = Object.entries(settings).map(([key, value]) => ({ key, value }));
  await seedDb(fake.url, { settings: rows });
}

async function readTables(): Promise<Record<string, unknown[]>> {
  const res = await fetch(`${fake.url}/__tables__`);
  return (await res.json()) as Record<string, unknown[]>;
}

function settingsOf(tables: Record<string, unknown[]>, key: string): unknown {
  const row = (tables.settings as Array<{ key: string; value: unknown }>).find(
    (r) => r.key === key,
  );
  return row?.value;
}

before(async () => {
  mockA = await startMockLlm();
  mockB = await startMockLlm();
  fake = await startFakePostgrest();
  process.env.SUPABASE_URL = fake.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
});

after(async () => {
  await fake.close();
  await mockA.close();
  await mockB.close();
});

/** مدل‌های تأییدشده‌ی reformboss (باید با QUALITY_CHAT_MODELS در llm.ts هم‌خوان باشند) */
const QUALITY_REFORMBOSS = [
  'glm-5.3-flash',
  'qwen3.8-flash',
  'qwen3.5-omni-flash',
  'deepseek-v4-flash',
  'kimi-k3',
];

describe('تست فشار روتر هوشمند', () => {
  it('سناریو ۴: فقط مدل‌های تأییدشده امتحان می‌شوند (هرگز مدل به‌دردنخور)', async () => {
    mockA.requests.length = 0;
    mockA.chatRoutes = {
      't1-primary': { status: 429, text: 'quota exhausted' },
      'glm-5.3-flash': { status: 200, text: 'ok-t1' },
    };
    await seedSettings({
      llm_endpoints: [ep('epT1', 'mock-reformboss-t1', mockA)],
      team_models: { dev: { endpointId: 'epT1', model: 't1-primary' } },
      llm_model_health: {},
    });
    const { callLLMSmart } = await import('../llm.js');
    const text = await callLLMSmart('بگو سلام', {
      team: 'dev',
      timeoutMs: 15000,
      maxTokens: 20,
    });
    assert.equal(text, 'ok-t1');
    const tried = mockA.requests.map((r) => r.model);
    // همه‌ی مدل‌های امتحان‌شده باید یا مدل اصلی باشند یا از فهرست تأییدشده
    for (const m of tried) {
      assert.ok(
        m === 't1-primary' || QUALITY_REFORMBOSS.includes(m),
        `مدل غیرمنتظره امتحان شد: ${m}`,
      );
    }
    // ترتیب: اول مدل اصلی، بعد اولین مدل تأییدشده
    assert.deepEqual(tried, ['t1-primary', 'glm-5.3-flash']);
  });

  it('سناریو ۵: بعد از 429، مدل در استراحت است و دوباره امتحان نمی‌شود', async () => {
    mockA.requests.length = 0;
    mockA.chatRoutes = {
      't2-primary': { status: 429, text: 'quota exhausted' },
      'glm-5.3-flash': { status: 200, text: 'ok-t2a' },
    };
    await seedSettings({
      llm_endpoints: [ep('epT2', 'mock-reformboss-t2', mockA)],
      team_models: { dev: { endpointId: 'epT2', model: 't2-primary' } },
      llm_model_health: {},
    });
    const { callLLMSmart } = await import('../llm.js');
    const t1 = await callLLMSmart('بگو سلام', {
      team: 'dev',
      timeoutMs: 15000,
      maxTokens: 20,
    });
    assert.equal(t1, 'ok-t2a');
    const primaryHitsAfterFirst = mockA.requests.filter(
      (r) => r.model === 't2-primary',
    ).length;
    assert.equal(primaryHitsAfterFirst, 1, 'فراخوان اول باید یک بار مدل اصلی را بزند');

    // حالا مدل جایگزین هم 429 می‌دهد و مدل سوم سالم است
    mockA.chatRoutes = {
      't2-primary': { status: 429, text: 'quota exhausted' },
      'glm-5.3-flash': { status: 429, text: 'quota exhausted now' },
      'qwen3.8-flash': { status: 200, text: 'ok-t2b' },
    };
    const t2 = await callLLMSmart('بگو سلام', {
      team: 'dev',
      timeoutMs: 15000,
      maxTokens: 20,
    });
    assert.equal(t2, 'ok-t2b');
    const primaryHitsTotal = mockA.requests.filter(
      (r) => r.model === 't2-primary',
    ).length;
    assert.equal(
      primaryHitsTotal,
      1,
      'مدل اصلی در فراخوان دوم نباید دوباره امتحان شود (cooldown)',
    );
  });

  it('سناریو ۳ (دقیق): روی 401 هیچ مدل دیگری از همان درگاه امتحان نمی‌شود', async () => {
    mockA.requests.length = 0;
    mockB.requests.length = 0;
    // درگاه A: همه 200 می‌دهند ولی نباید به‌جز مدل اصلی چیزی امتحان شود
    mockA.chatRoutes = {
      't3-primary': { status: 401, text: 'invalid key' },
      'glm-5.3-flash': { status: 200, text: 'should-not-happen-A' },
      'qwen3.8-flash': { status: 200, text: 'should-not-happen-A' },
    };
    mockB.chatRoutes = {
      'gemini-3.8-flash': { status: 200, text: 'ok-t3' },
    };
    await seedSettings({
      llm_endpoints: [
        ep('epT3a', 'mock-reformboss-t3', mockA),
        ep('epT3b', 'mock-gemini-t3', mockB),
      ],
      team_models: { dev: { endpointId: 'epT3a', model: 't3-primary' } },
      llm_model_health: {},
    });
    const { callLLMSmart } = await import('../llm.js');
    const text = await callLLMSmart('بگو سلام', {
      team: 'dev',
      timeoutMs: 15000,
      maxTokens: 20,
    });
    assert.equal(text, 'ok-t3');
    const aModels = mockA.requests.map((r) => r.model);
    assert.deepEqual(
      aModels,
      ['t3-primary'],
      'بعد از 401 نباید هیچ مدل دیگری از همان درگاه امتحان شود',
    );
    assert.ok(
      mockB.requests.some((r) => r.model === 'gemini-3.8-flash'),
      'درگاه دوم باید امتحان شود',
    );
  });

  it('سناریو تکمیلی: 503 فقط همان مدل را رد می‌کند، نه کل درگاه را', async () => {
    mockA.requests.length = 0;
    mockA.chatRoutes = {
      't4-primary': { status: 503, text: 'overloaded' },
      'glm-5.3-flash': { status: 200, text: 'ok-t4' },
    };
    await seedSettings({
      llm_endpoints: [ep('epT4', 'mock-reformboss-t4', mockA)],
      team_models: { dev: { endpointId: 'epT4', model: 't4-primary' } },
      llm_model_health: {},
    });
    const { callLLMSmart } = await import('../llm.js');
    const t1 = await callLLMSmart('بگو سلام', {
      team: 'dev',
      timeoutMs: 15000,
      maxTokens: 20,
    });
    assert.equal(t1, 'ok-t4');
    // فراخوان دوم: درگاه نباید به‌خاطر 503 قبلی «کلید خراب» شده باشد؛
    // مدل اصلی در cooldown است ولی همان درگاه با مدل جایگزین جواب می‌دهد
    const t2 = await callLLMSmart('بگو سلام', {
      team: 'dev',
      timeoutMs: 15000,
      maxTokens: 20,
    });
    assert.equal(t2, 'ok-t4');
    const tried = mockA.requests.map((r) => r.model);
    assert.ok(
      tried.filter((m) => m === 't4-primary').length === 1,
      'مدل 503خورده در فراخوان دوم نباید دوباره امتحان شود',
    );
    assert.ok(tried.length >= 3, 'درگاه باید در فراخوان دوم هم فعال باشد');
  });

  it('سناریو تکمیلی: 404 مدل اصلی باعث جایگزینی خودکار در team_models می‌شود', async () => {
    mockA.requests.length = 0;
    mockA.chatRoutes = {
      't5-gone': { status: 404, text: 'model not found' },
      'glm-5.3-flash': { status: 200, text: 'ok-t5' },
    };
    await seedSettings({
      llm_endpoints: [ep('epT5', 'mock-reformboss-t5', mockA)],
      team_models: { dev: { endpointId: 'epT5', model: 't5-gone' } },
      llm_model_health: {},
    });
    const { callLLMSmart } = await import('../llm.js');
    const text = await callLLMSmart('بگو سلام', {
      team: 'dev',
      timeoutMs: 15000,
      maxTokens: 20,
    });
    assert.equal(text, 'ok-t5');
    const tables = await readTables();
    const teamModels = settingsOf(tables, 'team_models') as Record<
      string,
      { endpointId: string; model: string }
    >;
    assert.equal(
      teamModels?.dev?.model,
      'glm-5.3-flash',
      'مدل منسوخ باید خودکار با جایگزین موفق عوض شود',
    );
    assert.equal(teamModels?.dev?.endpointId, 'epT5');
  });

  it('سناریو تکمیلی: وقتی همه مردند، خطای فارسی واضح و بدون گیر کردن', async () => {
    mockA.requests.length = 0;
    mockA.chatRoutes = {
      't6-primary': { status: 429, text: 'quota exhausted' },
      'glm-5.3-flash': { status: 429, text: 'quota exhausted' },
      'qwen3.8-flash': { status: 429, text: 'quota exhausted' },
      'qwen3.5-omni-flash': { status: 429, text: 'quota exhausted' },
      'deepseek-v4-flash': { status: 429, text: 'quota exhausted' },
      'kimi-k3': { status: 429, text: 'quota exhausted' },
    };
    await seedSettings({
      llm_endpoints: [ep('epT6', 'mock-reformboss-t6', mockA)],
      team_models: { dev: { endpointId: 'epT6', model: 't6-primary' } },
      llm_model_health: {},
    });
    const { callLLMSmart } = await import('../llm.js');
    const t0 = Date.now();
    await assert.rejects(
      () =>
        callLLMSmart('بگو سلام', {
          team: 'dev',
          timeoutMs: 15000,
          maxTokens: 20,
        }),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.ok(
          msg.includes('همه‌ی مدل‌ها'),
          `پیام خطا باید فارسی و واضح باشد، بود: ${msg.slice(0, 80)}`,
        );
        return true;
      },
    );
    const ms = Date.now() - t0;
    assert.ok(ms < 20000, `نباید گیر کند (شد ${ms}ms)`);
    // هر ۶ کاندیدا دقیقاً یک بار امتحان شده‌اند
    assert.equal(mockA.requests.length, 6);
  });

  it('سناریو تکمیلی: پاسخ پوچ (choices خالی) به مدل بعدی می‌رود', async () => {
    mockA.requests.length = 0;
    mockA.chatRoutes = {
      't7-primary': { status: 200, text: '', emptyChoices: true },
      'glm-5.3-flash': { status: 200, text: 'ok-t7' },
    };
    await seedSettings({
      llm_endpoints: [ep('epT7', 'mock-reformboss-t7', mockA)],
      team_models: { dev: { endpointId: 'epT7', model: 't7-primary' } },
      llm_model_health: {},
    });
    const { callLLMSmart } = await import('../llm.js');
    const text = await callLLMSmart('بگو سلام', {
      team: 'dev',
      timeoutMs: 15000,
      maxTokens: 20,
    });
    assert.equal(text, 'ok-t7');
    assert.deepEqual(
      mockA.requests.map((r) => r.model),
      ['t7-primary', 'glm-5.3-flash'],
    );
  });

  it('سناریو تکمیلی: امبدینگ هم fallback دارد (429 مدل اصلی → مدل جایگزین)', async () => {
    mockA.requests.length = 0;
    mockA.embRoutes = {
      't8-emb-primary': { status: 429, text: 'quota exhausted' },
      'text-embedding-3-small': { status: 200, text: 'ok', dim: 1536 },
    };
    await seedSettings({
      llm_endpoints: [ep('epT8', 'mock-reformboss-t8', mockA)],
      llm_embedding_model: { endpointId: 'epT8', model: 't8-emb-primary' },
      llm_model_health: {},
    });
    const { getEmbeddingSmart } = await import('../llm.js');
    const res = await getEmbeddingSmart('متن تستی برای امبدینگ', 15000);
    assert.equal(res.embedding.length, 1536);
    assert.equal(res.model, 'text-embedding-3-small');
    const tried = mockA.requests
      .filter((r) => r.path === '/embeddings')
      .map((r) => r.model);
    assert.deepEqual(tried, ['t8-emb-primary', 'text-embedding-3-small']);
  });

  it('سناریو تکمیلی: مدل صریح بدون team/default نادیده گرفته نمی‌شود', async () => {
    mockA.requests.length = 0;
    mockA.chatRoutes = {
      'explicit-wanted-model': { status: 200, text: 'ok-explicit' },
    };
    await seedSettings({
      llm_endpoints: [ep('epX9', 'mock-reformboss-x9', mockA)],
      team_models: {},
      llm_default_model: null,
      llm_model_health: {},
    });
    const { callLLMSmart } = await import('../llm.js');
    // نه team، نه default: فقط مدل صریح
    const text = await callLLMSmart('بگو سلام', {
      model: 'explicit-wanted-model',
      timeoutMs: 15000,
      maxTokens: 20,
    });
    assert.equal(text, 'ok-explicit');
    assert.ok(
      mockA.requests.some((r) => r.model === 'explicit-wanted-model'),
      'مدل صریح باید دقیقاً همان مدلی باشد که درخواست می‌شود',
    );
  });
});
