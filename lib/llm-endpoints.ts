/**
 * lib/llm-endpoints.ts: مدیریت endpointهای LLM و «مدل هر تیم» در جدول settings سوپابیس.
 *
 * دو کلید در جدول settings:
 *   - llm_endpoints: آرایه‌ی JSON از { id, name, baseUrl, apiKey }
 *   - team_models: نگاشت TeamName -> { endpointId, model }
 *
 * قانون امنیتی: کلید کامل API فقط سمت سرور خوانده می‌شود. هر خروجی‌ای که به
 * کلاینت می‌رسد ماسک‌شده است (maskApiKey).
 */

import { randomUUID } from 'node:crypto';
import { TEAMS, type TeamName } from './types';
import { getSetting, setSetting } from './settings';

export const SETTINGS_KEY_ENDPOINTS = 'llm_endpoints';
export const SETTINGS_KEY_TEAM_MODELS = 'team_models';

/** خطای ورودی کاربر (نامعتبر بودن فرم)؛ مسیر API آن را 400 می‌کند. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

/** یک endpoint کامل؛ فقط و فقط سمت سرور استفاده می‌شود. */
export interface LLMEndpoint {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
}

/** نسخه‌ی ماسک‌شده برای ارسال به کلاینت. */
export interface MaskedLLMEndpoint {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  hasKey: boolean;
}

/** مدل انتخاب‌شده برای یک تیم: روی کدام endpoint، با کدام مدل. */
export interface TeamModelEntry {
  endpointId: string;
  model: string;
}

export type TeamModelMap = Partial<Record<TeamName, TeamModelEntry>>;

/** پیکربندی نهایی یک تیم برای فراخوانی LLM (کلید کامل، سمت سرور). */
export interface ResolvedTeamLLM {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** نام فارسی هر تیم برای نمایش در تنظیمات. */
export const TEAM_FA_NAMES: Record<TeamName, string> = {
  artdir: 'راهنمای هنری',
  branding: 'برندینگ',
  content: 'محتوا',
  seo: 'سئو',
  analytics: 'تحلیل داده',
  intel: 'اطلاعات بازار',
  lead: 'لید و فروش',
  design: 'طراحی',
  seocontent: 'محتوای سئو',
  vibefarsi: 'وایب‌فارسی',
  farsiui: 'رابط فارسی',
  'design-ir': 'طراحی ایرانی',
  dev: 'توسعه',
  qa: 'کنترل کیفیت',
  inspector: 'بازرس',
};

/** ماسک کلید: sk-...abcd */
export function maskApiKey(key: string): string {
  if (!key) return 'تنظیم نشده';
  const t = key.trim();
  if (t.length <= 8) return '••••';
  return `${t.slice(0, 3)}...${t.slice(-4)}`;
}

/** آیا env سوپابیس ست است؟ اگر نه، UI باید صادقانه «متصل نیست» نشان بدهد. */
export function isSupabaseConfigured(): boolean {
  return !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

function isTeamName(value: unknown): value is TeamName {
  return typeof value === 'string' && (TEAMS as string[]).includes(value);
}

function normalizeEndpoint(raw: unknown): LLMEndpoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  const baseUrl =
    typeof r.baseUrl === 'string' ? r.baseUrl.trim().replace(/\/+$/, '') : '';
  const apiKey = typeof r.apiKey === 'string' ? r.apiKey.trim() : '';
  if (!id || !name || !baseUrl) return null;
  return { id, name, baseUrl, apiKey };
}

function toMasked(ep: LLMEndpoint): MaskedLLMEndpoint {
  return {
    id: ep.id,
    name: ep.name,
    baseUrl: ep.baseUrl,
    apiKeyMasked: maskApiKey(ep.apiKey),
    hasKey: !!ep.apiKey,
  };
}

/** خواندن همه‌ی endpointها (سمت سرور، با کلید کامل). */
export async function listEndpoints(): Promise<LLMEndpoint[]> {
  const raw = await getSetting<unknown>(SETTINGS_KEY_ENDPOINTS, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeEndpoint)
    .filter((e): e is LLMEndpoint => e !== null);
}

/** لیست ماسک‌شده برای کلاینت. */
export async function listEndpointsMasked(): Promise<MaskedLLMEndpoint[]> {
  return (await listEndpoints()).map(toMasked);
}

/** یک endpoint با کلید کامل (سمت سرور). */
export async function getEndpoint(id: string): Promise<LLMEndpoint | null> {
  const eps = await listEndpoints();
  return eps.find((e) => e.id === id) ?? null;
}

function validateEndpointInput(input: {
  name?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
}): { name: string; baseUrl: string; apiKey: string } {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const rawBase = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!name) throw new InputError('نام endpoint را وارد کنید.');
  if (!rawBase) throw new InputError('آدرس base URL را وارد کنید.');
  let baseUrl: string;
  try {
    const u = new URL(rawBase);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw new InputError('آدرس base URL باید با http یا https شروع شود.');
    }
    baseUrl = u.toString().replace(/\/+$/, '');
  } catch (err) {
    if (err instanceof InputError) throw err;
    throw new InputError('آدرس base URL معتبر نیست.');
  }
  if (!apiKey) throw new InputError('کلید API را وارد کنید.');
  return { name, baseUrl, apiKey };
}

/**
 * افزودن endpoint جدید یا ویرایش موجود (با id). خروجی ماسک‌شده.
 * اگر apiKey خالی فرستاده شود (ویرایش بدون تغییر کلید)، کلید قبلی حفظ می‌شود.
 */
export async function saveEndpoint(input: {
  id?: string;
  name?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
}): Promise<MaskedLLMEndpoint> {
  const apiKeyRaw = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const eps = await listEndpoints();
  const existing =
    typeof input.id === 'string' ? eps.find((e) => e.id === input.id) : null;

  const validated = validateEndpointInput({
    name: input.name,
    baseUrl: input.baseUrl,
    apiKey: apiKeyRaw || existing?.apiKey || '',
  });

  const id = existing?.id ?? randomUUID();
  const record: LLMEndpoint = {
    id,
    name: validated.name,
    baseUrl: validated.baseUrl,
    apiKey: validated.apiKey,
  };

  const next = existing
    ? eps.map((e) => (e.id === id ? record : e))
    : [...eps, record];
  await setSetting(SETTINGS_KEY_ENDPOINTS, next);
  return toMasked(record);
}

/**
 * حذف endpoint. ارجاع تیم‌هایی که از این endpoint استفاده می‌کردند هم پاک می‌شود
 * تا تیم بی‌سرپرست با endpoint مرده نماند (به رفتار پیش‌فرض برمی‌گردند).
 */
export async function deleteEndpoint(id: string): Promise<void> {
  const eps = await listEndpoints();
  const next = eps.filter((e) => e.id !== id);
  if (next.length === eps.length) throw new InputError('این endpoint پیدا نشد.');
  await setSetting(SETTINGS_KEY_ENDPOINTS, next);

  const map = await getTeamModelMap();
  let changed = false;
  for (const team of TEAMS) {
    if (map[team]?.endpointId === id) {
      delete map[team];
      changed = true;
    }
  }
  if (changed) await setSetting(SETTINGS_KEY_TEAM_MODELS, map);
}

/** خواندن نگاشت «مدل هر تیم» (تیم‌هایی که تنظیم نشده‌اند در نگاشت نیستند). */
export async function getTeamModelMap(): Promise<TeamModelMap> {
  const raw = await getSetting<unknown>(SETTINGS_KEY_TEAM_MODELS, {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const map: TeamModelMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isTeamName(key) || !value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const endpointId =
      typeof v.endpointId === 'string' ? v.endpointId.trim() : '';
    const model = typeof v.model === 'string' ? v.model.trim() : '';
    if (endpointId && model) map[key] = { endpointId, model };
  }
  return map;
}

/**
 * ذخیره‌ی نگاشت «مدل هر تیم». ورودی نگاشت کامل است؛ تیمی که در ورودی نباشد
 * یعنی «تنظیم نشده» و از نگاشت پاک می‌شود (تیم به رفتار پیش‌فرض برمی‌گردد).
 */
export async function saveTeamModelMap(input: unknown): Promise<TeamModelMap> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InputError('ورودی نامعتبر است.');
  }
  const eps = await listEndpoints();
  const ids = new Set(eps.map((e) => e.id));
  const map: TeamModelMap = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!isTeamName(key)) throw new InputError(`نام تیم نامعتبر است: ${key}`);
    if (!value || typeof value !== 'object') {
      throw new InputError(`ورودی تیم «${key}» نامعتبر است.`);
    }
    const v = value as Record<string, unknown>;
    const endpointId =
      typeof v.endpointId === 'string' ? v.endpointId.trim() : '';
    const model = typeof v.model === 'string' ? v.model.trim() : '';
    if (!endpointId || !model) {
      throw new InputError(`برای تیم «${key}» هم endpoint و هم مدل لازم است.`);
    }
    if (!ids.has(endpointId)) {
      throw new InputError(`endpoint انتخاب‌شده برای تیم «${key}» وجود ندارد.`);
    }
    map[key] = { endpointId, model };
  }
  await setSetting(SETTINGS_KEY_TEAM_MODELS, map);
  return map;
}

/**
 * حل کردن پیکربندی LLM یک تیم: endpoint + کلید واقعی + مدل.
 * اگر تیم تنظیم نشده یا endpoint/کلیدش ناقص است، null برمی‌گردد تا
 * فراخواننده به رفتار پیش‌فرض (env) برگردد.
 */
export async function resolveTeamConfig(
  team: TeamName,
): Promise<ResolvedTeamLLM | null> {
  const map = await getTeamModelMap();
  const entry = map[team];
  if (!entry) return null;
  const ep = await getEndpoint(entry.endpointId);
  if (!ep || !ep.apiKey || !entry.model) return null;
  return { baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: entry.model };
}

export interface ModelsFetchResult {
  models: string[];
  latencyMs: number;
}

/**
 * فراخوانی واقعی GET {baseUrl}/models با کلید endpoint (سازگار با OpenAI-style).
 * خروجی: لیست شناسه‌ی مدل‌ها + زمان پاسخ. خطا با پیام فارسی پرتاب می‌شود.
 */
export async function fetchEndpointModels(
  id: string,
  timeoutMs = 30_000,
): Promise<ModelsFetchResult> {
  const ep = await getEndpoint(id);
  if (!ep) throw new InputError('این endpoint پیدا نشد.');
  if (!ep.apiKey) throw new InputError('کلید API برای این endpoint ثبت نشده است.');

  const url = `${ep.baseUrl}/models`;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${ep.apiKey}` },
      signal: controller.signal,
    });
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail =
        typeof body === 'object' && body !== null
          ? (body as { error?: { message?: string } }).error?.message
          : undefined;
      throw new Error(detail || `خطای HTTP ${res.status} از ${url}`);
    }
    const list =
      typeof body === 'object' && body !== null && Array.isArray((body as { data?: unknown }).data)
        ? (body as { data: unknown[] }).data
        : typeof body === 'object' &&
            body !== null &&
            Array.isArray((body as { models?: unknown }).models)
          ? (body as { models: unknown[] }).models
          : [];
    const models = list
      .map((m) => (typeof m === 'string' ? m : (m as { id?: unknown })?.id))
      .filter((m): m is string => typeof m === 'string' && m.length > 0)
      .slice(0, 500);
    return { models, latencyMs: Date.now() - started };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`پاسخی در ${Math.round(timeoutMs / 1000)} ثانیه نیامد (تایم‌اوت).`);
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}
