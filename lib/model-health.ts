/**
 * lib/model-health.ts: ردیابی سلامت runtime مدل‌ها (ریت‌لیمیت/سهمیه/خطای درگاه).
 *
 * چرا جدول جدا و نه llm_model_health در settings؟
 * - settings یک JSON blob واحد است؛ ثبت هر خطا = خواندن-تغییر-نوشتن کل blob و
 *   با چند ورکر هم‌زمان (گیت‌هاب اکشنز) آپدیت‌ها همدیگر را له می‌کنند.
 * - کش llm_model_health در settings برای «تست دستی مدل‌ها» با TTL ۲۴ ساعته است،
 *   نه cooldown دقیقه‌ایِ ریت‌لیمیت.
 * - این جدول‌ها atomic upsert روی (endpoint_id, model) دارند؛ race ندارند.
 *
 * سیاست cooldown (دقیقه، با backoff نمایی روی خطاهای پیاپی):
 * - rate_limit_429 : پایه ۵ (سهمیه دقیقه‌ای گوگل زود آزاد می‌شود)، سقف ۶۰
 * - service_503    : پایه ۱۰، سقف ۱۲۰
 * - timeout/network: پایه ۲، سقف ۳۰
 * - auth_401/403   : پایه ۱۸۰ (کلید خراب است؛ انسان باید دخالت کند)
 * - not_found_404  : پایه ۱۴۴۰ (مدل منسوخ شده؛ ۲۴ ساعت)
 * - unknown        : پایه ۵، سقف ۳۰
 *
 * همه‌ی توابع fail-soft هستند: اگر دیتابیس در دسترس نبود، خطا لاگ می‌شود و
 * تابع با مقدار امن برمی‌گردد (isModelHealthy => سالم). ردیابی سلامت هرگز
 * نباید تماس LLM را بشکند.
 *
 * همین توابع برای embedding هم کار می‌کنند (endpointId/model از
 * llm_embedding_model می‌آید).
 */

import { getSupabase } from './api';

export type ModelErrorType =
  | 'rate_limit_429'
  | 'service_503'
  | 'timeout'
  | 'network'
  | 'auth_401'
  | 'auth_403'
  | 'not_found_404'
  | 'unknown';

interface CooldownRule {
  baseMin: number;
  capMin: number;
  fa: string;
}

/** سیاست cooldown هر نوع خطا. برای تیون کردن همین‌جا عوض کن. */
export const COOLDOWN_POLICY: Record<ModelErrorType, CooldownRule> = {
  rate_limit_429: { baseMin: 5, capMin: 60, fa: 'محدودیت نرخ/سهمیه' },
  service_503: { baseMin: 10, capMin: 120, fa: 'درگاه در دسترس نیست' },
  timeout: { baseMin: 2, capMin: 30, fa: 'تایم‌اوت' },
  network: { baseMin: 2, capMin: 30, fa: 'خطای شبکه' },
  auth_401: { baseMin: 180, capMin: 720, fa: 'کلید نامعتبر' },
  auth_403: { baseMin: 180, capMin: 720, fa: 'دسترسی رد شد' },
  not_found_404: { baseMin: 1440, capMin: 1440, fa: 'مدل منسوخ/ناموجود' },
  unknown: { baseMin: 5, capMin: 30, fa: 'خطای نامشخص' },
};

export interface ModelHealthStatus {
  healthy: boolean;
  /** توضیح فارسی وقتی سالم نیست. */
  reason?: string;
  errorType?: ModelErrorType | null;
  cooldownUntil?: string | null;
  /** چند میلی‌ثانیه تا پایان cooldown (وقتی سالم نیست). */
  retryInMs?: number;
  consecutiveFailures?: number;
  lastErrorAt?: string | null;
  lastSuccessAt?: string | null;
}

/**
 * طبقه‌بندی خطا به نوع استاندارد. ورودی می‌تواند LLMError، Error معمولی
 * یا هر چیزی باشد که از fetch/LLM برگشته است.
 */
export function classifyError(err: unknown): ModelErrorType {
  const status =
    err && typeof err === 'object' && 'status' in err
      ? (err as { status?: unknown }).status
      : undefined;
  if (status === 429) return 'rate_limit_429';
  if (status === 503) return 'service_503';
  if (status === 401) return 'auth_401';
  if (status === 403) return 'auth_403';
  if (status === 404) return 'not_found_404';

  const msg = err instanceof Error ? err.message : String(err ?? '');
  // کد HTTP داخل متن (مثل «خطای 429» از tryEmbeddingCandidate)
  const codeMatch = msg.match(/\b(429|503|401|403|404|400)\b/);
  if (codeMatch) {
    switch (codeMatch[1]) {
      case '429': return 'rate_limit_429';
      case '503': return 'service_503';
      case '401': return 'auth_401';
      case '403': return 'auth_403';
      case '404': return 'not_found_404';
      default: break;
    }
  }
  if (/429|rate.?limit|quota|resource.?exhausted|too many requests/i.test(msg))
    return 'rate_limit_429';
  if (/503|service.?unavailable|overloaded/i.test(msg)) return 'service_503';
  if (/timed? ?out|abort|تایم‌اوت/i.test(msg)) return 'timeout';
  if (/fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network/i.test(msg))
    return 'network';
  if (/401|unauthorized|invalid.?key|invalid api/i.test(msg)) return 'auth_401';
  if (/403|forbidden|permission.?denied/i.test(msg)) return 'auth_403';
  if (/404|not.?found|no longer available|deprecated/i.test(msg)) return 'not_found_404';
  return 'unknown';
}

/** کلید پایدار وقتی endpointId نداریم (پیکربندی env). */
export function endpointKey(endpointId: string | null | undefined, baseUrl?: string): string {
  if (endpointId && endpointId.trim()) return endpointId.trim();
  return `env:${(baseUrl ?? 'default').trim()}`;
}

/**
 * آیا این مدل الان قابل استفاده است؟ قبل از صدا زدن چک شود.
 * روی خطای دیتابیس، امن برمی‌گردد: سالم (تا تماس LLM نایستد).
 */
export async function isModelHealthy(
  endpointId: string,
  model: string,
): Promise<ModelHealthStatus> {
  const ep = endpointId?.trim();
  const m = model?.trim();
  if (!ep || !m) return { healthy: true };
  try {
    const { data, error } = await getSupabase()
      .from('llm_model_health')
      .select('last_error_type, last_error_at, last_success_at, consecutive_failures, cooldown_until')
      .eq('endpoint_id', ep)
      .eq('model', m)
      .maybeSingle();
    if (error || !data) return { healthy: true };
    const until = data.cooldown_until ? Date.parse(data.cooldown_until as string) : NaN;
    if (!Number.isNaN(until) && until > Date.now()) {
      const errType = (data.last_error_type as ModelErrorType | null) ?? 'unknown';
      const rule = COOLDOWN_POLICY[errType] ?? COOLDOWN_POLICY.unknown;
      return {
        healthy: false,
        reason: `مدل «${m}» به‌علت ${rule.fa} تا ${Math.ceil((until - Date.now()) / 60000)} دقیقه دیگر در استراحت است`,
        errorType: errType,
        cooldownUntil: data.cooldown_until as string,
        retryInMs: until - Date.now(),
        consecutiveFailures: (data.consecutive_failures as number) ?? 0,
        lastErrorAt: data.last_error_at as string | null,
        lastSuccessAt: data.last_success_at as string | null,
      };
    }
    return {
      healthy: true,
      consecutiveFailures: (data.consecutive_failures as number) ?? 0,
      lastErrorAt: data.last_error_at as string | null,
      lastSuccessAt: data.last_success_at as string | null,
    };
  } catch (err) {
    console.warn('[model-health] isModelHealthy failed (fail-soft):', err instanceof Error ? err.message : String(err));
    return { healthy: true };
  }
}

export interface FailureRecord {
  consecutiveFailures: number;
  cooldownUntil: string;
  cooldownMinutes: number;
}

/**
 * ثبت خطای یک مدل بعد از شکست تماس. cooldown را با backoff نمایی ست می‌کند
 * و رویداد را در تاریخچه می‌نویسد. اتمیک (تابع دیتابیس)؛ race ندارد.
 */
export async function recordModelFailure(
  endpointId: string,
  model: string,
  errorType: ModelErrorType,
  message?: string,
): Promise<FailureRecord | null> {
  const ep = endpointId?.trim();
  const m = model?.trim();
  if (!ep || !m) return null;
  const rule = COOLDOWN_POLICY[errorType] ?? COOLDOWN_POLICY.unknown;
  try {
    const { data, error } = await getSupabase().rpc('record_llm_model_failure', {
      p_endpoint_id: ep,
      p_model: m,
      p_error_type: errorType,
      p_message: (message ?? '').slice(0, 500),
      p_cooldown_minutes: rule.baseMin,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    const fails = Number(row.consecutive_failures) || 1;
    const cooldownMin = Math.min(
      rule.baseMin * Math.pow(2, Math.min(fails - 1, 5)),
      rule.capMin,
    );
    console.log(
      `[model-health] ${m}: ${rule.fa} (خطای پیاپی ${fails})؛ cooldown ${cooldownMin} دقیقه`,
    );
    return {
      consecutiveFailures: fails,
      cooldownUntil: String(row.cooldown_until),
      cooldownMinutes: cooldownMin,
    };
  } catch (err) {
    console.warn('[model-health] recordModelFailure failed (fail-soft):', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * ثبت موفقیت یک مدل. شمارنده خطاهای پیاپی را صفر و cooldown را پاک می‌کند.
 * اگر ردیفی ناسالم نباشد، no-op است (یک UPDATE ارزان).
 */
export async function recordModelSuccess(
  endpointId: string,
  model: string,
): Promise<void> {
  const ep = endpointId?.trim();
  const m = model?.trim();
  if (!ep || !m) return;
  try {
    const { error } = await getSupabase()
      .from('llm_model_health')
      .update({
        last_success_at: new Date().toISOString(),
        consecutive_failures: 0,
        cooldown_until: null,
        updated_at: new Date().toISOString(),
      })
      .eq('endpoint_id', ep)
      .eq('model', m)
      .or('consecutive_failures.gt.0,cooldown_until.not.is.null,last_error_type.not.is.null');
    if (error) throw error;
  } catch (err) {
    console.warn('[model-health] recordModelSuccess failed (fail-soft):', err instanceof Error ? err.message : String(err));
  }
}

/** پاک‌سازی دستی cooldown یک مدل (از داشبورد/مدیر). */
export async function clearModelCooldown(
  endpointId: string,
  model: string,
): Promise<void> {
  const ep = endpointId?.trim();
  const m = model?.trim();
  if (!ep || !m) return;
  try {
    const { error } = await getSupabase()
      .from('llm_model_health')
      .update({
        consecutive_failures: 0,
        cooldown_until: null,
        updated_at: new Date().toISOString(),
      })
      .eq('endpoint_id', ep)
      .eq('model', m);
    if (error) throw error;
  } catch (err) {
    console.warn('[model-health] clearModelCooldown failed (fail-soft):', err instanceof Error ? err.message : String(err));
  }
}

export interface UnhealthyModel extends ModelHealthStatus {
  endpointId: string;
  model: string;
}

/** نرمال‌سازی نام مدل برای مقایسه (مثل llm.ts: حذف models/ و حروف کوچک). */
export function normModelKey(model: string): string {
  return model.trim().replace(/^models\//i, '').toLowerCase();
}

/**
 * کلیدهای cooldown فعال برای چند درگاه، به‌صورت batch (یک کوئری).
 * خروجی: مجموعه‌ای از `endpointId::normModel` برای فیلتر کردن کاندیداها
 * هنگام ساخت مسیر (route building)؛ بدون N+1.
 */
export async function getCooldownKeys(
  endpointIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = Array.from(new Set(endpointIds.map((s) => s?.trim()).filter(Boolean)));
  if (ids.length === 0) return out;
  try {
    const { data, error } = await getSupabase()
      .from('llm_model_health')
      .select('endpoint_id, model')
      .in('endpoint_id', ids)
      .gt('cooldown_until', new Date().toISOString());
    if (error || !data) return out;
    for (const r of data as Array<{ endpoint_id: string; model: string }>) {
      out.add(`${r.endpoint_id}::${normModelKey(r.model)}`);
    }
  } catch (err) {
    console.warn('[model-health] getCooldownKeys failed (fail-soft):', err instanceof Error ? err.message : String(err));
  }
  return out;
}

/** فهرست مدل‌های الان‌ناسالم (برای داشبورد/دیباگ). */
export async function getUnhealthyModels(
  endpointId?: string,
): Promise<UnhealthyModel[]> {
  try {
    let q = getSupabase()
      .from('llm_model_health')
      .select('endpoint_id, model, last_error_type, last_error_at, last_success_at, consecutive_failures, cooldown_until')
      .gt('cooldown_until', new Date().toISOString())
      .order('cooldown_until', { ascending: true });
    if (endpointId?.trim()) q = q.eq('endpoint_id', endpointId.trim());
    const { data, error } = await q;
    if (error || !data) return [];
    return (data as Array<Record<string, unknown>>).map((r) => {
      const errType = (r.last_error_type as ModelErrorType | null) ?? 'unknown';
      const rule = COOLDOWN_POLICY[errType] ?? COOLDOWN_POLICY.unknown;
      const until = Date.parse(String(r.cooldown_until));
      return {
        endpointId: String(r.endpoint_id),
        model: String(r.model),
        healthy: false,
        reason: `به‌علت ${rule.fa} تا ${Math.ceil((until - Date.now()) / 60000)} دقیقه دیگر در استراحت`,
        errorType: errType,
        cooldownUntil: String(r.cooldown_until),
        retryInMs: until - Date.now(),
        consecutiveFailures: Number(r.consecutive_failures) || 0,
        lastErrorAt: (r.last_error_at as string) ?? null,
        lastSuccessAt: (r.last_success_at as string) ?? null,
      };
    });
  } catch (err) {
    console.warn('[model-health] getUnhealthyModels failed (fail-soft):', err instanceof Error ? err.message : String(err));
    return [];
  }
}
