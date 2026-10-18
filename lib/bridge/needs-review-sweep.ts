/**
 * lib/bridge/needs-review-sweep.ts — جاروی بن‌بست needs_review.
 *
 * ریشهٔ مشکل ۲ (۶۴ پچ گیرکرده): وضعیت needs_review در حلقهٔ خودکار پل
 * (lib/bridge/propose.ts) یک بن‌بستِ پایانیِ طراحی‌شده بود — «پچ متوقف
 * می‌شود ولی چرخه نمی‌میرد». اما هیچ مصرف‌کننده‌ای برای این وضعیت وجود
 * نداشت: جاروی یتیم‌ها فقط proposed را می‌خواند، تأیید مدیر دستی ممنوع
 * است (دستور مسعود: کاملاً خودکار)، و هیچ کرونی این صف را تخلیه نمی‌کرد.
 * نتیجه: هر پچِ ردشده برای همیشه می‌ماند و صف فقط بزرگ‌تر می‌شد.
 *
 * این جارو هر اجرا (سقف NEEDS_REVIEW_SWEEP_LIMIT) پچ‌های needs_review را
 * از قدیمی‌ترین به تازه‌ترین بررسی و یکی از این سرنوشت‌های قطعی را می‌دهد:
 *  ۱. کهنه (stale): بیش از STALE_DAYS روز در needs_review مانده ← rejected.
 *     پچ کهنه یعنی یا تولیدکننده‌اش دیگر همان محتوا را نمی‌خواهد یا چرخه‌های
 *     بعدی نسخهٔ تازه‌تری ساخته‌اند؛ نگه داشتنش فقط نویز است.
 *  ۲. تکراری (duplicate): یک پچ merged با همان هشِ محتوای فایل‌ها
 *     بعد از این پچ وجود دارد ← rejected. محتوایش عملاً روی dev نشسته است.
 *  ۳. منسوخ‌شده (superseded): خطای «تداخل مرج دائمی» دارد و یک پچ merged
 *     تازه‌تر همان فایل‌ها را لمس کرده ← rejected. مرجِ دوباره‌اش محتوای
 *     تازه‌تر را لگد می‌کند؛ خطرناک است.
 *  ۴. خودترمیم (requeued): دروازهٔ کیفیت اکنون سبز است (مثلاً باگِ تولیدکننده
 *     از آن زمان فیکس شده و قانون گیت عوض شده) ← برمی‌گردد به proposed تا
 *     خط لولهٔ عادی (دروازه ← کامیت ← مرج) آن را ببلعد.
 *  ۵. در غیر این صورت: دست نخورده می‌ماند تا اجرای بعدی (با دلیل روشن در
 *     gate_errors؛ هیچ‌وقت بی‌صدا گم نمی‌شود).
 *
 * همهٔ گذارها اتمیک‌اند (UPDATE شرطی با status='needs_review')؛ دو ورکر
 * هم‌زمان نمی‌توانند یک پچ را دو بار تصمیم بگیرند. کاملاً idempotent است:
 * اجرای دوباره روی پچِ تصمیم‌گرفته‌شده هیچ کاری نمی‌کند.
 *
 * صداکننده‌ها: sweepOrphanedBridgePatches در lib/bridge/sweep.ts
 * (یعنی همان دو ورودی فعلی: تهِ تیک cycle-worker و ورکر bridge-sweep).
 */

import { createHash } from 'node:crypto';
import { getSupabase } from '../api';
import { validatePatch } from './gate';
import type { PatchFile } from '../types';

/** سقف بررسی در هر اجرا تا بودجهٔ زمانی جاب خورده نشود. */
export const NEEDS_REVIEW_SWEEP_LIMIT = 10;

/** آستانهٔ کهنگی: روز. */
export const STALE_DAYS = 7;

export interface NeedsReviewSweepResult {
  scanned: number;
  rejectedStale: number;
  rejectedDuplicate: number;
  rejectedSuperseded: number;
  requeued: number;
  left: number;
}

export interface NeedsReviewRow {
  id: string;
  team: string;
  files: PatchFile[];
  gate_errors: string[] | null;
  created_at: string;
  updated_at: string;
}

/** هش کانونیکال محتوای فایل‌ها؛ مبنای تشخیص تکراریِ دقیق. */
export function hashPatchFiles(files: PatchFile[]): string {
  const canonical = (Array.isArray(files) ? files : [])
    .map((f) => ({ path: String(f?.path ?? ''), content: String(f?.content ?? '') }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** آیا خطاها از جنس «تداخل مرج دائمی»‌اند؟ (همان isMergeConflictError در merge.ts) */
function isPermanentMergeConflict(gateErrors: string[] | null): boolean {
  if (!gateErrors || gateErrors.length === 0) return false;
  return gateErrors.some((e) => typeof e === 'string' && e.includes('تداخل مرج'));
}

export type PatchFate =
  | 'stale'
  | 'duplicate'
  | 'superseded'
  | 'requeue'
  | 'leave';

export interface MergedCandidate {
  id: string;
  team: string;
  files: PatchFile[];
  created_at: string;
}

/**
 * تصمیم خالص برای یک پچ needs_review (بدون تماس دیتابیس؛ قابل تست).
 * ترتیب اولویت: کهنگی ← تکراری ← منسوخ‌شده ← خودترمیم ← ماندن.
 */
export function decidePatchFate(
  row: NeedsReviewRow,
  newerMerged: MergedCandidate[],
  nowMs: number = Date.now(),
): PatchFate {
  const updatedMs = Date.parse(row.updated_at);
  if (!Number.isNaN(updatedMs) && updatedMs < nowMs - STALE_DAYS * 24 * 3600 * 1000) {
    return 'stale';
  }
  const myHash = hashPatchFiles(row.files);
  // تکراری: محتوای یکسان با هر پچ mergedِ اخیر (قدیمی‌تر یا تازه‌تر)؛
  // مرجِ دوباره‌اش no-op است. (فیلتر زمانی ندارد چون حتی محتوای قدیمیِ
  // مرج‌شده، مرجِ دوباره را بی‌اثر می‌کند.)
  if (newerMerged.some((m) => hashPatchFiles(m.files) === myHash)) {
    return 'duplicate';
  }
  if (isPermanentMergeConflict(row.gate_errors)) {
    const myPaths = new Set(row.files.map((f) => String(f?.path ?? '')));
    // منسوخ‌شده: فقط در برابر mergedهای تازه‌تر از خود پچ (نسخهٔ جدیدتر
    // همان فایل‌ها)؛ وگرنه ممکن است محتوای تازه را لگد بکند.
    const superseder = newerMerged.find(
      (m) =>
        m.created_at > row.created_at &&
        m.files.some((f) => myPaths.has(String(f?.path ?? ''))),
    );
    if (superseder) return 'superseded';
  }
  if (validatePatch(row.files).ok) return 'requeue';
  return 'leave';
}

function parseGateErrors(raw: unknown): string[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [raw];
    } catch {
      return [raw];
    }
  }
  return null;
}

function toRow(data: Record<string, unknown>): NeedsReviewRow {
  return {
    id: String(data.id ?? ''),
    team: String(data.team ?? ''),
    files: (Array.isArray(data.files) ? data.files : []) as PatchFile[],
    gate_errors: parseGateErrors(data.gate_errors),
    created_at: String(data.created_at ?? ''),
    updated_at: String(data.updated_at ?? ''),
  };
}

const nowIso = (): string => new Date().toISOString();

/**
 * گذار اتمیک needs_review ← وضعیت پایانی/تازه.
 * فقط وقتی موفق است که پچ هنوز needs_review باشد (ورکر دیگر آن را نبرده باشد).
 * برمی‌گرداند: true اگر این ورکر تصمیم را ثبت کرد.
 */
async function transitionPatch(
  id: string,
  fields: Record<string, string | null>,
): Promise<boolean> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('bridge_patches')
    .update({ ...fields, decided_by: 'needs-review-sweep', decided_at: nowIso(), updated_at: nowIso() })
    .eq('id', id)
    .eq('status', 'needs_review')
    .select('id')
    .maybeSingle();
  if (error) {
    console.error(`[needs-review-sweep] گذار پچ ${id} ناموفق بود:`, error.message);
    return false;
  }
  return !!data;
}

async function rejectPatch(id: string, reason: string): Promise<boolean> {
  const ok = await transitionPatch(id, { status: 'rejected', rejection_reason: reason });
  if (ok) console.log(`[needs-review-sweep] پچ ${id} rejected شد: ${reason}`);
  return ok;
}

/**
 * تازه‌ترین پچ‌های merged (سقف ۱۲۰) برای تشخیص تکراری/منسوخ‌شده.
 * فیلتر زمانی ندارد؛ decidePatchFate برای superseded خودش
 * created_at را مقایسه می‌کند.
 */
async function findNewerMerged(): Promise<
  Array<{ id: string; team: string; files: PatchFile[]; created_at: string }>
> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('bridge_patches')
    .select('id, team, files, created_at')
    .eq('status', 'merged')
    .order('created_at', { ascending: false })
    .limit(120);
  if (error) {
    console.error('[needs-review-sweep] خواندن پچ‌های merged ناموفق بود:', error.message);
    return [];
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map((d) => ({
    id: String(d.id ?? ''),
    team: String(d.team ?? ''),
    files: (Array.isArray(d.files) ? d.files : []) as PatchFile[],
    created_at: String(d.created_at ?? ''),
  }));
}

/** جاروی کامل صف needs_review؛ بهترین تلاش، بدون پرتاب خطا به بیرون. */
export async function sweepNeedsReviewPatches(): Promise<NeedsReviewSweepResult> {
  const result: NeedsReviewSweepResult = {
    scanned: 0,
    rejectedStale: 0,
    rejectedDuplicate: 0,
    rejectedSuperseded: 0,
    requeued: 0,
    left: 0,
  };
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('bridge_patches')
      .select('id, team, files, gate_errors, created_at, updated_at')
      .eq('status', 'needs_review')
      .order('updated_at', { ascending: true })
      .limit(NEEDS_REVIEW_SWEEP_LIMIT);
    if (error) {
      console.error('[needs-review-sweep] خواندن صف needs_review ناموفق بود:', error.message);
      return result;
    }
    const rows = ((data ?? []) as Array<Record<string, unknown>>).map(toRow);
    result.scanned = rows.length;
    if (rows.length === 0) return result;

    for (const row of rows) {
      try {
        const newerMerged = await findNewerMerged();
        const fate = decidePatchFate(row, newerMerged);
        switch (fate) {
          case 'stale': {
            const days = Math.round((Date.now() - Date.parse(row.updated_at)) / 86400000);
            if (await rejectPatch(row.id, `پچ بیش از ${days} روز در needs_review ماند و کهنه شد (stale)؛ تولیدکننده در چرخه‌های بعدی نسخهٔ تازه می‌سازد.`)) {
              result.rejectedStale++;
            } else {
              result.left++;
            }
            break;
          }
          case 'duplicate': {
            const dup = newerMerged.find((m) => hashPatchFiles(m.files) === hashPatchFiles(row.files));
            if (await rejectPatch(row.id, `تکراری است؛ پچ ${dup?.id ?? '?'} با همین محتوا در ${dup?.created_at ?? '?'} مرج شد (duplicate).`)) {
              result.rejectedDuplicate++;
            } else {
              result.left++;
            }
            break;
          }
          case 'superseded': {
            const myPaths = new Set(row.files.map((f) => String(f?.path ?? '')));
            const sup = newerMerged.find((m) => m.files.some((f) => myPaths.has(String(f?.path ?? ''))));
            if (await rejectPatch(row.id, `تداخل مرج دائمی و منسوخ‌شده است؛ پچ ${sup?.id ?? '?'} در ${sup?.created_at ?? '?'} همان فایل‌ها را با نسخهٔ تازه‌تر مرج کرد (superseded). مرجِ دوباره محتوای تازه را لگد می‌کند.`)) {
              result.rejectedSuperseded++;
            } else {
              result.left++;
            }
            break;
          }
          case 'requeue': {
            const ok = await transitionPatch(row.id, { status: 'proposed', gate_errors: null });
            if (ok) {
              console.log(`[needs-review-sweep] پچ ${row.id} دروازه را اکنون پاس کرد؛ به proposed برگشت.`);
              result.requeued++;
            } else {
              result.left++;
            }
            break;
          }
          case 'leave':
          default:
            result.left++;
            break;
        }
      } catch (err) {
        console.error(
          `[needs-review-sweep] بررسی پچ ${row.id} خطا داد:`,
          err instanceof Error ? err.message : err,
        );
        result.left++;
      }
    }
  } catch (err) {
    console.error(
      '[needs-review-sweep] خطای غیرمنتظره:',
      err instanceof Error ? err.message : err,
    );
  }
  console.log(
    `[needs-review-sweep] تمام شد: بررسی‌شده=${result.scanned}، کهنه=${result.rejectedStale}، تکراری=${result.rejectedDuplicate}، منسوخ=${result.rejectedSuperseded}، بازگشت به صف=${result.requeued}، مانده=${result.left}`,
  );
  return result;
}
