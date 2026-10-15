/**
 * کرون بازبینی خودکار دانش تایلندگرد.
 *
 * هر روز یک بار اجرا می‌شود (ورک‌فلو knowledge-review.yml):
 *  ۱. همه‌ی ۱۵ تیم را می‌گردد؛
 *  ۲. دانش‌های منقضی (expires_at گذشته) را به وضعیت 'archived' می‌برد؛
 *  ۳. دانش‌های قدیمیِ نیازمند بازبینی را 'stale' پرچم می‌زند
 *     (پیش‌فرض ۳۰ روز؛ درس‌های منتقد ۱۸۰ روز).
 *
 * کاملاً idempotent است: فقط ردیف‌هایی که وضعیتشان نادرست است به‌روز
 * می‌شوند، پس اجرای دوباره هیچ تغییری ایجاد نمی‌کند و خطا نمی‌دهد.
 *
 * اجرا: npx tsx worker/knowledge-review.ts
 * نیازمند: SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY در env
 */
import { getSupabase } from '../lib/api';
import { TEAMS } from '../lib/types';

/** آستانه‌ی بازبینی (روز) به تفکیک منشأ دانش؛ بقیه از پیش‌فرض استفاده می‌کنند. */
const REVIEW_DAYS_BY_ORIGIN: Record<string, number> = {
  'critic-lesson': 180,
};
const DEFAULT_REVIEW_DAYS = 30;

interface TeamReport {
  team: string;
  archived: number;
  stale: number;
}

async function main(): Promise<void> {
  const sb = getSupabase();
  const nowIso = new Date().toISOString();
  const reports: TeamReport[] = [];

  for (const team of TEAMS) {
    const report: TeamReport = { team, archived: 0, stale: 0 };

    // ۱) آرشیو دانش‌های منقضی
    const { data: archivedRows, error: archErr } = await sb
      .from('team_knowledge')
      .update({ freshness_status: 'archived', updated_at: nowIso })
      .eq('team', team)
      .neq('freshness_status', 'archived')
      .not('expires_at', 'is', null)
      .lte('expires_at', nowIso)
      .select('id');
    if (archErr) {
      console.error(`[knowledge-review] archive failed for ${team}: ${archErr.message}`);
    } else {
      report.archived = archivedRows?.length ?? 0;
    }

    // ۲) پرچم نیازمند بازبینی؛ فقط روی 'fresh' و غیرمنقضی
    const markStale = async (origin: string | null, days: number): Promise<number> => {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      let q = sb
        .from('team_knowledge')
        .update({ freshness_status: 'stale', updated_at: nowIso })
        .eq('team', team)
        .eq('freshness_status', 'fresh')
        .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
        .or(
          `and(extracted_at.not.is.null,extracted_at.lt.${cutoff}),` +
            `and(extracted_at.is.null,created_at.lt.${cutoff})`,
        )
        .select('id');
      if (origin) q = q.eq('origin', origin);
      else q = q.neq('origin', 'critic-lesson');
      const { data, error } = await q;
      if (error) {
        console.error(
          `[knowledge-review] stale-flag failed for ${team} (origin=${origin ?? 'other'}): ${error.message}`,
        );
        return 0;
      }
      return data?.length ?? 0;
    };

    report.stale += await markStale('critic-lesson', REVIEW_DAYS_BY_ORIGIN['critic-lesson']);
    report.stale += await markStale(null, DEFAULT_REVIEW_DAYS);

    reports.push(report);
    if (report.archived > 0 || report.stale > 0) {
      console.log(
        `[knowledge-review] ${team}: ${report.archived} آرشیو شد، ${report.stale} نیازمند بازبینی`,
      );
    }
  }

  const totalArchived = reports.reduce((s, r) => s + r.archived, 0);
  const totalStale = reports.reduce((s, r) => s + r.stale, 0);
  console.log(
    `[knowledge-review] تمام شد: ${totalArchived} آرشیو، ${totalStale} نیازمند بازبینی در ${TEAMS.length} تیم`,
  );
}

main().catch((err) => {
  console.error('[knowledge-review] fatal:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
