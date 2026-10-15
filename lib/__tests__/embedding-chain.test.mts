/**
 * lib/__tests__/embedding-chain.test.mts: تست زنجیره‌ی هوشمند fallback امبدینگ.
 *
 * اجرا: npx tsx --test lib/__tests__/embedding-chain.test.mts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  buildEmbeddingChain,
  EMBEDDING_FALLBACK_MODELS,
  EXPECTED_EMBEDDING_DIM,
  type LLMEndpoint,
} from '../llm-endpoints.js';
import { tryEmbeddingCandidate } from '../rag.js';

function ep(id: string, name: string, apiKey = 'key'): LLMEndpoint {
  return { id, name, baseUrl: `https://api.${id}.example/v1`, apiKey };
}

describe('buildEmbeddingChain', () => {
  it('مدل اصلی روی endpoint اصلی اول است، بعد مدل‌های خوب همان API، بعد API بعدی', () => {
    const primary = { endpointId: 'ep1', model: 'models/gemini-embedding-001' };
    const chain = buildEmbeddingChain(primary, [ep('ep1', 'gemini'), ep('ep2', 'reformboss')]);
    // ep1: مدل اصلی + ۲ جایگزین = ۳، بعد ep2: همان مدل اصلی + ۲ جایگزین = ۳
    assert.equal(chain.length, 6);
    assert.equal(chain[0].model, 'models/gemini-embedding-001');
    assert.equal(chain[0].endpointId, 'ep1');
    assert.deepEqual(
      chain.slice(0, 3).map((c) => c.model),
      ['models/gemini-embedding-001', ...EMBEDDING_FALLBACK_MODELS],
    );
    assert.equal(chain[3].endpointId, 'ep2');
    assert.equal(chain[3].model, 'models/gemini-embedding-001'); // سهمیه‌ی تازه روی API بعدی
    assert.deepEqual(
      chain.slice(3, 6).map((c) => c.model),
      ['models/gemini-embedding-001', ...EMBEDDING_FALLBACK_MODELS],
    );
  });

  it('endpoint بدون کلید نادیده گرفته می‌شود', () => {
    const chain = buildEmbeddingChain(null, [ep('ep1', 'x', '')]);
    assert.equal(chain.length, 0);
  });

  it('ترکیب تکراری حذف می‌شود (مدل اصلی خودش در فهرست جایگزین‌ها باشد)', () => {
    const primary = { endpointId: 'ep1', model: 'text-embedding-3-small' };
    const chain = buildEmbeddingChain(primary, [ep('ep1', 'x')]);
    const models = chain.map((c) => c.model);
    assert.equal(models.length, new Set(models).size);
    assert.equal(chain[0].model, 'text-embedding-3-small');
  });

  it('بدون مدل اصلی هم زنجیره از مدل‌های خوب ساخته می‌شود', () => {
    const chain = buildEmbeddingChain(null, [ep('ep1', 'x')]);
    assert.deepEqual(
      chain.map((c) => c.model),
      EMBEDDING_FALLBACK_MODELS,
    );
  });
});

describe('tryEmbeddingCandidate', () => {
  let server: Server;
  let baseUrl = '';
  let handler: (reqBody: unknown) => { status: number; body: unknown } = () => ({
    status: 200,
    body: {},
  });

  // سرور جعلی /embeddings
  async function start() {
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const { status, body } = handler(JSON.parse(data || '{}'));
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  async function stop() {
    await new Promise<void>((r) => server.close(() => r()));
  }

  function cfg() {
    return { baseUrl, apiKey: 'k', model: 'm', endpointId: 'ep1' };
  }
  const vec = (n: number) => ({ data: [{ embedding: new Array(n).fill(0.1) }] });

  it('بردار ۱۵۳۶ بُعدی موفق است', async () => {
    await start();
    try {
      handler = () => ({ status: 200, body: vec(EXPECTED_EMBEDDING_DIM) });
      const out = await tryEmbeddingCandidate(cfg(), 'سلام');
      assert.equal(out.ok, true);
      if (out.ok) assert.equal(out.embedding.length, 1536);
    } finally {
      await stop();
    }
  });

  it('بُعد نامعتبر به کاندیدای بعدی می‌رود', async () => {
    await start();
    try {
      handler = () => ({ status: 200, body: vec(768) });
      const out = await tryEmbeddingCandidate(cfg(), 'سلام');
      assert.equal(out.ok, false);
      if (!out.ok) {
        assert.equal(out.kind, 'next');
        assert.match(out.status ?? '', /بُعد نامعتبر/);
      }
    } finally {
      await stop();
    }
  });

  it('۴۲۹ و ۴۰۴ و ۵۰۰ به کاندیدای بعدی می‌روند', async () => {
    await start();
    try {
      for (const status of [429, 404, 500]) {
        handler = () => ({ status, body: { error: { message: 'x' } } });
        const out = await tryEmbeddingCandidate(cfg(), 'سلام');
        assert.equal(out.ok, false);
        if (!out.ok) assert.equal(out.kind, 'next', `status ${status}`);
      }
    } finally {
      await stop();
    }
  });

  it('۴۰۱ کل endpoint را رد می‌کند', async () => {
    await start();
    try {
      handler = () => ({ status: 401, body: { error: { message: 'bad key' } } });
      const out = await tryEmbeddingCandidate(cfg(), 'سلام');
      assert.equal(out.ok, false);
      if (!out.ok) assert.equal(out.kind, 'skip-endpoint');
    } finally {
      await stop();
    }
  });

  it('پاسخ خالی به کاندیدای بعدی می‌رود', async () => {
    await start();
    try {
      handler = () => ({ status: 200, body: { data: [] } });
      const out = await tryEmbeddingCandidate(cfg(), 'سلام');
      assert.equal(out.ok, false);
      if (!out.ok) assert.equal(out.kind, 'next');
    } finally {
      await stop();
    }
  });
});
