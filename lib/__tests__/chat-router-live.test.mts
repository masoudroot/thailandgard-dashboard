/**
 * lib/__tests__/chat-router-live.test.mts: تست زنده‌ی سرتاسری روتر هوشمند چت.
 *
 * سناریو: مدل اصلی 429 می‌دهد ← روتر باید خودکار به مدل بعدی/درگاه بعدی برود
 * و پاسخ واقعی بگیرد. با mock سرور HTTP و PostgREST جعلی، بدون نیاز به کلید واقعی.
 *
 * اجرا: npx tsx --test lib/__tests__/chat-router-live.test.mts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { startFakePostgrest, seedDb } from '../../worker/__tests__/fake-postgrest.mjs';

const repoRoot = new URL('../..', import.meta.url).pathname;

/** رفتار mock سرور: نام مدل -> {status, text} */
let routes: Record<string, { status: number; text: string }> = {};
let server: Server;
let baseUrl: string;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

async function startMockLlm(): Promise<void> {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'POST' && req.url === '/chat/completions') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const model = String(body.model || '');
      const route = routes[model] ?? { status: 404, text: 'model not found' };
      res.writeHead(route.status, { 'Content-Type': 'application/json' });
      if (route.status === 200) {
        res.end(JSON.stringify({ choices: [{ message: { content: route.text } }] }));
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
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

let fake: Awaited<ReturnType<typeof startFakePostgrest>>;

function ep(id: string, name: string) {
  return { id, name, baseUrl, apiKey: 'test-key' };
}

async function seedSettings(endpoints: unknown[], teamModels: unknown) {
  await seedDb(fake.url, {
    settings: [
      { key: 'llm_endpoints', value: endpoints },
      { key: 'team_models', value: teamModels },
      { key: 'llm_model_health', value: {} },
    ],
  });
}

before(async () => {
  await startMockLlm();
  fake = await startFakePostgrest();
  process.env.SUPABASE_URL = fake.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
});

after(async () => {
  await fake.close();
  server.close();
});

describe('روتر هوشمند چت (زنده)', () => {
  it('سناریو ۱: مدل اصلی 429 می‌دهد، مدل بعدی همان درگاه جواب می‌دهد', async () => {
    routes = {
      'dead-model-s1': { status: 429, text: 'quota exhausted' },
      'glm-5.3-flash': { status: 200, text: 'سلام از مدل جایگزین' },
    };
    await seedSettings([ep('ep1', 'mock-reformboss')], {
      dev: { endpointId: 'ep1', model: 'dead-model-s1' },
    });
    const { callLLMSmart, getLLMStats } = await import('../llm.js');
    const before_ = getLLMStats().smartReroutes;
    const text = await callLLMSmart('بگو سلام', {
      team: 'dev',
      timeoutMs: 15000,
      maxTokens: 20,
    });
    assert.equal(text, 'سلام از مدل جایگزین');
    assert.ok(
      getLLMStats().smartReroutes > before_,
      'باید به‌عنوان reroute هوشمند ثبت شود',
    );
  });

  it('سناریو ۲: همه‌ی مدل‌های درگاه اول 429، درگاه دوم جواب می‌دهد', async () => {
    routes = {
      'dead-model-s2': { status: 429, text: 'quota exhausted' },
      'glm-5.3-flash': { status: 429, text: 'quota exhausted' },
      'qwen3.8-flash': { status: 429, text: 'quota exhausted' },
      'qwen3.5-omni-flash': { status: 429, text: 'quota exhausted' },
      'deepseek-v4-flash': { status: 429, text: 'quota exhausted' },
      'kimi-k3': { status: 429, text: 'quota exhausted' },
      'gemini-3.8-flash': { status: 200, text: 'سلام از درگاه دوم' },
    };
    await seedSettings(
      [ep('epA', 'mock-reformboss'), ep('epB', 'mock-gemini-2')],
      { dev: { endpointId: 'epA', model: 'dead-model-s2' } },
    );
    const { callLLMSmart } = await import('../llm.js');
    const text = await callLLMSmart('بگو سلام', {
      team: 'dev',
      timeoutMs: 20000,
      maxTokens: 20,
    });
    assert.equal(text, 'سلام از درگاه دوم');
  });

  it('سناریو ۳: کلید نامعتبر (401) کل درگاه را رد می‌کند و به درگاه بعدی می‌رود', async () => {
    routes = {
      'dead-model-s3': { status: 401, text: 'invalid key' },
      'glm-5.3-flash': { status: 200, text: 'نباید از این مدل بیاید' },
      'gemini-3.8-flash': { status: 200, text: 'سلام از درگاه سالم' },
    };
    await seedSettings(
      [ep('epX', 'mock-reformboss'), ep('epY', 'mock-gemini-3')],
      { dev: { endpointId: 'epX', model: 'dead-model-s3' } },
    );
    const { callLLMSmart } = await import('../llm.js');
    const text = await callLLMSmart('بگو سلام', {
      team: 'dev',
      timeoutMs: 20000,
      maxTokens: 20,
    });
    // روی 401 باید بقیه‌ی مدل‌های epX رد شوند و مستقیم به epY برود
    assert.equal(text, 'سلام از درگاه سالم');
  });
});
