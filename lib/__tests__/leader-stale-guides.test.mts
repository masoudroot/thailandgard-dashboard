/**
 * تست تشخیص صفحه‌های نیازمند آپدیت/بازنویسی (دستور مسعود ۱۴۰۵/۰۷/۲۴)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

interface PageRow {
  page_path: string;
  views: number;
  clicks: number;
  impressions: number;
  avg_position: number | null;
}

interface StaleGuide {
  slug: string;
  pagePath: string;
  impressions: number;
  clicks: number;
  ctr: number;
  kind: 'update' | 'rewrite';
  reason: string;
}

function detectStaleGuides(rows: PageRow[]): StaleGuide[] {
  const out: StaleGuide[] = [];
  for (const r of rows) {
    const m = /^\/guide\/([a-z0-9-]+)\/?$/.exec(r.page_path.trim());
    if (!m) continue;
    const slug = m[1];
    const impressions = r.impressions || 0;
    const clicks = r.clicks || 0;
    if (impressions < 100) continue;
    const ctr = impressions > 0 ? clicks / impressions : 0;
    if (impressions >= 500 && ctr < 0.01) {
      out.push({
        slug,
        pagePath: r.page_path,
        impressions,
        clicks,
        ctr,
        kind: 'rewrite',
        reason: `ایمپرشن بالا (${impressions}) ولی CTR خیلی پایین (${(ctr * 100).toFixed(1)}٪)؛ محتوا با نیت جست‌وجو جور نیست`,
      });
    } else if (ctr < 0.03) {
      out.push({
        slug,
        pagePath: r.page_path,
        impressions,
        clicks,
        ctr,
        kind: 'update',
        reason: `CTR پایین (${(ctr * 100).toFixed(1)}٪) با ${impressions} ایمپرشن؛ اطلاعات احتمالاً کهنه شده`,
      });
    }
  }
  return out.slice(0, 5);
}

describe('detectStaleGuides', () => {
  it('صفحهٔ کم‌ایمپرشن را نادیده می‌گیرد', () => {
    const rows: PageRow[] = [
      { page_path: '/guide/xxx', views: 10, clicks: 0, impressions: 50, avg_position: 8 },
    ];
    assert.equal(detectStaleGuides(rows).length, 0);
  });

  it('مسیر غیرراهنما را نادیده می‌گیرد', () => {
    const rows: PageRow[] = [
      { page_path: '/tours/phuket', views: 100, clicks: 1, impressions: 1000, avg_position: 5 },
    ];
    assert.equal(detectStaleGuides(rows).length, 0);
  });

  it('CTR پایین → آپدیت', () => {
    const rows: PageRow[] = [
      { page_path: '/guide/best-time', views: 50, clicks: 5, impressions: 300, avg_position: 6 },
    ];
    const out = detectStaleGuides(rows);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'update');
    assert.equal(out[0].slug, 'best-time');
  });

  it('ایمپرشن خیلی بالا + CTR خیلی پایین → بازنویسی', () => {
    const rows: PageRow[] = [
      { page_path: '/guide/visa', views: 20, clicks: 3, impressions: 800, avg_position: 4 },
    ];
    const out = detectStaleGuides(rows);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'rewrite');
    assert.equal(out[0].slug, 'visa');
  });

  it('CTR سالم → هیچ کاری', () => {
    const rows: PageRow[] = [
      { page_path: '/guide/cost', views: 200, clicks: 20, impressions: 400, avg_position: 3 },
    ];
    assert.equal(detectStaleGuides(rows).length, 0);
  });

  it('حداکثر ۵ صفحه برمی‌گرداند', () => {
    const rows: PageRow[] = Array.from({ length: 10 }, (_, i) => ({
      page_path: `/guide/g${i}`,
      views: 10,
      clicks: 1,
      impressions: 200,
      avg_position: 7 as number | null,
    }));
    assert.equal(detectStaleGuides(rows).length, 5);
  });
});
