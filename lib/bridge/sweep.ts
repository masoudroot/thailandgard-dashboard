/**
 * lib/bridge/sweep.ts — جاروی پچ‌های یتیم پل (وضعیت proposed).
 *
 * هر پچ با وضعیت proposed را از طریق جریان خودکار
 * (دروازه ← کامیت ← مرج به dev) پردازش می‌کند.
 * دستور مسعود: بدون تأیید دستی. کاملاً best-effort.
 *
 * صداکننده‌ها:
 * - worker/cycle-worker.ts (آخر هر تیک، با بودجه باقی‌مانده جاب)
 * - worker/bridge-sweep.ts (ورک‌فلو اختصاصی با بودجه کامل جاب؛ ر.ک
 *   .github/workflows/bridge-sweep.yml) — چون تایپ‌چک پیش‌مرج روی رانر
 *   موقت چند دقیقه طول می‌کشد و جاروی ته تیک معمولاً وسط مرج با تایم‌اوت
 *   ۳۰دقیقه‌ای جاب kill می‌شود و پچ در committed می‌ماند.
 *
 * در پایان هر اجرا، جاروی بن‌بست needs_review هم صدا زده می‌شود
 * (lib/bridge/needs-review-sweep.ts): پچ‌های ردشده دیگر برای همیشه
 * در needs_review نمی‌مانند؛ کهنه/تکراری/منسوخ‌شده rejected می‌شوند و
 * آن‌هایی که دروازه را اکنون پاس می‌کنند به proposed برمی‌گردند.
 */

import { getSupabase } from '../api';
import { sweepNeedsReviewPatches } from './needs-review-sweep';

/** سقف پردازش پچ‌های یتیم در هر اجرا، تا بودجه‌ی زمانی جاب خورده نشود. */
export const ORPHAN_SWEEP_LIMIT = 3;

export async function sweepOrphanedBridgePatches(): Promise<void> {
  // جاروی بن‌بست needs_review اول و همیشه اجرا می‌شود — حتی وقتی پچ proposed
  // تازه‌ای نیست (return زودهنگامِ پایین نباید آن را رد کند). بدون این، هر
  // پچ ردشده برای همیشه در needs_review می‌ماند (مشکل ۲: ۶۴ پچ گیرکرده).
  try {
    await sweepNeedsReviewPatches();
  } catch (err) {
    console.error(
      '[bridge-sweep] جاروی needs_review خطا داد:',
      err instanceof Error ? err.message : err,
    );
  }
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('bridge_patches')
      .select('id, team')
      .eq('status', 'proposed')
      .order('created_at', { ascending: true })
      .limit(ORPHAN_SWEEP_LIMIT);
    if (error || !data || data.length === 0) return;
    const { processProposedPatch } = await import('./propose');
    for (const row of data as Array<{ id: string; team: string }>) {
      try {
        const res = await processProposedPatch(row.id);
        console.log(
          `[bridge-sweep] patch ${row.id} (team ${row.team}): ` +
            (res.merged ? `merged به dev` : res.gated ? `committed ولی مرج نشد` : `needs_review`),
        );
      } catch (err) {
        console.error(
          `[bridge-sweep] patch ${row.id} خطا داد:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } catch (err) {
    console.error('[bridge-sweep] خطای غیرمنتظره:', err instanceof Error ? err.message : err);
  }
}
