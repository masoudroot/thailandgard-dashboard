/**
 * جمع‌کنندهٔ روزانهٔ دادهٔ Search Console (فیدر داده، قدم صفر).
 *
 * هر روز ساعت ۶ صبح تهران (ورک‌فلو gsc-daily.yml):
 *  ۱. از Search Console API دادهٔ روزِ «۳ روز قبل» را می‌گیرد (تأخیر طبیعی GSC)
 *  ۲. بعد page → جدول page_analytics (views = clicks؛ ستون views همان clicks است)
 *  ۳. بعد query → جدول gsc_queries
 *  ۴. upsert روی (date, page_path) و (date, query)؛ idempotent است
 *
 * اجرا: npx tsx worker/gsc-daily.ts
 * نیازمند:
 *   SUPABASE_URL، SUPABASE_SERVICE_ROLE_KEY،
 *   GSC_SERVICE_ACCOUNT_JSON (محتوای base64 فایل JSON کلید service account گوگل
 *     که به پراپرتی سرچ کنسول دسترسی دارد)،
 *   GSC_SITE_URL (اختیاری؛ پیش‌فرض sc-domain:thailandgard.ir)
 *
 * نکته: GSC_SERVICE_ACCOUNT_JSON هنوز ساخته نشده است؛ تا وقتی این سکرت در
 * گیت‌هاب ست نشود، ورک‌فلو با پیام روشن خارج می‌شود (exit 0، بدون درج).
 */

import { google } from 'googleapis';
import { getSupabase } from '../lib/api';

const SITE_URL = process.env.GSC_SITE_URL ?? 'sc-domain:thailandgard.ir';
/** تأخیر دادهٔ GSC (روز)؛ روز هدف = امروز منهای این عدد. */
const GSC_LAG_DAYS = 3;
const ROW_LIMIT = 25000;

interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

function pagePathFromUrl(pageUrl: string): string {
  try {
    const u = new URL(pageUrl);
    return u.pathname + u.search || '/';
  } catch {
    return pageUrl;
  }
}

async function fetchGscRows(
  auth: unknown,
  dimension: 'page' | 'query',
  date: string,
): Promise<GscRow[]> {
  const webmasters = google.webmasters({ version: 'v3', auth: auth as never });
  const res = await webmasters.searchanalytics.query({
    siteUrl: SITE_URL,
    requestBody: {
      startDate: date,
      endDate: date,
      dimensions: [dimension],
      rowLimit: ROW_LIMIT,
      dataState: 'final',
    },
  });
  const rows = (res.data.rows ?? []) as Array<{
    keys?: string[];
    clicks?: number;
    impressions?: number;
    ctr?: number;
    position?: number;
  }>;
  return rows.map((r) => ({
    keys: r.keys ?? [],
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));
}

async function main(): Promise<void> {
  const saJsonB64 = process.env.GSC_SERVICE_ACCOUNT_JSON;
  if (!saJsonB64) {
    console.log(
      '[gsc-daily] سکرت GSC_SERVICE_ACCOUNT_JSON ست نشده است؛ ' +
        'کلید service account گوگل با دسترسی Search Console لازم است. ' +
        'بدون درج خارج می‌شود.',
    );
    return;
  }
  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(Buffer.from(saJsonB64, 'base64').toString('utf-8')) as Record<
      string,
      unknown
    >;
  } catch {
    console.error('[gsc-daily] GSC_SERVICE_ACCOUNT_JSON معتبر نیست (base64/JSON خراب).');
    process.exit(1);
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });

  const target = new Date(Date.now() - GSC_LAG_DAYS * 24 * 3600 * 1000);
  const dateStr = target.toISOString().slice(0, 10);
  console.log(`[gsc-daily] سایت: ${SITE_URL} | روز هدف: ${dateStr}`);

  const sb = getSupabase();

  // ۱) page → page_analytics
  try {
    const pageRows = await fetchGscRows(auth, 'page', dateStr);
    console.log(`[gsc-daily] ${pageRows.length} ردیف page از GSC`);
    // تجمیع بر اساس page_path (ممکن است URLهای متفاوت، path یکسان داشته باشند)
    const byPath = new Map<string, { views: number; impressions: number; posSum: number; n: number }>();
    for (const r of pageRows) {
      const p = pagePathFromUrl(r.keys[0] ?? '');
      const agg = byPath.get(p) ?? { views: 0, impressions: 0, posSum: 0, n: 0 };
      agg.views += r.clicks;
      agg.impressions += r.impressions;
      agg.posSum += r.position * r.impressions;
      agg.n += 1;
      byPath.set(p, agg);
    }
    const pagePayload: Array<{ page_path: string; views: number; clicks: number; impressions: number; avg_position: number | null; date: string }> = [];
    byPath.forEach((a, page_path) => {
      pagePayload.push({
        page_path,
        views: a.views,
        clicks: a.views,
        impressions: a.impressions,
        avg_position: a.impressions > 0 ? a.posSum / a.impressions : null,
        date: dateStr,
      });
    });
    if (pagePayload.length > 0) {
      const { error } = await sb
        .from('page_analytics')
        .upsert(pagePayload, { onConflict: 'page_path,date' });
      if (error) throw new Error(error.message);
      console.log(`[gsc-daily] ${pagePayload.length} ردیف در page_analytics ثبت شد.`);
    }
  } catch (err) {
    console.error('[gsc-daily] خطا در page:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // ۲) query → gsc_queries
  try {
    const queryRows = await fetchGscRows(auth, 'query', dateStr);
    console.log(`[gsc-daily] ${queryRows.length} ردیف query از GSC`);
    const queryPayload = queryRows.map((r) => ({
      query: r.keys[0] ?? '',
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      avg_position: r.position,
      date: dateStr,
    }));
    if (queryPayload.length > 0) {
      const { error } = await sb
        .from('gsc_queries')
        .upsert(queryPayload, { onConflict: 'query,date' });
      if (error) throw new Error(error.message);
      console.log(`[gsc-daily] ${queryPayload.length} ردیف در gsc_queries ثبت شد.`);
    }
  } catch (err) {
    console.error('[gsc-daily] خطا در query:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  console.log('[gsc-daily] تمام شد.');
}

main().catch((err) => {
  console.error('[gsc-daily] خطای غیرمنتظره:', err instanceof Error ? err.message : err);
  process.exit(1);
});
