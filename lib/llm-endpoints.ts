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
/** مدل پیش‌فرض سامانه برای تیم‌های بدون تنظیم: { endpointId, model } یا null */
export const SETTINGS_KEY_DEFAULT_MODEL = 'llm_default_model';
/** مدل امبدینگ سامانه برای جست‌وجوی معنایی: { endpointId, model } یا null */
export const SETTINGS_KEY_EMBEDDING_MODEL = 'llm_embedding_model';

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
  /** شناسه endpoint برای ردیابی سلامت مدل (lib/model-health). */
  endpointId: string;
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

  // مدل پیش‌فرض و امبدینگ اگر به این endpoint اشاره کنند پاک می‌شوند
  // تا ارجاع مرده در settings نماند.
  for (const key of [SETTINGS_KEY_DEFAULT_MODEL, SETTINGS_KEY_EMBEDDING_MODEL]) {
    const raw = await getSetting<unknown>(key, null);
    if (
      raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      (raw as Record<string, unknown>).endpointId === id
    ) {
      await setSetting(key, null);
    }
  }
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
 * اگر تیم تنظیم نشده یا endpoint/کلیدش ناقص است، به «مدل پیش‌فرض سامانه»
 * برمی‌گردد؛ اگر آن هم نباشد null تا فراخواننده به رفتار پیش‌فرض (env) برگردد.
 */
export async function resolveTeamConfig(
  team: TeamName,
): Promise<ResolvedTeamLLM | null> {
  const map = await getTeamModelMap();
  const entry = map[team] ?? (await getDefaultModel());
  if (!entry) return null;
  const ep = await getEndpoint(entry.endpointId);
  if (!ep || !ep.apiKey || !entry.model) return null;
  return { baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: entry.model, endpointId: ep.id };
}

/** خواندن «مدل پیش‌فرض سامانه» (تیم‌های بدون تنظیم از آن استفاده می‌کنند). */
export async function getDefaultModel(): Promise<TeamModelEntry | null> {
  return getSingleModelEntry(SETTINGS_KEY_DEFAULT_MODEL);
}

/** خواندن «مدل امبدینگ» سامانه (جست‌وجوی معنایی در حافظه تیم‌ها). */
export async function getEmbeddingModel(): Promise<TeamModelEntry | null> {
  return getSingleModelEntry(SETTINGS_KEY_EMBEDDING_MODEL);
}

/** خواندن یک ورودی تکی { endpointId, model } از settings؛ endpoint مرده null می‌دهد. */
async function getSingleModelEntry(key: string): Promise<TeamModelEntry | null> {
  const raw = await getSetting<unknown>(key, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const endpointId = typeof v.endpointId === 'string' ? v.endpointId.trim() : '';
  const model = typeof v.model === 'string' ? v.model.trim() : '';
  if (!endpointId || !model) return null;
  const ep = await getEndpoint(endpointId);
  if (!ep) return null;
  return { endpointId, model };
}

/** ذخیره‌ی یک ورودی تکی { endpointId, model } در settings؛ ورودی null یعنی پاک کردن. */
async function saveSingleModelEntry(
  key: string,
  input: unknown,
): Promise<TeamModelEntry | null> {
  if (input === null) {
    await setSetting(key, null);
    return null;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InputError('ورودی نامعتبر است.');
  }
  const v = input as Record<string, unknown>;
  const endpointId = typeof v.endpointId === 'string' ? v.endpointId.trim() : '';
  const model = typeof v.model === 'string' ? v.model.trim() : '';
  if (!endpointId || !model) {
    throw new InputError('هم endpoint و هم مدل لازم است.');
  }
  const ep = await getEndpoint(endpointId);
  if (!ep) throw new InputError('این endpoint وجود ندارد.');
  const entry: TeamModelEntry = { endpointId, model };
  await setSetting(key, entry);
  return entry;
}

/**
 * ذخیره‌ی «مدل پیش‌فرض سامانه». ورودی null یعنی پاک کردن (برگشت به env).
 */
export async function saveDefaultModel(input: unknown): Promise<TeamModelEntry | null> {
  return saveSingleModelEntry(SETTINGS_KEY_DEFAULT_MODEL, input);
}

/**
 * ذخیره‌ی «مدل امبدینگ» سامانه. ورودی null یعنی پاک کردن.
 */
export async function saveEmbeddingModel(input: unknown): Promise<TeamModelEntry | null> {
  return saveSingleModelEntry(SETTINGS_KEY_EMBEDDING_MODEL, input);
}

/**
 * حل کردن پیکربندی امبدینگ: endpoint + کلید واقعی + مدل.
 * اگر تنظیم نشده یا endpoint/کلیدش ناقص است null برمی‌گردد تا فراخواننده
 * به رفتار پیش‌فرض (env) برگردد.
 */
export async function resolveEmbeddingConfig(): Promise<ResolvedTeamLLM | null> {
  const entry = await getEmbeddingModel();
  if (!entry) return null;
  const ep = await getEndpoint(entry.endpointId);
  if (!ep || !ep.apiKey || !entry.model) return null;
  return { baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: entry.model, endpointId: ep.id };
}

/* ------------------------------------------------------------------ */
/* زنجیره‌ی هوشمند امبدینگ (fallback خودکار)                            */
/* ------------------------------------------------------------------ */

/**
 * بُعد بردار امبدینگ ذخیره‌شده در دیتابیس.
 * باید با `knowledge_chunks.embedding vector(1536)` یکی باشد؛ مدل جایگزین
 * که بُعد دیگری برگرداند برای جست‌وجوی معنایی قابل استفاده نیست و در زنجیره
 * رد می‌شود.
 */
export const EXPECTED_EMBEDDING_DIM = 1536;

/**
 * مدل‌های امبدینگ جایگزینِ شناخته‌شده با خروجی ۱۵۳۶ بُعدی.
 * فقط مدل‌هایی این‌جا هستند که بُعد خروجی‌شان قطعی ۱۵۳۶ است؛ مدل «به‌دردنخور»
 * یا با بُعد نامطمئن این‌جا نمی‌آید چون شباهت کسینوسی بین فضای برداری
 * متفاوت بی‌معناست.
 */
export const EMBEDDING_FALLBACK_MODELS: string[] = [
  'text-embedding-3-small',
  'text-embedding-ada-002',
];

/**
 * ساخت زنجیره‌ی مرتب کاندیداهای امبدینگ:
 *   ۱. مدل اصلی روی endpoint اصلی (تنظیم `llm_embedding_model`)
 *   ۲. مدل‌های جایگزینِ خوب روی همان endpoint
 *   ۳. همان مدل اصلی روی endpointهای بعدی (سهمیه‌ی تازه)
 *   ۴. مدل‌های جایگزین روی endpointهای بعدی
 *
 * ترتیب دقیقاً همان منطق درخواستی است: اول مدل خوب دیگر روی همان API،
 * بعد API بعدی. endpoint بدون کلید نادیده گرفته می‌شود و ترکیب‌های تکراری
 * حذف می‌شوند.
 */
export async function resolveEmbeddingChain(): Promise<ResolvedTeamLLM[]> {
  const primary = await getEmbeddingModel();
  const eps = await listEndpoints();
  return buildEmbeddingChain(primary, eps);
}

/**
 * ساخت زنجیره‌ی مرتب کاندیداها از روی ورودی خالص (قابل تست بدون دیتابیس).
 */
export function buildEmbeddingChain(
  primary: TeamModelEntry | null,
  endpoints: LLMEndpoint[],
): ResolvedTeamLLM[] {
  const chain: ResolvedTeamLLM[] = [];
  const seen = new Set<string>();
  const push = (ep: LLMEndpoint, model: string) => {
    // یکتاسازی بر اساس endpointId، نه baseUrl: چند endpoint ممکن است آدرس
    // یکسان ولی کلید متفاوت داشته باشند و نباید همدیگر را حذف کنند.
    const key = `${ep.id}||${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    chain.push({ baseUrl: ep.baseUrl, apiKey: ep.apiKey, model, endpointId: ep.id });
  };

  const ordered = [...endpoints].sort((a, b) => {
    if (primary) {
      if (a.id === primary.endpointId) return -1;
      if (b.id === primary.endpointId) return 1;
    }
    return 0;
  });

  for (const ep of ordered) {
    if (!ep.apiKey) continue;
    const models: string[] = [];
    // مدل اصلی اول؛ روی endpoint اصلی همان مدل تنظیم‌شده، روی بقیه همان نام
    // مدل (سهمیه‌ی تازه روی API بعدی). اگر روی آن API وجود نداشت، 404 می‌دهد
    // و زنجیره به کاندیدای بعدی می‌رود.
    if (primary?.model) models.push(primary.model);
    for (const m of EMBEDDING_FALLBACK_MODELS) models.push(m);
    for (const m of models) push(ep, m);
  }
  return chain;
}

export interface EmbeddingTestResult {
  dims: number;
  latencyMs: number;
}

/**
 * تست واقعی امبدینگ: ارسال یک متن کوتاه به endpoint+مدل داده‌شده و برگرداندن
 * بُعد بردار + زمان پاسخ. برای بخش «تست واقعی» تنظیمات.
 */
export async function testEmbedding(
  endpointId: string,
  model: string,
  text = 'تست امبدینگ',
  timeoutMs = 60_000,
): Promise<EmbeddingTestResult> {
  const ep = await getEndpoint(endpointId);
  if (!ep) throw new InputError('این endpoint پیدا نشد.');
  if (!ep.apiKey) throw new InputError('کلید API برای این endpoint ثبت نشده است.');
  const cleanModel = model.trim();
  if (!cleanModel) throw new InputError('مدل را مشخص کنید.');

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ep.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ep.apiKey}`,
      },
      // مثل مسیر تولید: بُعد ۱۵۳۶ را صریح می‌خواهیم تا نتیجه تست با رفتار واقعی یکی باشد
      body: JSON.stringify({ model: cleanModel, input: text, dimensions: EXPECTED_EMBEDDING_DIM }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: Array<{ embedding?: number[] }>;
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new InputError(
        `تست امبدینگ ناموفق بود (وضعیت ${res.status}): ${body?.error?.message ?? ''}`.trim(),
      );
    }
    const embedding = body.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new InputError('درگاه برداری برنگرداند.');
    }
    return { dims: embedding.length, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export interface PromptTestResult {
  text: string;
  latencyMs: number;
}

/**
 * تست واقعی پرامپت: ارسال یک پیام به endpoint+مدل داده‌شده و برگرداندن
 * متن پاسخ + زمان پاسخ. برای بخش «تست واقعی» تنظیمات.
 */
export async function testPrompt(
  endpointId: string,
  model: string,
  prompt: string,
  timeoutMs = 120_000,
): Promise<PromptTestResult> {
  const ep = await getEndpoint(endpointId);
  if (!ep) throw new InputError('این endpoint پیدا نشد.');
  if (!ep.apiKey) throw new InputError('کلید API برای این endpoint ثبت نشده است.');
  const cleanModel = model.trim();
  const cleanPrompt = prompt.trim();
  if (!cleanModel) throw new InputError('مدل را مشخص کنید.');
  if (!cleanPrompt) throw new InputError('متن پرامپت را بنویسید.');
  if (cleanPrompt.length > 4000) throw new InputError('پرامپت آزمایشی حداکثر ۴۰۰۰ نویسه باشد.');

  const url = `${ep.baseUrl}/chat/completions`;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ep.apiKey}`,
      },
      body: JSON.stringify({
        model: cleanModel,
        messages: [{ role: 'user', content: cleanPrompt }],
        max_tokens: 500,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail =
        typeof body === 'object' && body !== null
          ? (body as { error?: { message?: string } }).error?.message
          : undefined;
      throw new Error(detail || `خطای HTTP ${res.status} از درگاه`);
    }
    const content =
      typeof body === 'object' && body !== null
        ? (body as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content
        : undefined;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('درگاه پاسخی برنگرداند.');
    }
    return { text: content, latencyMs: Date.now() - started };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`پاسخی در ${Math.round(timeoutMs / 1000)} ثانیه نیامد (تایم‌اوت).`);
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}

export interface ModelsFetchResult {
  models: string[];
  latencyMs: number;
}

/** نتیجه‌ی تست سلامت یک مدل؛ فقط وضعیت و دلیل کوتاه، بدون هیچ کلیدی. */
export interface ModelHealthResult {
  ok: boolean;
  message: string;
  checkedAt: string;
}

/** نگاشت endpointId -> model -> نتیجه تست سلامت */
export type ModelHealthMap = Record<string, Record<string, ModelHealthResult>>;

/** کلید کش سلامت مدل‌ها در settings */
export const SETTINGS_KEY_MODEL_HEALTH = 'llm_model_health';
/** انقضای کش سلامت مدل: ۲۴ ساعت */
export const MODEL_HEALTH_TTL_MS = 24 * 60 * 60 * 1000;
/** تایم‌اوت هر تست تک‌مدل: ۱۵ ثانیه */
export const MODEL_HEALTH_TIMEOUT_MS = 15_000;
/** سقف هم‌زمانی تست‌ها روی یک درگاه */
export const MODEL_HEALTH_CONCURRENCY = 3;

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

/**
 * تست سبک سلامت یک مدل: chat/completions با پرامپت «سلام» و max_tokens کم.
 * خروجی فقط وضعیت + دلیل کوتاه فارسی است؛ کلید هرگز لو نمی‌رود.
 */
export async function testSingleModelHealth(
  baseUrl: string,
  apiKey: string,
  model: string,
  timeoutMs = MODEL_HEALTH_TIMEOUT_MS,
): Promise<Omit<ModelHealthResult, 'checkedAt'>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // درگاه OpenAI-سازگار گوگل پیشوند models/ را نمی‌خواهد
    const normalizedModel =
      baseUrl.includes("generativelanguage.googleapis.com") && model.startsWith("models/")
        ? model.slice("models/".length)
        : model;
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: normalizedModel,
        messages: [{ role: 'user', content: 'سلام' }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, message: `خطای ${res.status}` };
    }
    const content =
      typeof body === 'object' && body !== null
        ? (body as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content
        : undefined;
    if (typeof content !== 'string' || content.trim().length === 0) {
      return { ok: false, message: 'پاسخی برنگرداند' };
    }
    return { ok: true, message: 'تست‌شده' };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, message: 'پاسخ نداد' };
    }
    return { ok: false, message: 'خطای اتصال' };
  } finally {
    clearTimeout(timer);
  }
}

/** اجرای موازی محدودشده با سقف هم‌زمانی */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        results[idx] = await fn(items[idx]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** خواندن کش سلامت مدل‌ها از settings (خروجی همیشه نرمال‌شده است). */
async function readHealthCache(): Promise<ModelHealthMap> {
  const raw = await getSetting<unknown>(SETTINGS_KEY_MODEL_HEALTH, {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const map: ModelHealthMap = {};
  for (const [epId, models] of Object.entries(raw as Record<string, unknown>)) {
    if (!models || typeof models !== 'object' || Array.isArray(models)) continue;
    const entry: Record<string, ModelHealthResult> = {};
    for (const [model, h] of Object.entries(models as Record<string, unknown>)) {
      if (!h || typeof h !== 'object' || Array.isArray(h)) continue;
      const r = h as Record<string, unknown>;
      if (typeof r.ok !== 'boolean' || typeof r.message !== 'string') continue;
      entry[model] = {
        ok: r.ok,
        message: r.message,
        checkedAt:
          typeof r.checkedAt === 'string' ? r.checkedAt : new Date(0).toISOString(),
      };
    }
    map[epId] = entry;
  }
  return map;
}

/**
 * خواندن کش سلامت مدل‌ها برای روتر هوشمند (فقط خواندنی).
 * کلیدها endpointId و نام مدل‌اند؛ مقدارها { ok, message, checkedAt }.
 */
export async function readModelHealthCache(): Promise<ModelHealthMap> {
  return readHealthCache();
}

/**
 * تست سلامت مجموعه‌ی مدل‌های یک endpoint با کش ۲۴ ساعته.
 * فقط مدل‌هایی تست می‌شوند که در کش نیستند، منقضی شده‌اند یا force=true است؛
 * بقیه از کش برمی‌گردند. خروجی: نگاشت مدل -> { ok, message }.
 */
export async function getModelsHealth(
  endpointId: string,
  models: string[],
  opts: { force?: boolean; timeoutMs?: number } = {},
): Promise<Record<string, Omit<ModelHealthResult, 'checkedAt'>>> {
  const ep = await getEndpoint(endpointId);
  if (!ep) throw new InputError('این endpoint پیدا نشد.');
  if (!ep.apiKey) throw new InputError('کلید API برای این endpoint ثبت نشده است.');

  const clean = Array.from(new Set(models.map((m) => m.trim()).filter(Boolean))).slice(0, 100);
  if (clean.length === 0) throw new InputError('فهرست مدل‌ها خالی است.');

  const cache = await readHealthCache();
  const epCache = cache[endpointId] ?? {};
  const now = Date.now();
  const toTest = clean.filter((m) => {
    if (opts.force) return true;
    const hit = epCache[m];
    if (!hit) return true;
    const age = now - Date.parse(hit.checkedAt);
    return Number.isNaN(age) || age > MODEL_HEALTH_TTL_MS;
  });

  const timeoutMs = opts.timeoutMs ?? MODEL_HEALTH_TIMEOUT_MS;
  const fresh = await mapPool(toTest, MODEL_HEALTH_CONCURRENCY, async (model) => {
    const result = await testSingleModelHealth(ep.baseUrl, ep.apiKey, model, timeoutMs);
    return { model, result: { ...result, checkedAt: new Date().toISOString() } };
  });

  const nextEpCache: Record<string, ModelHealthResult> = { ...epCache };
  for (const { model, result } of fresh) {
    nextEpCache[model] = result;
  }
  await setSetting(SETTINGS_KEY_MODEL_HEALTH, { ...cache, [endpointId]: nextEpCache });

  const out: Record<string, Omit<ModelHealthResult, 'checkedAt'>> = {};
  for (const m of clean) {
    const hit = nextEpCache[m];
    out[m] = hit ? { ok: hit.ok, message: hit.message } : { ok: false, message: 'تست نشد' };
  }
  return out;
}
