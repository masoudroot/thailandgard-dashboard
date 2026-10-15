/**
 * lib/llm.ts: سرویس LLM با روتر هوشمند
 *
 * - Endpoint/key/model از پیکربندی هر تیم در جدول `settings`
 *   (کلیدهای `llm_endpoints` / `team_models`) می‌آید؛ از طریق کانتکست تیم
 *   که ارکستراتور با runWithTeamContext ست می‌کند.
 * - در غیر این صورت: env های `LLM_API_BASE` / `LLM_API_KEY` / `LLM_MODEL`.
 *
 * روتر هوشمند (callLLMSmart):
 *   ۱. فهرست اولویت‌بندی‌شده‌ی کاندیداها را می‌سازد: مدل اصلی تیم،
 *      بعد مدل‌های برتر همان درگاه، بعد درگاه‌های بعدی به ترتیب تنظیمات.
 *   ۲. هر کاندیدایی که در cooldown باشد رد می‌شود.
 *   ۳. روی خطای 429/503/404/401/تایم‌اوت/اتصال، خطا ثبت و cooldown می‌شود
 *      و روتر سراغ مدل بعدی می‌رود؛ اگر همه‌ی مدل‌های یک درگاه تمام شد،
 *      درگاه بعدی امتحان می‌شود.
 *   ۴. اگر مدل اصلی تیم با 404 مرده باشد (مدل منسوخ)، جایگزین موفق به‌صورت
 *      خودکار در team_models ذخیره می‌شود تا انتخاب بعدی درست باشد.
 *   ۵. فهرست fallback فقط مدل‌های تأییدشده و باکیفیت است؛ هرگز مدل
 *      به‌دردنخور امتحان نمی‌شود.
 * - Timeout پیش‌فرض ۱۸۰ ثانیه؛ هیچ فراخوانی برای همیشه گیر نمی‌کند.
 * - آمار فراخوانی‌ها در getLLMStats دیده می‌شود.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { TeamName } from './types';
import {
  getEndpoint,
  getTeamModelMap,
  getDefaultModel,
  listEndpoints,
  readModelHealthCache,
  resolveEmbeddingChain,
  saveTeamModelMap,
  EXPECTED_EMBEDDING_DIM,
  type LLMEndpoint,
  type ModelHealthMap,
  type TeamModelEntry,
} from './llm-endpoints';
import {
  getCooldownKeys,
  recordModelFailure,
  recordModelSuccess,
  type ModelErrorType,
} from './model-health';

export interface LLMCallOptions {
  /** Model to use. Defaults to team config -> settings -> LLM_MODEL env. */
  model?: string;
  /** Team on whose behalf this call runs. Defaults to the ambient team context. */
  team?: TeamName;
  /**
   * Per-task model override (from the build_queue row). Beats the team config
   * but loses to an explicit `model`. { endpointId } is resolved server-side;
   * the API key is never passed through here.
   */
  task?: { endpointId: string; model: string };
  /** Timeout in ms. Default 180_000 (3 minutes). */
  timeoutMs?: number;
  /** Max completion tokens. Default 2000. */
  maxTokens?: number;
  /** Optional system prompt. */
  system?: string;
  /** Sampling temperature. Default 0.7. */
  temperature?: number;
}

/**
 * Ambient team context. The orchestrator wraps each team's runTeam() in
 * runWithTeamContext so every callLLM inside automatically uses that team's
 * configured endpoint + model, without touching the 15 team modules.
 */
const teamContext = new AsyncLocalStorage<TeamName>();

/** Run fn with the given team as the ambient LLM team context. */
export function runWithTeamContext<T>(
  team: TeamName,
  fn: () => T | Promise<T>,
): Promise<T> {
  return teamContext.run(team, () => Promise.resolve(fn()));
}

/** The team currently set by runWithTeamContext, if any. */
export function currentTeam(): TeamName | undefined {
  return teamContext.getStore();
}

export interface LLMStats {
  total: number;
  success: number;
  fallback: number;
  errors: number;
  lastError: string | null;
  /** فراخوانی‌هایی که با مدل/درگاه جایگزین (نه کاندیدای اول) جواب گرفتند */
  smartReroutes: number;
  /** آخرین مسیر موفق: "نام درگاه / مدل" */
  lastRoute: string | null;
}

const stats: LLMStats = {
  total: 0,
  success: 0,
  fallback: 0,
  errors: 0,
  lastError: null,
  smartReroutes: 0,
  lastRoute: null,
};

export function getLLMStats(): Readonly<LLMStats> {
  return { ...stats };
}

export function resetLLMStats(): void {
  stats.total = 0;
  stats.success = 0;
  stats.fallback = 0;
  stats.errors = 0;
  stats.lastError = null;
  stats.smartReroutes = 0;
  stats.lastRoute = null;
}

const DEFAULT_TIMEOUT_MS = 180_000; // 3 minutes
const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_API_BASE = "https://api.reformboss.com/v1";
const DEFAULT_MODEL = "glm-5.3-flash";

/* ------------------------------------------------------------------ */
/* Cooldown: مدل‌های خطادار موقتاً از چرخه‌ی کاندیداها خارج می‌شوند     */
/* ------------------------------------------------------------------ */

/** کلید: endpointId::model (نرمال‌شده) -> زمان پایان استراحت */
const routeCooldowns = new Map<string, number>();
/** درگاه‌هایی که کلیدشان نامعتبر است: endpointId -> زمان پایان استراحت */
const badKeyEndpoints = new Map<string, number>();

const COOLDOWN_QUOTA_MS = 5 * 60 * 1000;      // 429: سهمیه تمام شد
const COOLDOWN_UNAVAILABLE_MS = 2 * 60 * 1000; // 503: سرویس در دسترس نیست
const COOLDOWN_GONE_MS = 60 * 60 * 1000;       // 404: مدل منسوخ/حذف شده
const COOLDOWN_NET_MS = 1 * 60 * 1000;         // تایم‌اوت/اتصال/۴۰۰/پاسخ خالی
const COOLDOWN_BAD_KEY_MS = 30 * 60 * 1000;    // 401/403: کلید نامعتبر

function normModelName(model: string): string {
  return model.trim().replace(/^models\//i, '').toLowerCase();
}

function cooldownKey(endpointId: string, model: string): string {
  return `${endpointId}::${normModelName(model)}`;
}

function isOnCooldown(endpointId: string, model: string): boolean {
  const until = routeCooldowns.get(cooldownKey(endpointId, model));
  if (!until) return false;
  if (Date.now() > until) {
    routeCooldowns.delete(cooldownKey(endpointId, model));
    return false;
  }
  return true;
}

function isEndpointKeyBad(endpointId: string): boolean {
  const until = badKeyEndpoints.get(endpointId);
  if (!until) return false;
  if (Date.now() > until) {
    badKeyEndpoints.delete(endpointId);
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* فهرست مدل‌های تأییدشده (فقط مدل خوب؛ هرگز مدل به‌دردنخور)            */
/* ------------------------------------------------------------------ */

/**
 * مدل‌های چت تأییدشده به تفکیک نوع درگاه، به ترتیب کیفیت.
 * کلید با نام درگاه (حروف کوچک) یا آدرس آن تطبیق داده می‌شود.
 */
const QUALITY_CHAT_MODELS: Record<string, string[]> = {
  reformboss: [
    'glm-5.3-flash',
    'qwen3.8-flash',
    'qwen3.5-omni-flash',
    'deepseek-v4-flash',
    'kimi-k3',
  ],
  gemini: [
    'gemini-3.8-flash',
    'gemini-3.5-flash-lite',
    'gemini-2.5-flash-lite',
  ],
  cheapvibecode: [
    'glm-5.3-flash',
    'gemini-3.8-flash',
  ],
};

/** نوع درگاه را از نام یا آدرس حدس بزن: کلید QUALITY_* یا null */
function providerKind(ep: Pick<LLMEndpoint, 'name' | 'baseUrl'>): string | null {
  const hay = `${ep.name} ${ep.baseUrl}`.toLowerCase();
  for (const key of Object.keys(QUALITY_CHAT_MODELS)) {
    if (hay.includes(key)) return key;
  }
  if (hay.includes('generativelanguage')) return 'gemini';
  return null;
}

function qualityChatModelsFor(ep: Pick<LLMEndpoint, 'name' | 'baseUrl'>): string[] {
  const kind = providerKind(ep);
  return kind ? [...(QUALITY_CHAT_MODELS[kind] ?? [])] : [];
}

/* ------------------------------------------------------------------ */
/* ساخت فهرست کاندیداها                                                */
/* ------------------------------------------------------------------ */

interface RouteCandidate {
  model: string;
  /** مدل اصلی تیم/تسک/صریح است؟ (برای جایگزینی خودکار روی 404) */
  isPrimary: boolean;
}

interface RouteGroup {
  endpoint: LLMEndpoint;
  models: RouteCandidate[];
}

/** آیا کش سلامت می‌گوید این مدل روی این درگاه خراب است؟ */
function healthSaysBroken(
  health: ModelHealthMap,
  endpointId: string,
  model: string,
): boolean {
  const epHealth = health[endpointId];
  if (!epHealth) return false;
  const want = normModelName(model);
  for (const [name, h] of Object.entries(epHealth)) {
    if (normModelName(name) === want) return h.ok === false;
  }
  return false;
}

/** مدل‌های سالم کش سلامت که در فهرست تأییدشده نیستند (تکمیلی). */
function extraHealthyModels(
  health: ModelHealthMap,
  endpointId: string,
  already: Set<string>,
): string[] {
  const epHealth = health[endpointId];
  if (!epHealth) return [];
  const out: string[] = [];
  for (const [name, h] of Object.entries(epHealth)) {
    if (h.ok !== true) continue;
    if (/embed/i.test(name)) continue; // مدل امبدینگ در مسیر چت نمی‌آید
    const key = normModelName(name);
    if (already.has(key)) continue;
    already.add(key);
    out.push(name);
  }
  return out;
}

interface ChatRoutePlan {
  groups: RouteGroup[];
  team: TeamName | null;
  /** ورودی اصلی تیم (برای جایگزینی خودکار روی 404) */
  primaryEntry: TeamModelEntry | null;
}

async function buildChatRouteGroups(opts: LLMCallOptions): Promise<ChatRoutePlan> {
  const team = opts.team ?? currentTeam() ?? null;
  const explicitModel = opts.model?.trim() || null;

  // ورودی اصلی: تسک > تیم > پیش‌فرض سامانه
  let primaryEntry: TeamModelEntry | null = null;
  if (opts.task?.endpointId && opts.task?.model) {
    primaryEntry = { endpointId: opts.task.endpointId, model: opts.task.model };
  } else if (team) {
    const map = await getTeamModelMap();
    primaryEntry = map[team] ?? (await getDefaultModel()) ?? null;
  }

  const endpoints = await listEndpoints();
  const health = await readModelHealthCache().catch(() => ({} as ModelHealthMap));

  // اگر endpoint ورودی اصلی حذف شده باشد، به پیکربندی تیم/پیش‌فرض برگرد
  const primaryEpId = primaryEntry?.endpointId ?? null;
  if (primaryEntry && primaryEpId && !endpoints.some((e) => e.id === primaryEpId)) {
    console.log(
      `[llm-smart] endpoint ورودی اصلی (${primaryEpId}) دیگر وجود ندارد؛ برگشت به پیکربندی تیم`,
    );
    primaryEntry = null;
    if (team) {
      const map = await getTeamModelMap();
      primaryEntry = map[team] ?? (await getDefaultModel()) ?? null;
    }
  }

  // ترتیب درگاه‌ها: درگاه اصلی تیم اول، بعد بقیه به ترتیب تنظیمات
  const ordered = [...endpoints].sort((a, b) => {
    const aFirst = a.id === primaryEntry?.endpointId ? 0 : 1;
    const bFirst = b.id === primaryEntry?.endpointId ? 0 : 1;
    return aFirst - bFirst;
  });

  // cooldownهای ماندگار (دیتابیس): مدل‌هایی که در ران‌های قبلی 429/503/... گرفتند
  // و هنوز در استراحت‌اند، از چرخه‌ی کاندیداها حذف می‌شوند. (fail-soft)
  const dbCooldowns = await getCooldownKeys(ordered.map((e) => e.id));

  const groups: RouteGroup[] = [];
  for (const ep of ordered) {
    if (!ep.apiKey) continue;
    const isPrimaryEp = ep.id === primaryEntry?.endpointId;
    const models: RouteCandidate[] = [];
    const seen = new Set<string>();
    const push = (model: string, isPrimary: boolean, skipHealthFilter: boolean) => {
      const key = normModelName(model);
      if (!key || seen.has(key)) return;
      if (!skipHealthFilter && healthSaysBroken(health, ep.id, model)) return;
      if (!skipHealthFilter && dbCooldowns.has(`${ep.id}::${key}`)) return;
      seen.add(key);
      models.push({ model, isPrimary });
    };
    // ۱. مدل صریح کاربر (اگر هست) روی درگاه اصلی
    if (isPrimaryEp && explicitModel) push(explicitModel, true, true);
    // ۲. مدل پیکربندی‌شده‌ی تیم
    if (isPrimaryEp && primaryEntry) push(primaryEntry.model, true, true);
    // ۳. مدل‌های تأییدشده‌ی همان درگاه (به ترتیب کیفیت)
    for (const m of qualityChatModelsFor(ep)) push(m, false, false);
    // ۴. بقیه‌ی مدل‌های سالم کش سلامت
    for (const m of extraHealthyModels(health, ep.id, seen)) push(m, false, false);
    if (models.length > 0) groups.push({ endpoint: ep, models });
  }

  if (groups.length === 0) {
    // هیچ endpoint فعالی در تنظیمات نیست؛ مسیر اضطراری env
    // (اگر کلید env هم نباشد، خطای فارسی واضح پرتاب می‌شود)
    return { groups: buildEnvFallbackGroup(opts), team, primaryEntry: null };
  }
  return { groups, team, primaryEntry };
}

/** مسیر اضطراری وقتی settings در دسترس نیست: فقط env */
function buildEnvFallbackGroup(opts: LLMCallOptions): RouteGroup[] {
  const base = process.env.LLM_API_BASE || DEFAULT_API_BASE;
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new LLMError(
      'هیچ درگاه فعالی برای فراخوانی مدل پیدا نشد: نه در تنظیمات endpoint هست نه LLM_API_KEY ست شده است.',
    );
  }
  const ep: LLMEndpoint = { id: 'env', name: 'env', baseUrl: base, apiKey };
  const models: RouteCandidate[] = [];
  const seen = new Set<string>();
  const push = (m: string, isPrimary: boolean) => {
    const key = normModelName(m);
    if (!key || seen.has(key)) return;
    seen.add(key);
    models.push({ model: m, isPrimary });
  };
  push(opts.model?.trim() || process.env.LLM_MODEL || DEFAULT_MODEL, true);
  for (const m of qualityChatModelsFor(ep)) push(m, false);
  return [{ endpoint: ep, models }];
}

/* ------------------------------------------------------------------ */
/* دسته‌بندی خطا و ثبت cooldown                                        */
/* ------------------------------------------------------------------ */

type FailureKind =
  | 'quota'        // 429
  | 'unavailable'  // 503
  | 'gone'         // 404: مدل منسوخ/حذف شده
  | 'auth'         // 401/403: کلید نامعتبر
  | 'badrequest'   // 400
  | 'empty'        // پاسخ بدون محتوا
  | 'network';     // تایم‌اوت/اتصال

interface ClassifiedFailure {
  kind: FailureKind;
  /** توضیح فارسی کوتاه برای لاگ و گزارش */
  fa: string;
  status?: number;
}

export function classifyLlmFailure(err: unknown): ClassifiedFailure {
  if (err instanceof LLMError && typeof err.status === 'number') {
    const s = err.status;
    if (s === 429) return { kind: 'quota', fa: 'سهمیه تمام شد (429)', status: s };
    if (s === 503) return { kind: 'unavailable', fa: 'سرویس در دسترس نیست (503)', status: s };
    if (s === 404) return { kind: 'gone', fa: 'مدل در دسترس نیست (404)', status: s };
    if (s === 401 || s === 403) return { kind: 'auth', fa: `کلید نامعتبر (${s})`, status: s };
    if (s === 400) return { kind: 'badrequest', fa: 'درخواست نامعتبر (400)', status: s };
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/timed out|abort/i.test(msg)) return { kind: 'network', fa: 'تایم‌اوت' };
  if (/fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network/i.test(msg))
    return { kind: 'network', fa: 'خطای اتصال' };
  if (/no content|پاسخی برنگرداند/i.test(msg)) return { kind: 'empty', fa: 'پاسخ خالی' };
  return { kind: 'network', fa: 'خطای ناشناخته' };
}

/** نگاشت نوع خطای روتر به نوع خطای ردیابی سلامت ماندگار. */
const FAILURE_KIND_TO_ERROR_TYPE: Record<FailureKind, ModelErrorType> = {
  quota: 'rate_limit_429',
  unavailable: 'service_503',
  gone: 'not_found_404',
  auth: 'auth_401',
  badrequest: 'unknown',
  empty: 'unknown',
  network: 'network',
};

async function applyFailureCooldown(
  endpointId: string,
  model: string,
  kind: FailureKind,
  message?: string,
): Promise<void> {
  const now = Date.now();
  const key = cooldownKey(endpointId, model);
  switch (kind) {
    case 'quota':
      routeCooldowns.set(key, now + COOLDOWN_QUOTA_MS);
      break;
    case 'unavailable':
      routeCooldowns.set(key, now + COOLDOWN_UNAVAILABLE_MS);
      break;
    case 'gone':
      routeCooldowns.set(key, now + COOLDOWN_GONE_MS);
      break;
    case 'auth':
      badKeyEndpoints.set(endpointId, now + COOLDOWN_BAD_KEY_MS);
      break;
    default:
      routeCooldowns.set(key, now + COOLDOWN_NET_MS);
      break;
  }
  // لایه‌ی ماندگار: ثبت در دیتابیس تا cooldown بین ران‌های گیت‌هاب اکشنز
  // (هر ران پردازش تازه است و حافظه‌ی درون‌پردازشی را از دست می‌دهد) هم اعمال شود.
  await recordModelFailure(
    endpointId,
    model,
    FAILURE_KIND_TO_ERROR_TYPE[kind] ?? 'unknown',
    message,
  );
}

/** جایگزینی خودکار مدل تیم وقتی مدل اصلی با 404 مرده است. */
async function autoReplaceTeamModel(
  team: TeamName,
  endpointId: string,
  model: string,
): Promise<void> {
  try {
    const map = await getTeamModelMap();
    map[team] = { endpointId, model };
    await saveTeamModelMap(map);
    console.log(
      `[llm-smart] team=${team}: مدل اصلی با 404 مرده بود؛ جایگزین خودکار ثبت شد: ${model}`,
    );
  } catch (err) {
    console.log(
      `[llm-smart] team=${team}: ثبت خودکار جایگزین ناموفق بود: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* روتر هوشمند اصلی                                                    */
/* ------------------------------------------------------------------ */

/**
 * فراخوانی هوشمند LLM:
 * مدل اصلی تیم ← مدل‌های برتر همان درگاه ← درگاه‌های بعدی.
 * روی 429/503/404/401/تایم‌اوت/اتصال، بعدی امتحان می‌شود.
 * اگر همه تمام شدند، خطای فارسی واضح پرتاب می‌شود.
 */
export async function callLLMSmart(
  prompt: string,
  opts: LLMCallOptions = {},
): Promise<string> {
  const team = opts.team ?? currentTeam() ?? null;
  const tag = `[llm-smart]${team ? ` team=${team}` : ''}`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const callOpts = {
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    system: opts.system,
    timeoutMs,
  };

  stats.total += 1;

  let plan: ChatRoutePlan;
  try {
    plan = await buildChatRouteGroups(opts);
  } catch (err) {
    // settings در دسترس نیست؛ مسیر اضطراری env
    console.log(
      `${tag} خواندن تنظیمات ناموفق بود، مسیر اضطراری env: ${err instanceof Error ? err.message : String(err)}`,
    );
    try {
      plan = { groups: buildEnvFallbackGroup(opts), team, primaryEntry: null };
    } catch (envErr) {
      stats.errors += 1;
      stats.lastError = envErr instanceof Error ? envErr.message : String(envErr);
      throw envErr;
    }
  }

  const usableGroups = plan.groups.filter((g) => g.models.length > 0);
  if (usableGroups.length === 0) {
    const msg =
      'هیچ مدل فعالی برای فراخوانی پیدا نشد. در بخش تنظیمات سامانه یک endpoint با کلید معتبر و یک مدل برای تیم ثبت کنید.';
    stats.errors += 1;
    stats.lastError = msg;
    throw new LLMError(msg);
  }

  console.log(
    `${tag} کاندیداها: ${usableGroups
      .map((g) => `${g.endpoint.name}:[${g.models.map((m) => m.model).join(', ')}]`)
      .join(' | ')}`,
  );

  const trace: string[] = [];
  let attempted = 0;
  let primaryGone = false;

  for (const group of usableGroups) {
    const ep = group.endpoint;
    if (isEndpointKeyBad(ep.id)) {
      console.log(`${tag} درگاه ${ep.name} رد شد (کلید نامعتبر، در استراحت)`);
      continue;
    }
    for (const cand of group.models) {
      if (isOnCooldown(ep.id, cand.model)) {
        trace.push(`${ep.name}/${cand.model}: در استراحت`);
        continue;
      }
      attempted += 1;
      const t0 = Date.now();
      try {
        const text = await postChatCompletions(
          ep.baseUrl,
          ep.apiKey,
          cand.model,
          prompt,
          callOpts,
        );
        routeCooldowns.delete(cooldownKey(ep.id, cand.model));
        // ردیابی سلامت ماندگار: موفقیت = پاک شدن cooldown و صفر شدن شمارنده
        await recordModelSuccess(ep.id, cand.model);
        const ms = Date.now() - t0;
        stats.success += 1;
        if (attempted > 1) {
          stats.fallback += 1;
          stats.smartReroutes += 1;
        }
        stats.lastRoute = `${ep.name} / ${cand.model}`;
        console.log(
          `${tag} پاسخ از ${ep.name}/${cand.model} در ${ms}ms (تلاش ${attempted})` +
            (trace.length > 0 ? `؛ قبلش: ${trace.join('؛ ')}` : ''),
        );
        // اگر مدل اصلی با 404 مرده بود، جایگزین موفق را خودکار ثبت کن
        if (primaryGone && team && plan.primaryEntry) {
          await autoReplaceTeamModel(team, ep.id, cand.model);
        }
        return text;
      } catch (err) {
        const c = classifyLlmFailure(err);
        const short =
          err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
        await applyFailureCooldown(ep.id, cand.model, c.kind, short);
        trace.push(`${ep.name}/${cand.model}: ${c.fa}`);
        console.log(`${tag} ${ep.name}/${cand.model} ← ${c.fa}: ${short}`);
        if (
          c.kind === 'gone' &&
          cand.isPrimary &&
          team &&
          plan.primaryEntry &&
          normModelName(cand.model) === normModelName(plan.primaryEntry.model) &&
          ep.id === plan.primaryEntry.endpointId
        ) {
          primaryGone = true;
        }
        if (c.kind === 'auth') break; // بقیه‌ی مدل‌های این درگاه هم با همین کلید خراب‌اند
      }
    }
  }

  const detail = trace.length > 0 ? trace.join('؛ ') : 'کاندیدایی برای تلاش نبود';
  const msg =
    `همه‌ی مدل‌ها و درگاه‌ها ناموفق بودند و هیچ پاسخی گرفته نشد. ` +
    `جزئیات: ${detail}. ` +
    `اگر سهمیه تمام شده، چند دقیقه صبر کنید یا در تنظیمات مدل دیگری انتخاب کنید.`;
  stats.errors += 1;
  stats.lastError = detail;
  throw new LLMError(msg, { retried: true });
}

export class LLMError extends Error {
  status?: number;
  retried: boolean;
  constructor(message: string, opts?: { status?: number; retried?: boolean }) {
    super(message);
    this.name = "LLMError";
    this.status = opts?.status;
    this.retried = opts?.retried ?? false;
  }
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  error?: { message?: string; code?: string | number };
}

export async function postChatCompletions(
  base: string,
  apiKey: string,
  model: string,
  prompt: string,
  opts: Required<Pick<LLMCallOptions, "maxTokens" | "temperature">> &
    Pick<LLMCallOptions, "system" | "timeoutMs">,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const messages: Array<{ role: string; content: string }> = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: prompt });

    // درگاه OpenAI-سازگار گوگل پیشوند models/ را نمی‌خواهد
    const normalizedModel =
      base.includes("generativelanguage.googleapis.com") && model.startsWith("models/")
        ? model.slice("models/".length)
        : model;

    const res = await fetch(`${base.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: normalizedModel,
        messages,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
      }),
      signal: controller.signal,
    });

    const body = (await res.json().catch(() => ({}))) as ChatCompletionResponse;

    if (!res.ok) {
      const detail = body?.error?.message || `HTTP ${res.status}`;
      throw new LLMError(`LLM provider error (${model}): ${detail}`, {
        status: res.status,
      });
    }

    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new LLMError(`LLM provider returned no content (${model})`);
    }
    return content;
  } catch (err) {
    if (err instanceof LLMError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new LLMError(
        `LLM request timed out after ${(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s (${model})`,
      );
    }
    throw new LLMError(
      `LLM request failed (${model}): ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Call the LLM and return the assistant's text.
 * از روتر هوشمند استفاده می‌کند: مدل اصلی ← مدل‌های برتر همان درگاه ← درگاه بعدی.
 */
export async function callLLM(
  prompt: string,
  opts: LLMCallOptions = {},
): Promise<string> {
  return callLLMSmart(prompt, opts);
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* امبدینگ هوشمند: روی زنجیره‌ی resolveEmbeddingChain سوار است          */
/* (lib/llm-endpoints.ts) و فقط cooldown و لاگ اضافه می‌کند؛           */
/* سیم‌کشی اصلی در lib/rag.ts است و دست نخورده می‌ماند.                */
/* ------------------------------------------------------------------ */

export interface EmbeddingSmartResult {
  embedding: number[];
  endpointName: string;
  model: string;
}

async function postEmbeddings(
  base: string,
  apiKey: string,
  model: string,
  input: string,
  timeoutMs: number,
): Promise<number[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // درگاه OpenAI-سازگار گوگل پیشوند models/ را نمی‌خواهد
    const normalizedModel =
      base.includes("generativelanguage.googleapis.com") && model.startsWith("models/")
        ? model.slice("models/".length)
        : model;
    const res = await fetch(`${base.replace(/\/+$/, "")}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: normalizedModel, input }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: Array<{ embedding?: number[] }>;
      error?: { message?: string };
    };
    if (!res.ok) {
      const detail = body?.error?.message || `HTTP ${res.status}`;
      throw new LLMError(`Embedding provider error (${model}): ${detail}`, {
        status: res.status,
      });
    }
    const embedding = body.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new LLMError(`Embedding provider returned no vector (${model})`);
    }
    if (embedding.length !== EXPECTED_EMBEDDING_DIM) {
      throw new LLMError(
        `Embedding dimension mismatch (${model}): got ${embedding.length}, want ${EXPECTED_EMBEDDING_DIM}`,
      );
    }
    return embedding;
  } catch (err) {
    if (err instanceof LLMError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new LLMError(`Embedding request timed out (${model})`);
    }
    throw new LLMError(
      `Embedding request failed (${model}): ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * ساخت بردار امبدینگ با روتر هوشمند (نسخه‌ی cooldownدار زنجیره‌ی امبدینگ):
 * مدل امبدینگ تنظیم‌شده ← مدل‌های جایگزین همان درگاه ← درگاه‌های دیگر.
 * کاندیداهای در استراحت (cooldown) رد می‌شوند تا درخواست بیهوده به
 * درگاه سهمیه‌تمام‌شده نرود.
 */
export async function getEmbeddingSmart(
  text: string,
  timeoutMs = 30_000,
): Promise<EmbeddingSmartResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new LLMError('متن خالی است؛ نمی‌توان امبدینگ ساخت.');
  }
  const tag = '[llm-smart:embedding]';
  let chain;
  try {
    chain = await resolveEmbeddingChain();
  } catch (err) {
    throw new LLMError(
      `خواندن پیکربندی امبدینگ ناموفق بود: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (chain.length === 0) {
    throw new LLMError(
      'مدل امبدینگ تنظیم نشده است. از بخش تنظیمات سامانه، یک endpoint و یک مدل امبدینگ انتخاب کنید.',
    );
  }

  // نام درگاه برای لاگ؛ از لیست endpointها پیدا می‌شود
  const endpoints = await listEndpoints().catch(() => [] as LLMEndpoint[]);
  const epNameOf = (id: string) => endpoints.find((e) => e.id === id)?.name ?? id;

  // cooldownهای ماندگار (دیتابیس): مدل‌هایی که در ران‌های قبلی خطا گرفتند
  const dbCooldowns = await getCooldownKeys(chain.map((c) => c.endpointId));

  const trace: string[] = [];
  let attempted = 0;
  for (const cand of chain) {
    const epName = epNameOf(cand.endpointId);
    // کلید کل درگاه مرده است؟ بقیه‌ی کاندیداهای همان درگاه را رد کن
    if (isEndpointKeyBad(cand.endpointId)) {
      trace.push(`${epName}: کلید نامعتبر (رد شد)`);
      continue;
    }
    if (isOnCooldown(cand.endpointId, cand.model)) {
      trace.push(`${epName}/${cand.model}: در استراحت`);
      continue;
    }
    if (dbCooldowns.has(`${cand.endpointId}::${normModelName(cand.model)}`)) {
      trace.push(`${epName}/${cand.model}: در استراحت (از ران قبلی)`);
      continue;
    }
    attempted += 1;
    try {
      const embedding = await postEmbeddings(cand.baseUrl, cand.apiKey, cand.model, trimmed, timeoutMs);
      routeCooldowns.delete(cooldownKey(cand.endpointId, cand.model));
      await recordModelSuccess(cand.endpointId, cand.model);
      console.log(
        `${tag} پاسخ از ${epName}/${cand.model} (تلاش ${attempted})` +
          (trace.length > 0 ? `؛ قبلش: ${trace.join('؛ ')}` : ''),
      );
      return { embedding, endpointName: epName, model: cand.model };
    } catch (err) {
      const c = classifyLlmFailure(err);
      const short =
        err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
      await applyFailureCooldown(cand.endpointId, cand.model, c.kind, short);
      trace.push(`${epName}/${cand.model}: ${c.fa}`);
      console.log(`${tag} ${epName}/${cand.model} ← ${c.fa}`);
      // روی 401/403 حلقه ادامه می‌دهد ولی isEndpointKeyBad بقیه‌ی
      // کاندیداهای همان درگاه را رد می‌کند
    }
  }
  throw new LLMError(
    `همه‌ی مدل‌های امبدینگ ناموفق بودند. جزئیات: ${trace.join('؛ ') || 'کاندیدایی نبود'}`,
    { retried: true },
  );
}

/**
 * Like callLLM but parses the response as JSON.
 * Tolerates ```json fences around the payload. Throws if parsing fails.
 */
export async function callLLMJson<T = unknown>(
  prompt: string,
  opts: LLMCallOptions & { jsonExample?: string } = {},
): Promise<T> {
  const jsonRule =
    "\n\nقانون سفت و سخت: خروجی‌ات باید دقیقاً یک JSON معتبر باشد. هیچ متنی قبل یا بعدش نباشد؛ نه markdown، نه توضیح، نه کدفنس." +
    (opts.jsonExample ? `\nمثال دقیق ساختار:\n${opts.jsonExample}` : "");
  const raw = await callLLM(prompt + jsonRule, {
    ...opts,
    // خروجی ساخت‌یافته فارسی به توکن بیشتری نیاز دارد؛ پیش‌فرض را بالاتر می‌بریم
    maxTokens: opts.maxTokens ?? 4000,
    temperature: opts.temperature ?? 0.1, // خنک‌تر برای خروجی ساخت‌یافته
  });

  const parsed = tryParseJson(raw);
  if (parsed.ok) return parsed.value as T;

  // تلاش دوم: از خود مدل بخواه خروجی را فقط به JSON معتبر تبدیل کند
  const retry = await callLLM(
    `خروجی قبلی‌ات JSON معتبر نبود. فقط و فقط JSON معتبر برگردان، بدون هیچ توضیح اضافه:\n\n${raw.slice(0, 4000)}`,
    { ...opts, temperature: 0 },
  );
  const parsed2 = tryParseJson(retry);
  if (parsed2.ok) return parsed2.value as T;

  throw new LLMError(
    `LLM output was not valid JSON: ${raw.trim().slice(0, 200)}${raw.length > 200 ? "..." : ""}`,
    { retried: true },
  );
}

/** استخراج تحمل‌پذیر JSON از متن: fence، بعد اولین { تا آخرین }. */
function tryParseJson(text: string): { ok: boolean; value?: unknown } {
  let t = text.trim();
  const fenceMatch = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) t = fenceMatch[1].trim();
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    // تلاش آخر: بزرگ‌ترین بازه‌ی { ... }
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return { ok: true, value: JSON.parse(t.slice(start, end + 1)) };
      } catch {
        /* ادامه */
      }
    }
    return { ok: false };
  }
}
