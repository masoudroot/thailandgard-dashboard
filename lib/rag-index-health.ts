/**
 * lib/rag-index-health.ts: سلامت مسیر ایندکس دانش (تیم ۳، رفع ریشه‌ای مشکل ۳).
 *
 * زمینه: ۱۳۵ ران با صفر دانش ایندکس‌شده و هیچ‌کس نفهمید، چون همه‌ی مسیرهای
 * فراخوانی indexKnowledge خطا را بی‌صدا می‌بلعیدند (catch خالی در
 * lib/knowledge.ts و lib/knowledge-subagent.ts؛ warning فقط در پاسخ JSON
 * روت‌های API). از این به بعد هر نتیجه‌ی ایندکس — موفق یا ناموفق — از این
 * ماژول رد می‌شود:
 *
 *  ۱. لاگ ساخت‌یافته (JSON یک‌خطی) همیشه، حتی اگر دیتابیس در دسترس نباشد؛
 *  ۲. شمارنده‌ی اتمیک در دیتابیس (جدول rag_index_health + رویداد در
 *     rag_index_events + وضعیت روی ردیف team_knowledge) از طریق تابع
 *     record_rag_index_outcome؛
 *  ۳. اگر خطاهای پیاپی به آستانه رسید (پیش‌فرض ۵، قابل تنظیم با
 *     settings «rag_index_alert_threshold»)، هشدار دوگانه می‌رود
 *     (تلگرام + پنل، از lib/notify.ts) به‌علاوه‌ی لاگ برجسته، با cooldown
 *     ۶ ساعته تا اسپم نشود.
 *
 * خود این ماژول هرگز throw نمی‌کند: ردیابی سلامت نباید مسیر اصلی را بشکند.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './api';
import { getSetting } from './settings';
import { notifyTeamReport } from './notify';

/** دامنه‌ی شمارنده‌ی سلامت (تک‌ردیف سراسری). */
export const RAG_INDEX_HEALTH_SCOPE = 'global';
/** آستانه‌ی پیش‌فرض هشدار: چند خطای پیاپی. */
export const INDEX_ALERT_THRESHOLD_DEFAULT = 5;
/** کلید settings برای بازنویسی آستانه. */
export const SETTINGS_KEY_INDEX_ALERT_THRESHOLD = 'rag_index_alert_threshold';
/** فاصله‌ی حداقل بین دو هشدار (ساعت) تا تلگرام اسپم نشود. */
export const INDEX_ALERT_COOLDOWN_HOURS = 6;

export interface IndexOutcomeInput {
  /** شناسه‌ی دانش (اختیاری؛ اگر بود وضعیت روی ردیف team_knowledge هم می‌نشیند). */
  knowledgeId?: string;
  team?: string;
  ok: boolean;
  /** پیام خطا (فقط وقتی ok=false)؛ حداکثر ۵۰۰ کاراکتر نگه داشته می‌شود. */
  error?: string;
  /** کدام مسیر فراخوانی: tryIndexKnowledge | knowledge-subagent | critic-knowledge | ... */
  source?: string;
}

/**
 * وابستگی‌های قابل تزریق (فقط برای تست؛ در پروداکشن همیشه پیش‌فرض‌ها).
 * client: کلاینت سوپابیس؛ notify: ارسال هشدار؛ log/errorLog: خروجی لاگ.
 */
export interface ReportIndexDeps {
  client?: SupabaseClient;
  notify?: typeof notifyTeamReport;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
  /** بازنویسی آستانه‌ی هشدار در تست (وگرنه از settings خوانده می‌شود). */
  threshold?: number;
}

export interface IndexHealthRow {
  consecutive_failures: number;
  total_failures: number;
  total_successes: number;
  alert_sent_at: string | null;
}

/** یک خط لاگ ساخت‌یافته‌ی JSON برای هر نتیجه‌ی ایندکس. */
export function formatIndexLogLine(input: {
  ok: boolean;
  knowledgeId?: string;
  team?: string;
  source?: string;
  error?: string;
}): string {
  return JSON.stringify({
    tag: 'rag-index',
    outcome: input.ok ? 'indexed' : 'failed',
    knowledge_id: input.knowledgeId ?? null,
    team: input.team ?? null,
    source: input.source ?? null,
    ...(input.ok ? {} : { error: (input.error ?? 'خطای نامشخص').slice(0, 500) }),
    at: new Date().toISOString(),
  });
}

/**
 * تصمیم خالص هشدار: آیا با این تعداد خطای پیاپی باید هشدار داد؟
 * - به آستانه رسیده باشیم؛
 * - و از آخرین هشدار حداقل cooldown گذشته باشد (یا هیچ هشداری نرفته باشد).
 */
export function shouldSendIndexAlert(args: {
  consecutiveFailures: number;
  threshold: number;
  alertSentAt: string | null;
  now?: Date;
}): boolean {
  const { consecutiveFailures, threshold, alertSentAt } = args;
  const now = args.now ?? new Date();
  if (consecutiveFailures < threshold) return false;
  if (!alertSentAt) return true;
  const last = new Date(alertSentAt).getTime();
  if (Number.isNaN(last)) return true;
  const cooldownMs = INDEX_ALERT_COOLDOWN_HOURS * 3_600_000;
  return now.getTime() - last >= cooldownMs;
}

/** متن فارسی هشدار تلگرام/پنل. */
export function formatIndexAlertMessage(args: {
  consecutiveFailures: number;
  threshold: number;
  lastError: string;
}): string {
  return [
    'هشدار سلامت ایندکس دانش',
    `ایندکس معنایی دانش ${args.consecutiveFailures} بار پیاپی شکست خورد (آستانه: ${args.threshold}).`,
    'جست‌وجوی معنایی تیم‌ها در حال کهنه شدن است؛ دانش‌های تازه قابل بازیابی نیستند.',
    `آخرین خطا: ${(args.lastError || 'نامشخص').slice(0, 300)}`,
    'مسیر بررسی: تنظیمات ← مدل امبدینگ، سپس ری‌ایندکس دستی.',
  ].join('\n');
}

/** قاب برجسته‌ی لاگ برای هشدار (در میان لاگ‌های عادی گم نشود). */
export function formatIndexAlertBanner(message: string): string {
  const bar = '━'.repeat(60);
  return `\n${bar}\n[rag-index] ALERT\n${message}\n${bar}`;
}

async function resolveAlertThreshold(deps: ReportIndexDeps): Promise<number> {
  if (typeof deps.threshold === 'number' && deps.threshold > 0) return deps.threshold;
  try {
    const v = await getSetting<number>(SETTINGS_KEY_INDEX_ALERT_THRESHOLD, INDEX_ALERT_THRESHOLD_DEFAULT);
    return typeof v === 'number' && v > 0 ? Math.floor(v) : INDEX_ALERT_THRESHOLD_DEFAULT;
  } catch {
    return INDEX_ALERT_THRESHOLD_DEFAULT;
  }
}

/**
 * ثبت یک نتیجه‌ی ایندکس دانش. هرگز throw نمی‌کند.
 *
 * ترتیب: اول لاگ ساخت‌یافته (همیشه)، بعد ثبت اتمیک در دیتابیس، بعد —
 * اگر لازم بود — هشدار آستانه.
 */
export async function reportIndexOutcome(
  input: IndexOutcomeInput,
  deps: ReportIndexDeps = {},
): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorLog = deps.errorLog ?? ((line: string) => console.error(line));

  const cleanError = (input.error ?? '').trim().slice(0, 500);

  // ۱. لاگ ساخت‌یافته: پیش از هر چیز، حتی اگر دیتابیس مرده باشد.
  const line = formatIndexLogLine({
    ok: input.ok,
    knowledgeId: input.knowledgeId,
    team: input.team,
    source: input.source,
    error: cleanError || undefined,
  });
  if (input.ok) log(line);
  else errorLog(line);

  // ۲. ثبت اتمیک در دیتابیس.
  let health: IndexHealthRow | null = null;
  try {
    const sb = deps.client ?? getSupabase();
    const { data, error } = await sb.rpc('record_rag_index_outcome', {
      p_scope: RAG_INDEX_HEALTH_SCOPE,
      p_ok: input.ok,
      p_error: input.ok ? null : cleanError || 'خطای نامشخص',
      p_knowledge_id: input.knowledgeId ?? null,
      p_team: input.team ?? null,
      p_source: input.source ?? null,
    });
    if (error) {
      errorLog(`[rag-index] ثبت وضعیت ایندکس در دیتابیس ناموفق بود: ${error.message}`);
      return;
    }
    const row = (Array.isArray(data) ? data[0] : data) as IndexHealthRow | undefined;
    if (row) health = row;
  } catch (err) {
    errorLog(
      `[rag-index] ثبت وضعیت ایندکس در دیتابیس ناموفق بود: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // ۳. تصمیم هشدار روی خطاهای پیاپی.
  if (!input.ok && health) {
    try {
      const threshold = await resolveAlertThreshold(deps);
      const consecutive = Number(health.consecutive_failures ?? 0);
      if (
        shouldSendIndexAlert({
          consecutiveFailures: consecutive,
          threshold,
          alertSentAt: health.alert_sent_at,
        })
      ) {
        const message = formatIndexAlertMessage({
          consecutiveFailures: consecutive,
          threshold,
          lastError: cleanError || 'نامشخص',
        });
        errorLog(formatIndexAlertBanner(message));
        const notify = deps.notify ?? notifyTeamReport;
        await notify({ team: 'rag-index', message });
        // ثبت زمان هشدار تا cooldown رعایت شود؛ best-effort.
        try {
          const sb = deps.client ?? getSupabase();
          await sb
            .from('rag_index_health')
            .update({ alert_sent_at: new Date().toISOString() })
            .eq('scope', RAG_INDEX_HEALTH_SCOPE);
        } catch {
          /* نادیده: هشدار اصلی ارسال شده است */
        }
      }
    } catch (err) {
      errorLog(
        `[rag-index] تصمیم‌گیری هشدار ناموفق بود: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export interface IndexEventRow {
  knowledgeId: string | null;
  team: string | null;
  status: 'indexed' | 'failed';
  error: string | null;
  source: string | null;
  createdAt: string;
}

export interface RagIndexHealthSnapshot {
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
  alertSentAt: string | null;
  knowledgeTotal: number;
  knowledgeIndexed: number;
  knowledgeFailed: number;
  chunksTotal: number;
  recentEvents: IndexEventRow[];
}

/**
 * خواندن تصویر سلامت ایندکس برای پنل/API. null یعنی دیتابیس در دسترس نیست.
 */
export async function getRagIndexHealth(
  recentLimit = 20,
  client?: SupabaseClient,
): Promise<RagIndexHealthSnapshot | null> {
  try {
    const sb = client ?? getSupabase();

    const { data: h } = await sb
      .from('rag_index_health')
      .select(
        'consecutive_failures, total_failures, total_successes, last_error, last_error_at, last_success_at, alert_sent_at',
      )
      .eq('scope', RAG_INDEX_HEALTH_SCOPE)
      .maybeSingle();

    const { data: events } = await sb
      .from('rag_index_events')
      .select('knowledge_id, team, status, error, source, created_at')
      .order('created_at', { ascending: false })
      .limit(recentLimit);

    const { count: knowledgeTotal } = await sb
      .from('team_knowledge')
      .select('id', { count: 'exact', head: true });
    const { count: knowledgeIndexed } = await sb
      .from('team_knowledge')
      .select('id', { count: 'exact', head: true })
      .eq('index_status', 'indexed');
    const { count: knowledgeFailed } = await sb
      .from('team_knowledge')
      .select('id', { count: 'exact', head: true })
      .eq('index_status', 'failed');
    const { count: chunksTotal } = await sb
      .from('knowledge_chunks')
      .select('id', { count: 'exact', head: true });

    return {
      consecutiveFailures: Number(h?.consecutive_failures ?? 0),
      totalFailures: Number(h?.total_failures ?? 0),
      totalSuccesses: Number(h?.total_successes ?? 0),
      lastError: (h?.last_error as string | null) ?? null,
      lastErrorAt: (h?.last_error_at as string | null) ?? null,
      lastSuccessAt: (h?.last_success_at as string | null) ?? null,
      alertSentAt: (h?.alert_sent_at as string | null) ?? null,
      knowledgeTotal: knowledgeTotal ?? 0,
      knowledgeIndexed: knowledgeIndexed ?? 0,
      knowledgeFailed: knowledgeFailed ?? 0,
      chunksTotal: chunksTotal ?? 0,
      recentEvents: ((events ?? []) as Array<Record<string, unknown>>).map((e) => ({
        knowledgeId: (e.knowledge_id as string | null) ?? null,
        team: (e.team as string | null) ?? null,
        status: e.status === 'failed' ? 'failed' : 'indexed',
        error: (e.error as string | null) ?? null,
        source: (e.source as string | null) ?? null,
        createdAt: String(e.created_at ?? ''),
      })),
    };
  } catch {
    return null;
  }
}
