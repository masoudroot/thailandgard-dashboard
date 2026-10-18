/**
 * lib/bridge/deploy-queue.ts: صف دیپلوی سیستم — ۷۰ اسلات ثابت در ۲۴ ساعت.
 *
 * دستور مسعود (۱۴۰۵/۰۷/۲۷): پچ‌های تأییدشده به‌جای مرج فوری dev به main،
 * وارد صف دیپلوی می‌شوند. هر ~۲۰.۵ دقیقه یک دیپلوی (۷۰ عدد در روز) تا
 * سقف ۱۰۰ دیپلوی روزانه ورسل هیچ‌وقت پر نشود.
 *
 * مدل:
 * - enqueueDeploy: پچ مرج‌شده به dev را با slot_time روی گرید ثابت روزانه
 *   وارد صف می‌کند (FIFO).
 * - processDeployQueue: آیتم‌های due (slot_time <= now) را به ترتیب برمی‌دارد
 *   و mergeDevIntoMainBestEffort را اجرا می‌کند.
 * - شکست: retry_count++ و بازگشت به صف با slot_time تازه؛ پس از ۳ تلاش → dead.
 *
 * گرید ثابت: نیمه‌شب UTC + ‎i * (1440/70)‎ دقیقه برای i = 0..69.
 */

import { getSupabase } from '../api';
import { mergeDevIntoMainBestEffort } from './merge';

/* ------------------------------------------------------------------ */
/* ثابت‌ها                                                              */
/* ------------------------------------------------------------------ */

/** تعداد اسلات دیپلوی در ۲۴ ساعت (دستور مسعود). */
export const DEPLOY_SLOTS_PER_DAY = 70;

/** فاصلهٔ اسلات‌ها به دقیقه: 1440 / 70 ≈ ۲۰.۵۷ */
export const SLOT_INTERVAL_MINUTES = 1440 / DEPLOY_SLOTS_PER_DAY;

/** حداکثر تلاش مجدد برای هر آیتم صف. */
export const MAX_DEPLOY_RETRIES = 3;

/* ------------------------------------------------------------------ */
/* تایپ‌ها                                                              */
/* ------------------------------------------------------------------ */

export type DeployQueueStatus = 'queued' | 'deploying' | 'deployed' | 'failed' | 'dead';

export interface DeployQueueItem {
  id: string;
  patch_id: string;
  team: string | null;
  status: DeployQueueStatus;
  queued_at: string;
  slot_time: string;
  deployed_at: string | null;
  retry_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeployQueueStats {
  /** تعداد دیپلوی‌های موفق امروز (UTC) */
  deployedToday: number;
  /** تعداد آیتم‌های در صف */
  queued: number;
  /** تعداد آیتم‌های ناموفق در انتظار تلاش مجدد */
  failed: number;
  /** تعداد آیتم‌های dead (نیاز به بررسی دستی) */
  dead: number;
  /** ظرفیت روزانه */
  capacity: number;
  /** درصد استفاده */
  usagePct: number;
}

export interface ProcessDeployQueueResult {
  processed: number;
  deployed: number;
  failed: number;
  dead: number;
  skipped: number;
  message: string;
}

/* ------------------------------------------------------------------ */
/* گرید زمانی ثابت                                                       */
/* ------------------------------------------------------------------ */

/**
 * شروع روز UTC برای یک تاریخ.
 */
function startOfUtcDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

/**
 * نزدیک‌ترین زمان گرید >= زمان داده‌شده.
 * گرید: نیمه‌شب UTC + ‎i * SLOT_INTERVAL_MINUTES‎.
 */
export function nextGridSlot(after: Date): Date {
  const dayStart = startOfUtcDay(after);
  const msSinceMidnight = after.getTime() - dayStart.getTime();
  const intervalMs = Math.round(SLOT_INTERVAL_MINUTES * 60 * 1000);
  const slotsPassed = Math.ceil(msSinceMidnight / intervalMs);
  return new Date(dayStart.getTime() + slotsPassed * intervalMs);
}

/* ------------------------------------------------------------------ */
/* عملیات صف                                                             */
/* ------------------------------------------------------------------ */

/**
 * افزودن پچ به صف دیپلوی.
 * slot_time = اولین اسلات آزاد گرید که >= now و بعد از آخرین اسلات رزروشده است.
 * اگر پچ از قبل آیتم فعال داشته باشد، همان را برمی‌گرداند (idempotent).
 */
export async function enqueueDeploy(patchId: string, team?: string): Promise<DeployQueueItem> {
  const sb = getSupabase();

  // idempotent: اگر آیتم فعال برای این پچ هست، همان را برگردان
  const { data: existing } = await sb
    .from('deploy_queue')
    .select('*')
    .eq('patch_id', patchId)
    .in('status', ['queued', 'deploying'])
    .limit(1)
    .maybeSingle();
  if (existing) return existing as DeployQueueItem;

  const now = new Date();

  // آخرین slot_time رزروشده بین آیتم‌های فعال
  const { data: last } = await sb
    .from('deploy_queue')
    .select('slot_time')
    .in('status', ['queued', 'deploying'])
    .order('slot_time', { ascending: false })
    .limit(1)
    .maybeSingle();

  let slotTime: Date;
  if (last?.slot_time) {
    const lastSlot = new Date(last.slot_time as string);
    // اسلات بعدی گرید بعد از آخرین رزرو، ولی نه قبل از now
    const afterLast = new Date(lastSlot.getTime() + 60 * 1000); // ۱ دقیقه حاشیه
    const gridAfterLast = nextGridSlot(afterLast);
    const gridAfterNow = nextGridSlot(now);
    slotTime = gridAfterLast > gridAfterNow ? gridAfterLast : gridAfterNow;
  } else {
    slotTime = nextGridSlot(now);
  }

  const { data, error } = await sb
    .from('deploy_queue')
    .insert({
      patch_id: patchId,
      team: team ?? null,
      status: 'queued',
      slot_time: slotTime.toISOString(),
    })
    .select('*')
    .single();

  if (error) throw new Error(`enqueueDeploy failed: ${error.message}`);
  console.log(
    `[deploy-queue] پچ ${patchId} در صف دیپلوی قرار گرفت (اسلات ${slotTime.toISOString()}).`,
  );
  return data as DeployQueueItem;
}

/**
 * فهرست صف برای نمایش در پنل: اول آیتم‌های فعال به ترتیب slot_time،
 * بعد تاریخچهٔ امروز.
 */
export async function getDeployQueue(limit = 100): Promise<DeployQueueItem[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('deploy_queue')
    .select('*')
    .order('slot_time', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`getDeployQueue failed: ${error.message}`);
  return (data ?? []) as DeployQueueItem[];
}

/**
 * آمار روزانه برای پنل: X/70.
 */
export async function getDeployStats(): Promise<DeployQueueStats> {
  const sb = getSupabase();
  const dayStart = startOfUtcDay(new Date()).toISOString();

  const { count: deployedToday } = await sb
    .from('deploy_queue')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'deployed')
    .gte('deployed_at', dayStart);

  const { count: queued } = await sb
    .from('deploy_queue')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'queued');

  const { count: failed } = await sb
    .from('deploy_queue')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'failed');

  const { count: dead } = await sb
    .from('deploy_queue')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'dead');

  const dep = deployedToday ?? 0;
  return {
    deployedToday: dep,
    queued: queued ?? 0,
    failed: failed ?? 0,
    dead: dead ?? 0,
    capacity: DEPLOY_SLOTS_PER_DAY,
    usagePct: Math.round((dep / DEPLOY_SLOTS_PER_DAY) * 100),
  };
}

/**
 * تلاش مجدد دستی برای آیتم failed/dead: برمی‌گردد به صف با اسلات تازه.
 */
export async function retryDeployItem(id: string): Promise<DeployQueueItem> {
  const sb = getSupabase();
  const { data: item } = await sb.from('deploy_queue').select('*').eq('id', id).maybeSingle();
  if (!item) throw new Error('آیتم صف پیدا نشد.');
  if (!['failed', 'dead'].includes(item.status as string)) {
    throw new Error('فقط آیتم‌های ناموفق قابل تلاش مجدد هستند.');
  }

  const slotTime = nextGridSlot(new Date());
  const { data, error } = await sb
    .from('deploy_queue')
    .update({
      status: 'queued',
      slot_time: slotTime.toISOString(),
      last_error: null,
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(`retryDeployItem failed: ${error.message}`);
  console.log(`[deploy-queue] تلاش مجدد دستی برای آیتم ${id} (اسلات ${slotTime.toISOString()}).`);
  return data as DeployQueueItem;
}

/* ------------------------------------------------------------------ */
/* پردازشگر صف                                                           */
/* ------------------------------------------------------------------ */

/**
 * پردازش آیتم‌های due: قدیمی‌ترین آیتم queued با slot_time <= now را
 * برمی‌دارد و mergeDevIntoMainBestEffort را اجرا می‌کند.
 *
 * - موفق: آیتم deployed؛ همهٔ آیتم‌های due دیگر هم deployed می‌شوند
 *   (چون dev→main همهٔ کامیت‌های جلوتر را یکجا می‌برد).
 * - ناموفق: retry_count++؛ اگر < MAX → بازگشت به queued با slot_time تازه،
 *   وگرنه → dead (نیاز به بررسی دستی).
 *
 * کاملاً idempotent و best-effort: خطا throw نمی‌کند.
 */
export async function processDeployQueue(): Promise<ProcessDeployQueueResult> {
  const sb = getSupabase();
  const now = new Date().toISOString();
  const result: ProcessDeployQueueResult = {
    processed: 0,
    deployed: 0,
    failed: 0,
    dead: 0,
    skipped: 0,
    message: '',
  };

  try {
    // آیتم‌های due به ترتیب FIFO (هم queued و هم failed با اسلات رسیده)
    const { data: due, error } = await sb
      .from('deploy_queue')
      .select('*')
      .in('status', ['queued', 'failed'])
      .lte('slot_time', now)
      .order('slot_time', { ascending: true })
      .order('queued_at', { ascending: true });

    if (error) {
      result.message = `خطای خواندن صف: ${error.message}`;
      return result;
    }
    if (!due || due.length === 0) {
      result.message = 'آیتم due در صف نیست.';
      return result;
    }

    // قدیمی‌ترین را به deploying می‌بریم (claim اتمیک)
    const head = due[0] as DeployQueueItem;
    const { data: claimed, error: claimErr } = await sb
      .from('deploy_queue')
      .update({ status: 'deploying' })
      .eq('id', head.id)
      .in('status', ['queued', 'failed'])
      .select('*')
      .maybeSingle();

    if (claimErr || !claimed) {
      result.skipped = 1;
      result.message = 'آیتم توسط پردازشگر دیگری برداشته شد.';
      return result;
    }

    result.processed = 1;
    console.log(`[deploy-queue] شروع دیپلوی اسلات (آیتم ${head.id}، پچ ${head.patch_id}).`);

    // اجرای واقعی دیپلوی: dev → main (ورسل خودکار دیپلوی می‌کند)
    const merge = await mergeDevIntoMainBestEffort(head.patch_id);

    if (merge.merged || merge.alreadyUpToDate) {
      // موفق: همهٔ dueها با همین دیپلوی رفتند
      const dueIds = (due as DeployQueueItem[]).map((d) => d.id);
      const deployedAt = new Date().toISOString();
      await sb
        .from('deploy_queue')
        .update({ status: 'deployed', deployed_at: deployedAt, last_error: null })
        .in('id', dueIds);
      result.deployed = dueIds.length;
      result.message = merge.merged
        ? `${dueIds.length} آیتم دیپلوی شد.`
        : 'main از قبل به‌روز بود؛ آیتم‌های due علامت خوردند.';
      console.log(`[deploy-queue] دیپلوی موفق: ${result.message}`);
    } else {
      // ناموفق
      const newRetry = (claimed.retry_count ?? 0) + 1;
      const errMsg = merge.message || 'خطای نامشخص در مرج dev به main';
      if (newRetry >= MAX_DEPLOY_RETRIES) {
        await sb
          .from('deploy_queue')
          .update({ status: 'dead', retry_count: newRetry, last_error: errMsg })
          .eq('id', head.id);
        result.dead = 1;
        result.message = `آیتم ${head.id} پس از ${newRetry} تلاش مرد (dead): ${errMsg}`;
        console.error(`[deploy-queue] ${result.message}`);
      } else {
        const slotTime = nextGridSlot(new Date());
        // ناموفق ولی تلاش باقی مانده: وضعیت failed می‌ماند (در پنل دیده می‌شود)
        // ولی با slot_time تازه در نوبت بعدی پردازشگر دوباره برداشته می‌شود.
        await sb
          .from('deploy_queue')
          .update({
            status: 'failed',
            retry_count: newRetry,
            last_error: errMsg,
            slot_time: slotTime.toISOString(),
          })
          .eq('id', head.id);
        result.failed = 1;
        result.message = `دیپلوی ناموفق (تلاش ${newRetry}/${MAX_DEPLOY_RETRIES})؛ تلاش مجدد در اسلات ${slotTime.toISOString()}: ${errMsg}`;
        console.error(`[deploy-queue] ${result.message}`);
      }
    }
  } catch (err) {
    result.message = `خطای پردازشگر: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[deploy-queue] ${result.message}`);
  }

  return result;
}
