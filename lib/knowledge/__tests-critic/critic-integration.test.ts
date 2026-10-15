/**
 * lib/knowledge/__tests-critic/critic-integration.test.ts
 *
 * تست یکپارچگی نقد←دانش (تیم ۱۸ از ۲۰).
 * اجرا: npx tsx --test lib/knowledge/__tests-critic/critic-integration.test.ts
 *
 * بدون شبکه و دیتابیس واقعی: test-hooks.mjs ایمپورت‌های '../rag' و '../api'
 * را به فیکسچرهای حافظه‌ای fixtures/ هدایت می‌کند.
 * (این دایرکتوری package.json با type:module دارد تا زنجیره‌ی ایمپورت ESM
 * بماند و هوک‌ها اثر کنند.)
 *
 * سناریوهای خواسته‌شده:
 *  ۱. شبیه‌سازی verdict ردشده و فراخوانی extractCriticKnowledge
 *  ۲. بررسی ساخته‌شدن رکورد در team_knowledge
 *  ۳. بررسی ایندکس‌شدن در knowledge_chunks (از مسیر indexKnowledge)
 *  ۴. بررسی پیداشدن با جست‌وجوی RAG
 * به‌علاوه:
 *  ۵. کامل‌بودن ساختار ۵ فیلدی دانش
 *  ۶. verdict تأییدشده → دانش «درس موفق»
 *  ۷. خطای ثبت → fail-soft بدون throw
 */

import { register } from 'node:module';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// هوک باید پیش از ایمپورت ماژول زیر تست ثبت شود.
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

beforeEach(() => {
  resetRag();
  resetApi();
});

describe('یکپارچگی نقد←دانش', () => {
  it('۱. verdict ردشده → رکورد در team_knowledge ساخته می‌شود', async () => {
    const result = await extractCriticKnowledge(TEAM, REJECTED_VERDICT, RUN_ID);

    assert.equal(result.ok, true);
    assert.ok(result.knowledgeId, 'knowledgeId باید برگردد');
    assert.ok(result.title?.includes('رد منتقد'), `عنوان باید «رد منتقد» داشته باشد: ${result.title}`);

    assert.equal(apiState.inserts.length, 1);
    const { table, record } = apiState.inserts[0];
    assert.equal(table, 'team_knowledge');
    assert.equal(record.team, TEAM);
    assert.equal(record.source, 'critic-verdict');
    assert.equal(record.title, result.title);
    assert.ok(
      String(record.content).includes(REJECTED_VERDICT.rejectedPattern),
      'الگوی مردود باید در محتوا باشد',
    );
  });

  it('۲. همان دانش در knowledge_chunks ایندکس می‌شود', async () => {
    const result = await extractCriticKnowledge(TEAM, REJECTED_VERDICT, RUN_ID);

    assert.equal(result.ok, true);
    assert.equal(ragState.indexed.length, 1);
    const item = ragState.indexed[0];
    assert.equal(item.knowledgeId, result.knowledgeId);
    assert.equal(item.team, TEAM);
    assert.equal(item.title, result.title);
    assert.ok(item.content.includes('الگوی مردود:'), 'محتوای ایندکس‌شده باید ساختار دانش را داشته باشد');
  });

  it('۳. دانش ثبت‌شده با جست‌وجوی RAG پیدا می‌شود', async () => {
    const result = await extractCriticKnowledge(TEAM, REJECTED_VERDICT, RUN_ID);
    assert.equal(result.ok, true);

    const found = await retrieveKnowledge('کلیشه سرزمین لبخندها', TEAM);
    assert.ok(found.length > 0, 'جست‌وجو باید نتیجه بدهد');
    assert.ok(
      found.includes('سرزمین لبخندها'),
      'متن بازیابی‌شده باید الگوی مردود را داشته باشد',
    );

    // جست‌وجوی نامرتبط نباید این دانش را برگرداند
    const notFound = await retrieveKnowledge('قیمت هتل پاتایا', TEAM);
    assert.equal(notFound, '');
  });

  it('۴. ساختار ۵ فیلدی دانش کامل است', async () => {
    const result = await extractCriticKnowledge(TEAM, REJECTED_VERDICT, RUN_ID);
    assert.equal(result.ok, true);

    const content = String(apiState.inserts[0].record.content);
    for (const field of ['الگوی مردود:', 'دلیل:', 'دامنه:', 'قاعده آینده:', 'شاهد:']) {
      assert.ok(content.includes(field), `فیلد «${field}» باید در محتوا باشد`);
    }
    assert.ok(content.includes('پرهیز شود'), 'قاعده آینده برای رد باید پرهیز را بگوید');
    assert.ok(content.includes(RUN_ID.slice(0, 8)), 'شاهد باید شناسه کوتاه چرخه را داشته باشد');
  });

  it('۵. verdict تأییدشده → دانش «درس موفق» ساخته می‌شود', async () => {
    const result = await extractCriticKnowledge(
      TEAM,
      { approved: true, reason: 'شعار تازه، مشخص و بدون کلیشه است.', domain: 'لحن برند و شعار' },
      RUN_ID,
    );

    assert.equal(result.ok, true);
    assert.ok(result.title?.includes('درس موفق'), `عنوان باید «درس موفق» داشته باشد: ${result.title}`);
    const content = String(apiState.inserts[0].record.content);
    assert.ok(content.includes('(ندارد؛ الگو تأیید شد)'), 'الگوی مردود برای تأیید باید خالی باشد');
    assert.ok(content.includes('تکرار شود'), 'قاعده آینده برای تأیید باید تکرار را بگوید');

    const log = criticKnowledgeLog(result);
    assert.ok(log.includes('دانش منتقد ثبت شد'), `لاگ موفق: ${log}`);
  });

  it('۶. خطای ثبت در دیتابیس → fail-soft بدون throw', async () => {
    apiState.failInsert = true;

    const result = await extractCriticKnowledge(TEAM, REJECTED_VERDICT, RUN_ID);

    assert.equal(result.ok, false);
    assert.ok(
      result.error?.includes('ثبت در team_knowledge ناموفق'),
      `پیام خطا باید فارسی و مشخص باشد: ${result.error}`,
    );
    assert.equal(result.knowledgeId, undefined);
    // ایندکس نباید صدا زده شده باشد چون رکوردی ساخته نشد
    assert.equal(ragState.indexed.length, 0);

    const log = criticKnowledgeLog(result);
    assert.ok(log.includes('ثبت دانش منتقد ناموفق بود'), `لاگ ناموفق: ${log}`);
  });
});
