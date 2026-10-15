/**
 * تست ساب‌ایجنت دانش (lib/knowledge-subagent.ts) ـ تیم ۵.
 * اجرا: node --test team5-subagent.test.ts (از دایرکتوری tests/)
 */

import { register } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

register('./team5/resolve-hook.mjs', import.meta.url);

let runKnowledgeSubagent,
  isSourceDue,
  MAX_SOURCES_PER_RUN,
  MAX_ITEMS_PER_SOURCE,
  MAX_ITEMS_PER_RUN,
  KNOWLEDGE_STAGE_LABEL,
  KNOWLEDGE_SOURCE_VALUE;

before(async () => {
  const mod = await import('../knowledge-subagent.ts');
  runKnowledgeSubagent = mod.runKnowledgeSubagent;
  isSourceDue = mod.isSourceDue;
  MAX_SOURCES_PER_RUN = mod.MAX_SOURCES_PER_RUN;
  MAX_ITEMS_PER_SOURCE = mod.MAX_ITEMS_PER_SOURCE;
  MAX_ITEMS_PER_RUN = mod.MAX_ITEMS_PER_RUN;
  KNOWLEDGE_STAGE_LABEL = mod.KNOWLEDGE_STAGE_LABEL;
  KNOWLEDGE_SOURCE_VALUE = mod.KNOWLEDGE_SOURCE_VALUE;
});

const TEAM = 'seo';

const makeSource = (o = {}) => ({
  id: 'src-1',
  team: TEAM,
  name: 'وبلاگ نمونه سئو',
  url: 'http://127.0.0.1/article',
  authorityTier: 2,
  isActive: true,
  lastFetchedAt: null,
  fetchFrequencyHours: 168,
  ...o,
});

const makeItem = (i) => ({
  title: `نکته تازه ${i}`,
  content: `متن کاربردی نکته شماره ${i} برای تیم سئو.`,
  sourceName: 'وبلاگ نمونه سئو',
  sourceUrl: 'http://127.0.0.1/article',
  authorityTier: 2,
});

const fakeDeps = (o = {}) => ({
  listSources: async () => [],
  fetchSourceText: async () => 'متن تمیزشده صفحه '.repeat(30),
  extractItems: async () => [],
  maxSimilarity: async () => null,
  isHashDuplicate: async () => false,
  saveKnowledge: async () => `kid-${Math.random().toString(36).slice(2)}`,
  markSourceChecked: async () => {},
  logHistory: async () => {},
  listExistingTitles: async () => [],
  ...o,
});

const noopProgress = async () => {};

test('قراردادها: برچسب، source و سقف‌ها', () => {
  assert.equal(KNOWLEDGE_STAGE_LABEL, 'دانش: گردآوری');
  assert.equal(KNOWLEDGE_SOURCE_VALUE, 'knowledge-subagent');
  assert.equal(MAX_SOURCES_PER_RUN, 2);
  assert.equal(MAX_ITEMS_PER_SOURCE, 3);
  assert.equal(MAX_ITEMS_PER_RUN, 5);
});

test('isSourceDue: هرگز خوانده‌نشده، قدیمی، تاریخ نامعتبر سررسیدند؛ تازه سررسید نیست', () => {
  assert.equal(isSourceDue(makeSource({ lastFetchedAt: null })), true);
  assert.equal(
    isSourceDue(makeSource({ lastFetchedAt: new Date(Date.now() - 3600e3).toISOString(), fetchFrequencyHours: 168 })),
    false,
  );
  assert.equal(
    isSourceDue(makeSource({ lastFetchedAt: new Date(Date.now() - 200 * 3600e3).toISOString(), fetchFrequencyHours: 168 })),
    true,
  );
  assert.equal(isSourceDue(makeSource({ lastFetchedAt: 'not-a-date' })), true);
  assert.equal(
    isSourceDue(makeSource({ lastFetchedAt: new Date(Date.now() - 10 * 86400e3).toISOString(), fetchFrequencyHours: 0 })),
    true,
  );
});

test('fail-soft: خطای همه‌چیز، throw نمی‌کند', async () => {
  const bad = fakeDeps({
    listSources: async () => {
      throw new Error('دیتابیس قطع است');
    },
  });
  const result = await runKnowledgeSubagent(TEAM, 'run-1', 'زمینه', async () => {
    throw new Error('progress خراب');
  }, bad);
  assert.equal(result.refreshed, false);
  assert.ok(result.skippedReason);
  assert.ok(result.summary);
  assert.equal(result.contextSnippet, null);
});

test('fail-soft: خطای فچ یک منبع، منبع بعدی را متوقف نمی‌کند', async () => {
  const checked = [];
  const deps = fakeDeps({
    listSources: async () => [
      makeSource({ id: 's1', name: 'منبع اول', url: 'http://first.example/a' }),
      makeSource({ id: 's2', name: 'منبع دوم', url: 'http://second.example/b' }),
    ],
    fetchSourceText: async (url) => {
      if (url.includes('first')) throw new Error('سایت اول خواب است');
      return 'متن تمیزشده '.repeat(30);
    },
    extractItems: async () => [makeItem(1)],
    markSourceChecked: async (id, ok) => {
      checked.push({ id, ok });
    },
  });
  const result = await runKnowledgeSubagent(TEAM, 'run-1', 'زمینه', noopProgress, deps);
  assert.equal(result.refreshed, true);
  assert.equal(result.newItems.length, 1);
  assert.deepEqual(result.sourcesChecked, ['منبع اول', 'منبع دوم']);
  assert.equal(checked.find((c) => c.id === 's1').ok, false);
});

test('fail-soft: خطای ذخیره یک نکته، بقیه را متوقف نمی‌کند', async () => {
  let calls = 0;
  const deps = fakeDeps({
    listSources: async () => [makeSource()],
    extractItems: async () => [makeItem(1), makeItem(2), makeItem(3)],
    saveKnowledge: async () => {
      calls += 1;
      if (calls === 2) throw new Error('درج ناموفق');
      return `kid-${calls}`;
    },
  });
  const result = await runKnowledgeSubagent(TEAM, 'run-1', 'زمینه', noopProgress, deps);
  assert.equal(result.refreshed, true);
  assert.equal(result.newItems.length, 2);
});

test('رد سالم: بدون منبع', async () => {
  const result = await runKnowledgeSubagent(TEAM, 'run-1', 'زمینه', noopProgress, fakeDeps());
  assert.equal(result.refreshed, false);
  assert.ok(result.skippedReason.includes('منبع'));
  assert.equal(result.llmCalls, 0);
});

test('رد سالم: همه منابع تازه‌اند (بدون فچ و LLM)', async () => {
  let fetched = false;
  const deps = fakeDeps({
    listSources: async () => [makeSource({ lastFetchedAt: new Date(Date.now() - 3600e3).toISOString() })],
    fetchSourceText: async () => {
      fetched = true;
      return 'x';
    },
  });
  const result = await runKnowledgeSubagent(TEAM, 'run-1', 'زمینه', noopProgress, deps);
  assert.equal(result.refreshed, false);
  assert.ok(result.skippedReason.includes('به‌روز'));
  assert.equal(fetched, false);
  assert.equal(result.llmCalls, 0);
});

test('چیز تازه‌ای نبود', async () => {
  const deps = fakeDeps({
    listSources: async () => [makeSource()],
    extractItems: async () => [],
  });
  const result = await runKnowledgeSubagent(TEAM, 'run-1', 'زمینه', noopProgress, deps);
  assert.equal(result.refreshed, false);
  assert.equal(result.sourcesChecked.length, 1);
  assert.ok(result.skippedReason);
});

test('مسیر موفق: ذخیره، خلاصه فوری، برچسب ثابت، ارقام فارسی', async () => {
  const reported = [];
  const deps = fakeDeps({
    listSources: async () => [makeSource()],
    extractItems: async () => [makeItem(1), makeItem(2)],
    listExistingTitles: async () => ['نکته قدیمی'],
  });
  const result = await runKnowledgeSubagent(
    TEAM,
    'run-1',
    'زمینه',
    async (t) => {
      reported.push(t);
    },
    deps,
  );
  assert.equal(result.refreshed, true);
  assert.equal(result.newItems.length, 2);
  assert.equal(result.llmCalls, 1);
  assert.equal(result.skippedReason, null);
  assert.ok(result.contextSnippet.includes('یافته‌های تازه دانش این چرخه'));
  assert.ok(reported.includes('دانش: گردآوری'));
  assert.match(result.summary, /[۰-۹]/);
});

test('تکراری‌زدایی: هش تکراری ذخیره نمی‌شود', async () => {
  let saved = 0;
  const deps = fakeDeps({
    listSources: async () => [makeSource()],
    extractItems: async () => [makeItem(1), makeItem(2)],
    isHashDuplicate: async () => true,
    saveKnowledge: async () => {
      saved += 1;
      return 'kid-x';
    },
  });
  const result = await runKnowledgeSubagent(TEAM, 'run-1', 'زمینه', noopProgress, deps);
  assert.equal(result.refreshed, false);
  assert.equal(saved, 0);
});

test('سقف ۵ نکته در کل نوبت', async () => {
  const deps = fakeDeps({
    listSources: async () => [makeSource({ id: 'a' }), makeSource({ id: 'b' })],
    extractItems: async () => [1, 2, 3].map(makeItem),
  });
  const result = await runKnowledgeSubagent(TEAM, 'run-1', 'زمینه', noopProgress, deps);
  assert.equal(result.newItems.length, 5);
});

test('سقف ۳ نکته برای هر منبع', async () => {
  const deps = fakeDeps({
    listSources: async () => [makeSource()],
    extractItems: async () => [1, 2, 3, 4, 5].map(makeItem),
  });
  const result = await runKnowledgeSubagent(TEAM, 'run-1', 'زمینه', noopProgress, deps);
  assert.equal(result.newItems.length, 3);
});

test('سقف ۲ منبع در هر نوبت', async () => {
  const deps = fakeDeps({
    listSources: async () =>
      ['الف', 'ب', 'ج', 'د'].map((n, i) => makeSource({ id: String(i), name: n })),
    extractItems: async () => [],
  });
  const result = await runKnowledgeSubagent(TEAM, 'run-1', 'زمینه', noopProgress, deps);
  assert.equal(result.sourcesChecked.length, 2);
});

test('حداکثر ۲ فراخوانی LLM', async () => {
  let extractCalls = 0;
  const deps = fakeDeps({
    listSources: async () => [makeSource({ id: 'a' }), makeSource({ id: 'b' }), makeSource({ id: 'c' })],
    extractItems: async () => {
      extractCalls += 1;
      return [];
    },
  });
  const result = await runKnowledgeSubagent(TEAM, 'run-1', 'زمینه', noopProgress, deps);
  assert.ok(extractCalls <= 2);
  assert.equal(result.llmCalls, extractCalls);
});
