/**
 * تست سیستم نگهداشت محتوا (دستور مسعود ۱۴۰۵/۰۷/۲۴)
 * parseRefreshTask / extractGuideBlock / replaceGuide
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---- کپی منطق برای تست ایزوله (بدون ایمپورت از content.ts که وابستگی سنگین دارد) ----

type RefreshKind = 'update' | 'rewrite';
interface RefreshTask {
  kind: RefreshKind;
  slug: string;
  reason: string;
  work: string;
  acceptance: string;
}

function parseRefreshTask(ragContext: string): RefreshTask | null {
  if (!ragContext) return null;
  const titleMatch = ragContext.match(/عنوان:\s*\[(آپدیت|بازنویسی)\][^\n]*/);
  if (!titleMatch) return null;
  const kind: RefreshKind = titleMatch[1] === 'آپدیت' ? 'update' : 'rewrite';
  const slugMatch = ragContext.match(/اسلاگ:\s*([a-z0-9-]+)/);
  if (!slugMatch) return null;
  const slug = slugMatch[1].trim();
  const reasonMatch = ragContext.match(/دلیل:\s*([^\n]+)/);
  const workMatch = ragContext.match(/کار:\s*([^\n]+)/);
  const acceptanceMatch = ragContext.match(/معیار قبولی:\s*([^\n]+)/);
  return {
    kind,
    slug,
    reason: (reasonMatch?.[1] ?? '').trim(),
    work: (workMatch?.[1] ?? '').trim(),
    acceptance: (acceptanceMatch?.[1] ?? '').trim() || 'ثبت نشده',
  };
}

function extractGuideBlock(fileContent: string, slug: string): string | null {
  const slugMarker = `slug: "${slug}"`;
  const markerIdx = fileContent.indexOf(slugMarker);
  if (markerIdx < 0) return null;
  const blockStart = fileContent.lastIndexOf('\n  {', markerIdx);
  if (blockStart < 0) return null;
  let depth = 0;
  let i = blockStart;
  let started = false;
  while (i < fileContent.length) {
    const ch = fileContent[i];
    if (ch === '{') {
      depth++;
      started = true;
    } else if (ch === '}') {
      depth--;
      if (started && depth === 0) {
        let end = i + 1;
        if (fileContent[end] === ',') end++;
        return fileContent.slice(blockStart, end);
      }
    }
    i++;
  }
  return null;
}

function replaceGuide(fileContent: string, slug: string, newGuideTs: string): string {
  const oldBlock = extractGuideBlock(fileContent, slug);
  if (!oldBlock) {
    throw new Error(`بلوک راهنمای «${slug}» در فایل پیدا نشد؛ جایگزینی ممکن نیست.`);
  }
  const idx = fileContent.indexOf(oldBlock);
  return fileContent.slice(0, idx) + newGuideTs.trim() + fileContent.slice(idx + oldBlock.length);
}

// ---- تست‌ها ----

describe('parseRefreshTask', () => {
  it('تسک [آپدیت] را با اسلاگ و دلیل استخراج می‌کند', () => {
    const ctx = [
      'کار تحویل‌شده از صف ساخت (در اولویت اجرا):',
      'عنوان: [آپدیت] راهنمای best-time-to-visit-thailand',
      'شرح: اسلاگ: best-time-to-visit-thailand',
      'دلیل: CTR پایین (۲.۱٪) با ۸۰۰ ایمپرشن؛ اطلاعات احتمالاً کهنه شده',
      'کار: اطلاعات قیمت و فصل را به‌روز کن',
      'معیار قبولی: تاریخ به‌روزرسانی عوض شده باشد',
    ].join('\n');
    const t = parseRefreshTask(ctx);
    assert.ok(t);
    assert.equal(t.kind, 'update');
    assert.equal(t.slug, 'best-time-to-visit-thailand');
    assert.ok(t.reason.includes('CTR'));
    assert.ok(t.work.includes('قیمت'));
    assert.ok(t.acceptance.includes('به‌روزرسانی'));
  });

  it('تسک [بازنویسی] را تشخیص می‌دهد', () => {
    const ctx = 'عنوان: [بازنویسی] راهنمای thailand-visa-guide\nشرح: اسلاگ: thailand-visa-guide\nدلیل: محتوا با نیت جور نیست\nکار: از نو بنویس\nمعیار قبولی: ساختار جدید';
    const t = parseRefreshTask(ctx);
    assert.ok(t);
    assert.equal(t.kind, 'rewrite');
    assert.equal(t.slug, 'thailand-visa-guide');
  });

  it('بدون مارکر، null برمی‌گرداند', () => {
    assert.equal(parseRefreshTask('عنوان: راهنمای تازه\nشرح: چیز جدید'), null);
    assert.equal(parseRefreshTask(''), null);
  });

  it('بدون اسلاگ، null برمی‌گرداند', () => {
    assert.equal(parseRefreshTask('عنوان: [آپدیت] راهنما\nشرح: بدون اسلاگ'), null);
  });
});

describe('extractGuideBlock / replaceGuide', () => {
  const file = [
    'export const GUIDES: Guide[] = [',
    '  {',
    '    slug: "guide-one",',
    '    title: "راهنمای یک",',
    '    sections: [',
    '      { heading: "بخش", paragraphs: ["متن"] },',
    '    ],',
    '  },',
    '  {',
    '    slug: "guide-two",',
    '    title: "راهنمای دو",',
    '    sections: [],',
    '  },',
    '];',
  ].join('\n');

  it('بلوک درست را استخراج می‌کند', () => {
    const block = extractGuideBlock(file, 'guide-one');
    assert.ok(block);
    assert.ok(block.includes('slug: "guide-one"'));
    assert.ok(block.includes('راهنمای یک'));
    assert.ok(!block.includes('guide-two'));
  });

  it('برای اسلاگ ناموجود null می‌دهد', () => {
    assert.equal(extractGuideBlock(file, 'nope'), null);
  });

  it('جایگزینی، فقط همان بلوک را عوض می‌کند', () => {
    const fresh = '  {\n    slug: "guide-one",\n    title: "راهنمای یک تازه",\n  },';
    const out = replaceGuide(file, 'guide-one', fresh);
    assert.ok(out.includes('راهنمای یک تازه'));
    assert.ok(out.includes('slug: "guide-two"')); // دیگری دست‌نخورده
    assert.ok(!out.includes('راهنمای یک",')); // قدیمی رفته
  });

  it('جایگزینی اسلاگ ناموجود خطا می‌دهد', () => {
    assert.throws(() => replaceGuide(file, 'nope', 'x'), /پیدا نشد/);
  });
});
