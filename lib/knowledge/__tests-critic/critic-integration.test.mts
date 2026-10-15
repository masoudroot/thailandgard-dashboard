/**
 * تست یکپارچگی نقد←دانش (تیم ۱۸ از ۲۰).
 * اجرا: npx tsx --test lib/knowledge/__tests-critic/critic-integration.test.mts
 * بدون شبکه و دیتابیس واقعی: test-hooks.mjs ایمپورت‌های '../rag' و '../api'
 * را به فیکسچرهای حافظه‌ای fixtures/ هدایت می‌کند.
 */
import { register } from 'node:module';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

register('./test-hooks.mjs', import.meta.url);

const { extractCriticKnowledge, criticKnowledgeLog } = await import('../critic-knowledge');
const rag = await import('./fixtures/fake-rag.mjs');
const api = await import('./fixtures/fake-api.mjs');
const { ragState, resetRag, retrieveKnowledge } = rag;
const { apiState, resetApi } = api;

const TEAM = 'branding';
const RUN_ID = 'run-20261015-test';
const REJECTED_VERDICT = {
  approved: false,
  reason: 'شعار «سرزمین لبخندها» کلیشه‌ای و تکراری است؛ باید برای همیشه کنار گذاشته شود.',
  domain: 'لحن برند و شعار',
  rejectedPattern: 'کلیشه سرزمین لبخندها در شعار',
};

beforeEach(() => { resetRag(); resetApi(); });

describe('یکپارچگی نقد←دانش', () => {
  it('۱. verdict ردشده → رکورد در team_knowledge ساخته می‌شود', async () => {
    const result = await extractCriticKnowledge(TEAM, REJECTED_VERDICT, RUN_ID);
    assert.equal(result.ok, true);
    assert.ok(result.knowledgeId, 'knowledgeId باید برگردد');
    assert.ok(result.title?.includes('رد منتقد'), `عنوان: ${result.title}`);
    assert.equal(apiState.inserts.length, 1);
    const { table, record } = apiState.inserts[0];
    assert.equal(table, 'team_knowledge');
    assert.equal(record.team, TEAM);
    assert.equal(record.source, 'critic-verdict');
    assert.equal(record.title, result.title);
    assert.ok(String(record.content).includes(REJECTED_VERDICT.rejectedPattern), 'الگوی مردود در محتوا باشد');
  });

  it('۲. همان دانش در knowledge_chunks ایندکس می‌شود', async () => {
    const result = await extractCriticKnowledge(TEAM, REJECTED_VERDICT, RUN_ID);
    assert.equal(result.ok, true);
    assert.equal(ragState.indexed.length, 1);
    const item = ragState.indexed[0];
    assert.equal(item.knowledgeId, result.knowledgeId);
    assert.equal(item.team, TEAM);
    assert.equal(item.title, result.title);
    assert.ok(item.content.includes('الگوی مردود:'), 'ساختار دانش در ایندکس باشد');
  });

  it('۳. دانش ثبت‌شده با جست‌وجوی RAG پیدا می‌شود', async () => {
    const result = await extractCriticKnowledge(TEAM, REJECTED_VERDICT, RUN_ID);
    assert.equal(result.ok, true);
    const found = await retrieveKnowledge('کلیشه سرزمین لبخندها', TEAM);
    assert.ok(found.length > 0, 'جست‌وجو باید نتیجه بدهد');
    assert.ok(found.includes('سرزمین لبخندها'), 'الگوی مردود در نتیجه باشد');
    const notFound = await retrieveKnowledge('قیمت هتل پاتایا', TEAM);
    assert.equal(notFound, '');
  });

  it('۴. ساختار ۵ فیلدی دانش کامل است', async () => {
    const result = await extractCriticKnowledge(TEAM, REJECTED_VERDICT, RUN_ID);
    assert.equal(result.ok, true);
    const content = String(apiState.inserts[0].record.content);
    for (const field of ['الگوی مردود:', 'دلیل:', 'دامنه:', 'قاعده آینده:', 'شاهد:']) {
      assert.ok(content.includes(field), `فیلد «${field}» باشد`);
    }
    assert.ok(content.includes('پرهیز شود'), 'قاعده آینده پرهیز را بگوید');
    assert.ok(content.includes(RUN_ID.slice(0, 8)), 'شاهد شناسه چرخه را داشته باشد');
  });

  it('۵. verdict تأییدشده → دانش «درس موفق» ساخته می‌شود', async () => {
    const result = await extractCriticKnowledge(TEAM,
      { approved: true, reason: 'شعار تازه، مشخص و بدون کلیشه است.', domain: 'لحن برند و شعار' }, RUN_ID);
    assert.equal(result.ok, true);
    assert.ok(result.title?.includes('درس موفق'), `عنوان: ${result.title}`);
    const content = String(apiState.inserts[0].record.content);
    assert.ok(content.includes('(ندارد؛ الگو تأیید شد)'));
    assert.ok(content.includes('تکرار شود'));
    assert.ok(criticKnowledgeLog(result).includes('دانش منتقد ثبت شد'));
  });

  it('۶. خطای ثبت در دیتابیس → fail-soft بدون throw', async () => {
    apiState.failInsert = true;
    const result = await extractCriticKnowledge(TEAM, REJECTED_VERDICT, RUN_ID);
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes('ثبت در team_knowledge ناموفق'), `خطا: ${result.error}`);
    assert.equal(result.knowledgeId, undefined);
    assert.equal(ragState.indexed.length, 0);
    assert.ok(criticKnowledgeLog(result).includes('ثبت دانش منتقد ناموفق بود'));
  });
});
