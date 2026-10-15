/**
 * تست خط لوله دانش (lib/knowledge-pipeline.ts) ـ تیم ۵.
 * اجرا: node --test team5-pipeline.test.ts (از دایرکتوری tests/)
 */

import { register } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

register('./team5/resolve-hook.mjs', import.meta.url);

let fetchSourceContent, extractKnowledgePoints, cleanHtmlToText, llmState, resetLlm;

before(async () => {
  const pipeline = await import('../knowledge-pipeline.ts');
  fetchSourceContent = pipeline.fetchSourceContent;
  extractKnowledgePoints = pipeline.extractKnowledgePoints;
  cleanHtmlToText = pipeline.cleanHtmlToText;
  const fakeLlm = await import('./team5/fake-llm.mjs');
  llmState = fakeLlm.llmState;
  resetLlm = fakeLlm.resetLlm;
  resetLlm();
});

const FA_HTML = `<!DOCTYPE html><html lang="fa" dir="rtl"><head><title>راهنمای سئوی فنی ۲۰۲۶</title><style>.x{color:red}</style><script>console.log('x');</script></head><body><nav>خانه | درباره | تماس</nav><article><h1>راهنمای سئوی فنی</h1><p>سرعت صفحه یکی از مهم‌ترین سیگنال‌های رتبه‌بندی گوگل است. بر اساس داده‌های منتشرشده، بهبود زمان بارگذاری از ۴ ثانیه به ۲ ثانیه می‌تواند نرخ پرش را تا ۳۰ درصد کاهش دهد.</p><p>اشتباه رایج: استفاده از تصاویر بدون فشرده‌سازی در بالای صفحه. قانون اجرایی: همه تصاویر بالای تاشدنی باید WebP باشند و حجم هر کدام زیر ۱۰۰ کیلوبایت بماند.</p></article><footer>کپی‌رایت ۲۰۲۶</footer></body></html>`;

function startFaServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/empty') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body></body></html>');
        return;
      }
      if (req.url === '/notfound') {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('یافت نشد');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FA_HTML);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const FA_TEXT_SAMPLE = `سرعت صفحه یکی از مهم‌ترین سیگنال‌های رتبه‌بندی گوگل است. بر اساس
داده‌های منتشرشده در سال ۲۰۲۶، بهبود زمان بارگذاری صفحه از چهار ثانیه به دو ثانیه
می‌تواند نرخ پرش کاربران را تا سی درصد کاهش دهد و این اثر مستقیم روی درآمد دارد.
اشتباه رایج تیم‌های فنی این است که تصاویر بالای صفحه را بدون فشرده‌سازی منتشر
می‌کنند. قانون اجرایی پیشنهادی: همه تصاویر بالای تاشدنی باید با فرمت WebP باشند
و حجم هر تصویر از صد کیلوبایت بیشتر نشود. همچنین استفاده از lazy loading برای
تصاویر پایین صفحه، مصرف پهنای باند اولیه را به شکل محسوسی کم می‌کند و تجربه کاربر
موبایل را بهتر می‌کند. این نکات برای تیم سئو مستقیم قابل اجراست.`;

const EIGHT_ITEMS = Array.from({ length: 8 }, (_, i) => ({
  title: `نکته شماره ${i + 1}`,
  point: `این نکته شماره ${i + 1} است و یک ادعای مشخص درباره سئو دارد.`,
  why_matters: 'چون به تیم سئو کمک می‌کند تصمیم بهتری بگیرد.',
  quote: `جمله عینی شماره ${i + 1} از متن منبع.`,
}));

test('fetch: صفحه معتبر فارسی با موفقیت خوانده و تمیز می‌شود', async () => {
  const { server, port } = await startFaServer();
  try {
    const result = await fetchSourceContent(`http://127.0.0.1:${port}/guide`);
    assert.equal(result.ok, true);
    assert.equal(result.fromCache, false);
    assert.equal(result.error, undefined);
    assert.ok(result.title && result.title.includes('راهنمای سئوی فنی'));
    assert.ok(result.text.includes('سرعت صفحه'));
    assert.ok(!result.text.includes('console.log'));
    assert.ok(!result.text.includes('خانه | درباره'));
    assert.ok(!result.text.includes('کپی‌رایت'));
    assert.ok(!result.text.includes('—'));
  } finally {
    server.close();
  }
});

test('fetch: نشانی بدشکل خطا می‌دهد ولی throw نمی‌کند', async () => {
  const result = await fetchSourceContent('not-a-url-at-all');
  assert.equal(result.ok, false);
  assert.ok(result.error && result.error.length > 0);
  assert.equal(result.text, '');
});

test('fetch: پروتکل غیر http/https رد می‌شود', async () => {
  const result = await fetchSourceContent('ftp://example.com/file.txt');
  assert.equal(result.ok, false);
  assert.ok(result.error && result.error.includes('http'));
});

test('fetch: هاست ناموجود fail-soft است', async () => {
  const result = await fetchSourceContent('http://127.0.0.1:9/unreachable');
  assert.equal(result.ok, false);
  assert.ok(result.error && result.error.length > 0);
});

test('fetch: پاسخ ۴۰۴ خطا برمی‌گرداند', async () => {
  const { server, port } = await startFaServer();
  try {
    const result = await fetchSourceContent(`http://127.0.0.1:${port}/notfound`);
    assert.equal(result.ok, false);
    assert.ok(result.error && result.error.includes('404'));
  } finally {
    server.close();
  }
});

test('fetch: صفحه خالی پس از تمیزسازی رد می‌شود', async () => {
  const { server, port } = await startFaServer();
  try {
    const result = await fetchSourceContent(`http://127.0.0.1:${port}/empty`);
    assert.equal(result.ok, false);
  } finally {
    server.close();
  }
});

test('cleanHtmlToText: تگ‌ها حذف و متن فارسی حفظ می‌شود', () => {
  const text = cleanHtmlToText(
    '<html><body><nav>منو</nav><p>متن اصلی صفحه</p><script>var x=1;</script></body></html>',
  );
  assert.ok(text.includes('متن اصلی صفحه'));
  assert.ok(!text.includes('var x=1'));
  assert.ok(!text.includes('منو'));
});

test('cleanHtmlToText: خط تیره بلند جایگزین می‌شود', () => {
  const text = cleanHtmlToText('<p>سرعت — مهم است</p>');
  assert.ok(!text.includes('—'));
  assert.ok(text.includes('سرعت'));
});

test('extract: روی متن فارسی ساختار نکته‌ها درست است', async () => {
  resetLlm();
  llmState.impl = async () => EIGHT_ITEMS.slice(0, 3);
  const points = await extractKnowledgePoints(FA_TEXT_SAMPLE, 'بهینه‌سازی فنی و محتوایی سایت برای گوگل', {
    teamFa: 'سئو',
    sourceName: 'وبلاگ نمونه',
    sourceUrl: 'http://127.0.0.1/guide',
    maxPoints: 3,
  });
  assert.equal(points.length, 3);
  for (const p of points) {
    assert.ok(p.title.length > 0);
    assert.ok(p.point.length > 0);
    assert.ok(p.why_matters.length > 0);
  }
});

test('extract: متن خیلی کوتاه بدون صدا زدن LLM آرایه خالی می‌دهد', async () => {
  resetLlm();
  let called = false;
  llmState.impl = async () => {
    called = true;
    return EIGHT_ITEMS;
  };
  const points = await extractKnowledgePoints('خیلی کوتاه', 'مأموریت تیم', { maxPoints: 5 });
  assert.deepEqual(points, []);
  assert.equal(called, false);
});

test('extract: سقف ۵ نکته رعایت می‌شود', async () => {
  resetLlm();
  llmState.impl = async () => EIGHT_ITEMS;
  const points = await extractKnowledgePoints(FA_TEXT_SAMPLE, 'مأموریت تیم سئو', { maxPoints: 5 });
  assert.equal(points.length, 5);
});

test('extract: سقف کمتر از ۵ هم کار می‌کند', async () => {
  resetLlm();
  llmState.impl = async () => EIGHT_ITEMS;
  const points = await extractKnowledgePoints(FA_TEXT_SAMPLE, 'مأموریت تیم', { maxPoints: 2 });
  assert.equal(points.length, 2);
});

test('extract: آیتم‌های ناقص خروجی LLM فیلتر می‌شوند', async () => {
  resetLlm();
  llmState.impl = async () => [
    { title: 'نکته خوب', point: 'متن نکته', why_matters: 'دلیل اهمیت' },
    { title: '', point: 'بدون عنوان', why_matters: 'x' },
    { title: 'بدون متن', point: '', why_matters: 'x' },
    null,
    'رشته نامعتبر',
  ];
  const points = await extractKnowledgePoints(FA_TEXT_SAMPLE, 'مأموریت تیم', { maxPoints: 5 });
  assert.equal(points.length, 1);
  assert.equal(points[0].title, 'نکته خوب');
});

test('extract: خطای LLM آرایه خالی برمی‌گرداند، نه throw', async () => {
  resetLlm();
  llmState.impl = async () => {
    throw new Error('سهمیه تمام شد');
  };
  const points = await extractKnowledgePoints(FA_TEXT_SAMPLE, 'مأموریت تیم', { maxPoints: 5 });
  assert.deepEqual(points, []);
});

test('extract: خروجی غیرآرایه LLM آرایه خالی می‌دهد', async () => {
  resetLlm();
  llmState.impl = async () => ({ not: 'an array' });
  const points = await extractKnowledgePoints(FA_TEXT_SAMPLE, 'مأموریت تیم', { maxPoints: 5 });
  assert.deepEqual(points, []);
});
