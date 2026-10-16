/**
 * lib/llm.ts: سرویس LLM با روتر هوشمند
 *
 * - Endpoint/key/model از پیکربندی هر تیم در جدول `settings`
 *   (کلیدهای `llm_endpoints` / `team_models`) می‌آید؛ از طریق کانتکست تیم
 *   که ارکستراتور با runWithTeamContext ست می‌کند.
 * - در غیر این صورت: env های `LLM_API_BASE` / `LLM_API_KEY` / `LLM_MODEL`.
 *
 * روتر هوشمند (callLLMSmart) : ماتریس کامل مدل × درگاه:
 *   ۱. فهرست اولویت‌بندی‌شده‌ی کاندیداها را می‌سازد: مدل اصلی تیم،
 *      بعد مدل‌های برتر همان درگاه، بعد «کشف پویا» (فهرست واقعی مدل‌های
 *      هر درگاه از GET /models، با اولویت مدل‌هایی که اخیراً موفق بوده‌اند)،
 *      بعد درگاه‌های بعدی به ترتیب تنظیمات.
 *   ۲. از روی گروه‌های درگاهی، «ماتریس تلاش» تخت ساخته می‌شود: برای هر مدل،
 *      اول همه‌ی درگاه‌هایی که آن مدل را دارند امتحان می‌شوند (چرخش کلید :
 *      مثلاً همان gemini-3.8-flash روی هر ۴ کلید Gemini) و بعد مدل بعدی.
 *      یعنی ترتیب «مدل‌محور» است نه «درگاه‌محور»، تا یک کلید rate-limit‌خورده
 *      کل مدل را نکشد.
 *   ۳. هر کاندیدایی که در cooldown باشد رد می‌شود.
 *   ۴. روی خطای 429/503/404/401/تایم‌اوت/اتصال، خطا ثبت و cooldown می‌شود
 *      و روتر سراغ ترکیب بعدی ماتریس می‌رود.
 *      - 429: «صبر کن و دوباره» : اگر همه مردند، تا سقف مشخص صبر می‌کند و
 *        همان کاندیداهای سهمیه‌تمام‌شده را یک دور دیگر امتحان می‌کند.
 *      - 503: فقط همان ترکیب رد می‌شود، مدل بعدی.
 *      - 401: کلید خراب است؛ کل درگاه رد می‌شود.
 *      - 404 روی مدل اصلی: جایگزین موفق خودکار در team_models ذخیره می‌شود.
 *   ۵. سقف تلاش (پیش‌فرض ۴۸) و سقف زمانی (پیش‌فرض ۴ دقیقه) جلوی گیر کردن
 *      حلقه را می‌گیرد.
 *   ۶. گزینه‌ی tier: 'fast' | 'standard' | 'strong' : برای کار ساده مدل
 *      سبک/ارزان اول، برای کار پیچیده مدل قوی اول (فقط ترتیب، نه حذف).
 *   ۷. هیچ درگاه/مدلی بی‌صدا رد نمی‌شود: دلیل رد شدن در لاگ و پیام خطای
 *      نهایی ثبت می‌شود تا علت «همه مردند» شفاف باشد.
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
  getModelSuccessMap,
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
  /**
   * رده‌ی مدل درخواستی: 'fast' (سبک/ارزان برای کار ساده)،
   * 'standard' (پیش‌فرض)، 'strong' (قوی برای کار پیچیده).
   * فقط «ترتیب» کاندیداها را عوض می‌کند؛ هیچ مدلی حذف نمی‌شود.
   * اگر ست نشود، ترتیب قدیمی حفظ می‌شود.
   */
  tier?: ModelTier;
  /**
   * حداقل طول قابل‌قبول پاسخ (نویسه، بعد از trim). اگر پاسخ کوتاه‌تر
   * باشد، مثل «خطای مدل» رفتار می‌شود: مدل خنثی (cooldown) می‌گیرد و
   * روتر سراغ ترکیب بعدی می‌رود. پاسخ منحط (مثلاً فقط `{"`) دیگر
   * «موفق» ثبت نمی‌شود و در تلاش‌های بعدی اولویت نمی‌گیرد.
   */
  minLength?: number;
  /**
   * اگر true باشد، پاسخ JSON انتظار می‌رود: طول دست‌کم
   * (minLength ?? 10) نویسه لازم است. این جلوی چرخه‌ی «مدل خراب ←
   * همان مدل دوباره» را در callLLMJson می‌گیرد.
   */
  expectJson?: boolean;
}

/** رده‌ی مدل: سبک/ارزان، استاندارد، قوی. */
export type ModelTier = 'fast' | 'standard' | 'strong';

/**
 * حدس رده‌ی مدل از روی نام (启发式):
 * lite/nano/mini/haiku ← سبک؛ pro/ultra/max/thinking/opus/sonnet ← قوی؛
 * بقیه (flash و...) ← استاندارد.
 */
export function modelTier(name: string): ModelTier {
  const n = name.toLowerCase();
  if (/(^|[^a-z])(lite|nano|mini|haiku)([^a-z]|$)/.test(n)) return 'fast';
  if (/(^|[^a-z])(pro|ultra|max|thinking|opus|sonnet)([^a-z]|$)/.test(n)) return 'strong';
  return 'standard';
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

/** خواندن عدد از env با مقدار پیش‌فرض (برای تست‌پذیری هم لازم است). */
function numEnv(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

/* سقف‌های حلقه‌ی روتر (قابل تنظیم با env برای تست): */
const maxRouteAttempts = () => numEnv('LLM_MAX_ROUTE_ATTEMPTS', 48); // سقف تلاش هر فراخوانی
const routeBudgetMs = () => numEnv('LLM_ROUTE_BUDGET_MS', 240_000);   // سقف زمانی حلقه (۴ دقیقه)
const maxQuotaWaitMs = () => numEnv('LLM_QUOTA_WAIT_MS', 90_000);     // سقف صبر پاس ۲ روی 429
const quotaCooldownMs = () => numEnv('LLM_QUOTA_COOLDOWN_MS', COOLDOWN_QUOTA_MS);

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
    'deepseek-v4-flash',
    'qwen3.5-omni-flash',
    'kimi-k3',
    'qwen3.8-flash',
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
/* کشف پویا: فهرست واقعی مدل‌های هر درگاه از GET /models               */
/* ------------------------------------------------------------------ */

/**
 * چرا کشف پویا؟ فهرست «مدل‌های تأییدشده» ثابت است ولی هر درگاه ده‌ها مدل
 * دارد (مثلاً reformboss). وقتی مدل‌های شناخته‌شده می‌میرند، روتر نباید
 * تسلیم شود؛ باید فهرست واقعی درگاه را بگیرد و یکی‌یکی امتحان کند تا
 * بالاخره یکی جواب بدهد.
 */

interface DiscoveredEntry {
  at: number;
  models: string[];
}

/** کش درون‌حافظه‌ای کشف مدل‌ها: endpointId -> { زمان، فهرست } */
const modelsDiscoveryCache = new Map<string, DiscoveredEntry>();
/** اعتبار کش موفق: ۱۵ دقیقه */
const DISCOVERY_TTL_MS = 15 * 60 * 1000;
/** اعتبار کش ناموفق: ۵ دقیقه (درگاه خراب در هر فراخوانی کوبیده نشود) */
const DISCOVERY_FAIL_TTL_MS = 5 * 60 * 1000;
/** تایم‌اوت درخواست GET /models */
const DISCOVERY_TIMEOUT_MS = 12_000;
/** سقف مدل‌های کشف‌شده‌ی هر درگاه در هر فراخوانی (ماتریس کامل ولی محدود) */
const MAX_DISCOVERED_PER_ENDPOINT = 20;

/** نام مدل امبدینگ است؟ (در مسیر چت نمی‌آید) */
function isEmbeddingModelName(name: string): boolean {
  return /embed/i.test(name);
}

/**
 * فهرست مدل‌های چتی که خود درگاه تبلیغ می‌کند (GET {baseUrl}/models،
 * سازگار با OpenAI-style). کش‌دار و fail-soft: روی هر خطا [] برمی‌گردد
 * و روتر به فهرست تأییدشده برمی‌گردد.
 */
async function discoverChatModels(ep: LLMEndpoint): Promise<string[]> {
  const now = Date.now();
  const hit = modelsDiscoveryCache.get(ep.id);
  if (hit) {
    const ttl = hit.models.length > 0 ? DISCOVERY_TTL_MS : DISCOVERY_FAIL_TTL_MS;
    if (now - hit.at < ttl) return hit.models;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
    let models: string[] = [];
    try {
      const res = await fetch(`${ep.baseUrl.replace(/\/+$/, '')}/models`, {
        headers: { Authorization: `Bearer ${ep.apiKey}` },
        signal: controller.signal,
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (res.ok && typeof body === 'object' && body !== null) {
        const list = Array.isArray((body as { data?: unknown }).data)
          ? (body as { data: unknown[] }).data
          : Array.isArray((body as { models?: unknown }).models)
            ? (body as { models: unknown[] }).models
            : [];
        const seen = new Set<string>();
        for (const m of list) {
          const id = typeof m === 'string' ? m : (m as { id?: unknown })?.id;
          if (typeof id !== 'string' || !id.trim()) continue;
          if (isEmbeddingModelName(id)) continue;
          const key = normModelName(id);
          if (seen.has(key)) continue;
          seen.add(key);
          models.push(id.trim());
        }
      }
    } finally {
      clearTimeout(timer);
    }
    modelsDiscoveryCache.set(ep.id, { at: now, models });
    if (models.length > 0) {
      console.log(`[llm-smart] درگاه ${ep.name}: ${models.length} مدل از /models کشف شد`);
    }
    return models;
  } catch (err) {
    modelsDiscoveryCache.set(ep.id, { at: now, models: [] });
    console.log(
      `[llm-smart] کشف مدل‌های درگاه ${ep.name} ناموفق بود (fail-soft): ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
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
  /** ماتریس تخت تلاش: مدل‌محور (برای هر مدل، اول همه‌ی درگاه‌ها = چرخش کلید) */
  attempts: AttemptCandidate[];
  team: TeamName | null;
  /** ورودی اصلی تیم (برای جایگزینی خودکار روی 404) */
  primaryEntry: TeamModelEntry | null;
  /** یادداشت‌های «رد شد» برای شفافیت در پیام خطای نهایی */
  skipped: string[];
}

/** یک ترکیب (درگاه × مدل) در ماتریس تلاش. */
interface AttemptCandidate {
  endpoint: LLMEndpoint;
  model: string;
  isPrimary: boolean;
}

interface ModelNode {
  display: string;
  entries: Array<{
    endpoint: LLMEndpoint;
    isPrimary: boolean;
    groupIndex: number;
    modelIndex: number;
    successTs: number;
  }>;
}

/**
 * ساخت ماتریس تخت تلاش از روی گروه‌های درگاهی.
 *
 * ترتیب «مدل‌محور» است: برای هر مدل (به ترتیب اولویت)، اول همه‌ی درگاه‌هایی
 * که آن مدل را دارند امتحان می‌شوند و بعد مدل بعدی. یعنی اگر gemini-3.8-flash
 * روی کلید اول 429 خورد، همان مدل روی کلید دوم/سوم/چهارم امتحان می‌شود
 * (چرخش کلید = تعادل بار) و تازه بعد می‌رویم سراغ مدل بعدی.
 *
 * ترتیب مدل‌ها:
 *   ۱. مدل اصلی تیم/تسک/صریح همیشه اول؛
 *   ۲. اگر tier ست شده باشد، مدل‌های هم‌رده‌ی درخواستی بعد می‌آیند؛
 *   ۳. بقیه به ترتیب اولویت قدیمی (پایدار).
 * داخل هر مدل: درگاه‌هایی که اخیراً با همین مدل موفق بوده‌اند اول، بعد به
 * ترتیب تنظیمات.
 */
function flattenToMatrix(
  groups: RouteGroup[],
  opts: LLMCallOptions,
  successMap: Map<string, number>,
): AttemptCandidate[] {
  const byModel = new Map<string, ModelNode>();
  groups.forEach((g, gi) => {
    g.models.forEach((c, mi) => {
      const key = normModelName(c.model);
      let node = byModel.get(key);
      if (!node) {
        node = { display: c.model, entries: [] };
        byModel.set(key, node);
      }
      if (c.isPrimary) node.display = c.model; // املای مدل اصلی حفظ شود
      node.entries.push({
        endpoint: g.endpoint,
        isPrimary: c.isPrimary,
        groupIndex: gi,
        modelIndex: mi,
        successTs: successMap.get(`${g.endpoint.id}::${key}`) ?? 0,
      });
    });
  });

  const firstPos = (n: ModelNode): readonly [number, number] => {
    let gi = Infinity;
    let mi = Infinity;
    for (const e of n.entries) {
      if (e.groupIndex < gi || (e.groupIndex === gi && e.modelIndex < mi)) {
        gi = e.groupIndex;
        mi = e.modelIndex;
      }
    }
    return [gi, mi] as const;
  };
  const isPrimaryNode = (n: ModelNode) => n.entries.some((e) => e.isPrimary);
  const tierWanted = opts.tier;

  const nodes = Array.from(byModel.values());
  nodes.sort((a, b) => {
    const pa = isPrimaryNode(a) ? 0 : 1;
    const pb = isPrimaryNode(b) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (tierWanted) {
      const ta = modelTier(a.display) === tierWanted ? 0 : 1;
      const tb = modelTier(b.display) === tierWanted ? 0 : 1;
      if (ta !== tb) return ta - tb;
    }
    const [ga, ma] = firstPos(a);
    const [gb, mb] = firstPos(b);
    if (ga !== gb) return ga - gb;
    return ma - mb;
  });

  const out: AttemptCandidate[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    const entries = n.entries.slice().sort((x, y) => {
      if (y.successTs !== x.successTs) return y.successTs - x.successTs;
      if (x.groupIndex !== y.groupIndex) return x.groupIndex - y.groupIndex;
      return x.modelIndex - y.modelIndex;
    });
    for (const e of entries) {
      const k = cooldownKey(e.endpoint.id, n.display);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ endpoint: e.endpoint, model: n.display, isPrimary: e.isPrimary });
    }
  }
  return out;
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
  // نقشه‌ی موفقیت اخیر: مدل‌هایی که اخیراً جواب داده‌اند در کشف پویا اول می‌آیند
  const successMap = await getModelSuccessMap(ordered.map((e) => e.id));

  // کشف موازی فهرست واقعی مدل‌های هر درگاه (کش‌دار و fail-soft)؛
  // وقتی مدل‌های شناخته‌شده می‌میرند، روتر از همین فهرست «بالاخره یکی» را پیدا می‌کند.
  const discoveredByEp = new Map<string, string[]>();
  await Promise.all(
    ordered
      .filter((e) => e.apiKey)
      .map(async (e) => {
        discoveredByEp.set(e.id, await discoverChatModels(e));
      }),
  );

  // مدل صریح کاربر روی درگاه اصلی می‌نشیند؛ اگر درگاه اصلی مشخص نیست
  // (نه team، نه default)، روی اولین درگاه فعال تا مدل صریح هرگز
  // بی‌صدا نادیده گرفته نشود.
  const explicitTargetId = primaryEntry?.endpointId ?? ordered[0]?.id ?? null;

  const groups: RouteGroup[] = [];
  const skipped: string[] = [];
  for (const ep of ordered) {
    if (!ep.apiKey) {
      skipped.push(`درگاه ${ep.name}: کلید API ثبت نشده است`);
      continue;
    }
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
    // ۱. مدل صریح کاربر (اگر هست): روی درگاه اصلی، یا اولین درگاه اگر اصلی مشخص نیست
    if (explicitModel && ep.id === explicitTargetId) push(explicitModel, true, true);
    // ۲. مدل پیکربندی‌شده‌ی تیم
    if (isPrimaryEp && primaryEntry) push(primaryEntry.model, true, true);
    // ۳. مدل‌های تأییدشده‌ی همان درگاه (به ترتیب کیفیت)
    for (const m of qualityChatModelsFor(ep)) push(m, false, false);
    // ۴. مدل‌های کشف‌شده از خود درگاه (GET /models): اول آن‌هایی که اخیراً
    //    موفق بوده‌اند، بعد به ترتیب تبلیغ درگاه. کش دستی ۲۴ساعته ممکن است
    //    کهنه باشد پس برای این‌ها فقط cooldownهای تازه (دیتابیس) اعمال می‌شود،
    //    نه «خراب» بودن قدیمی؛ اگر واقعاً خراب باشند، خطا می‌گیرند و
    //    خودکار به استراحت می‌روند.
    const discovered = (discoveredByEp.get(ep.id) ?? [])
      .slice()
      .sort(
        (a, b) =>
          (successMap.get(`${ep.id}::${normModelName(b)}`) ?? 0) -
          (successMap.get(`${ep.id}::${normModelName(a)}`) ?? 0),
      );
    let discoveredAdded = 0;
    for (const m of discovered) {
      if (discoveredAdded >= MAX_DISCOVERED_PER_ENDPOINT) break;
      const key = normModelName(m);
      if (!key || seen.has(key)) continue;
      if (dbCooldowns.has(`${ep.id}::${key}`)) continue;
      seen.add(key);
      models.push({ model: m, isPrimary: false });
      discoveredAdded++;
    }
    // ۵. بقیه‌ی مدل‌های سالم کش سلامت
    for (const m of extraHealthyModels(health, ep.id, seen)) push(m, false, false);
    if (models.length === 0) {
      skipped.push(`درگاه ${ep.name}: هیچ مدل فعالی نماند (همه در استراحت یا خراب)`);
      continue;
    }
    groups.push({ endpoint: ep, models });
  }

  if (groups.length === 0) {
    // هیچ endpoint فعالی در تنظیمات نیست؛ مسیر اضطراری env
    // (اگر کلید env هم نباشد، خطای فارسی واضح پرتاب می‌شود)
    const fb = buildEnvFallbackGroup(opts);
    return {
      groups: fb,
      attempts: flattenToMatrix(fb, opts, successMap),
      team,
      primaryEntry: null,
      skipped,
    };
  }
  return { groups, attempts: flattenToMatrix(groups, opts, successMap), team, primaryEntry, skipped };
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
      routeCooldowns.set(key, now + quotaCooldownMs());
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
 * اعتبارسنجی کیفیت پاسخ خام مدل، پیش از «موفق» ثبت شدن.
 * برمی‌گرداند: null یعنی قابل‌قبول؛ رشته یعنی دلیل رد (فارسی کوتاه).
 *
 * ریشه‌ی باگ: مدل گاهی پاسخ منحط می‌دهد (مثلاً فقط `{"`)؛ چون رشته
 * خالی نبود، روتر آن را موفقیت ثبت می‌کرد و حتی در تلاش‌های بعدی
 * اولویتش می‌داد. این تابع چنین پاسخی را «خطای مدل» می‌کند تا روتر
 * سراغ ترکیب بعدی برود.
 */
export function validateResponseQuality(
  text: string,
  opts: Pick<LLMCallOptions, 'minLength' | 'expectJson'>,
): string | null {
  const trimmed = text.trim();
  const min = opts.minLength ?? (opts.expectJson ? 10 : 0);
  if (min > 0 && trimmed.length < min) {
    return `پاسخ منحط (${trimmed.length} نویسه؛ حداقل ${min})`;
  }
  return null;
}

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
      const fb = buildEnvFallbackGroup(opts);
      plan = {
        groups: fb,
        attempts: flattenToMatrix(fb, opts, new Map()),
        team,
        primaryEntry: null,
        skipped: [],
      };
    } catch (envErr) {
      stats.errors += 1;
      stats.lastError = envErr instanceof Error ? envErr.message : String(envErr);
      throw envErr;
    }
  }

  if (plan.attempts.length === 0) {
    const msg =
      'هیچ مدل فعالی برای فراخوانی پیدا نشد. در بخش تنظیمات سامانه یک endpoint با کلید معتبر و یک مدل برای تیم ثبت کنید.';
    stats.errors += 1;
    stats.lastError = msg;
    throw new LLMError(msg);
  }

  console.log(
    `${tag} ماتریس تلاش (مدل‌محور، چرخش کلید): ${plan.attempts
      .map((a) => `${a.endpoint.name}/${a.model}`)
      .join(' ← ')}`,
  );

  const trace: string[] = [];
  /** درگاه‌هایی که کلیدشان در همین فراخوانی 401 گرفت: بقیه‌ی ترکیب‌هایشان رد می‌شود */
  const badEndpoints = new Set<string>();
  /** کاندیداهایی که 429 گرفتند: برای پاس ۲ («صبر کن و دوباره») */
  const quotaFailed = new Map<
    string,
    { endpoint: LLMEndpoint; model: string; isPrimary: boolean; until: number }
  >();
  const tStart = Date.now();
  const maxAttempts = maxRouteAttempts();
  const budgetMs = routeBudgetMs();
  let attempted = 0;
  let primaryGone = false;
  let budgetExceeded = false;
  let attemptCapHit = false;

  const runAttempts = async (list: AttemptCandidate[]): Promise<string | null> => {
    for (const cand of list) {
      const ep = cand.endpoint;
      if (badEndpoints.has(ep.id)) {
        trace.push(`${ep.name}: کلید نامعتبر (رد شد)`);
        continue;
      }
      if (attempted >= maxAttempts) {
        attemptCapHit = true;
        break;
      }
      if (Date.now() - tStart > budgetMs) {
        budgetExceeded = true;
        break;
      }
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
        // اعتبارسنجی کیفیت پاسخ: پاسخ منحط (خیلی کوتاه) موفقیت نیست.
        // ریشه‌ی باگ seo: مدل فقط `{"` برمی‌گرداند، روتر آن را «موفق» ثبت
        // می‌کرد و در تلاش‌های بعدی همان مدل خراب را اولویت می‌داد.
        const qualityError = validateResponseQuality(text, opts);
        if (qualityError) {
          await applyFailureCooldown(ep.id, cand.model, 'empty', qualityError);
          trace.push(`${ep.name}/${cand.model}: ${qualityError}`);
          console.log(`${tag} ${ep.name}/${cand.model} ← ${qualityError}`);
          continue;
        }
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
        if (c.kind === 'quota') {
          const k = cooldownKey(ep.id, cand.model);
          const until = routeCooldowns.get(k) ?? Date.now() + quotaCooldownMs();
          if (!quotaFailed.has(k)) {
            quotaFailed.set(k, {
              endpoint: ep,
              model: cand.model,
              isPrimary: cand.isPrimary,
              until,
            });
          }
        }
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
        // 401 یعنی کلید کل درگاه خراب است؛ بقیه‌ی ترکیب‌های همین درگاه رد می‌شوند
        if (c.kind === 'auth') badEndpoints.add(ep.id);
      }
    }
    return null;
  };

  // پاس ۱: کل ماتریس (مدل‌محور با چرخش کلید)
  let outcome = await runAttempts(plan.attempts);

  // پاس ۲ : «صبر کن و دوباره»: اگر همه با 429 مردند و سقف‌ها تمام نشده،
  // تا سقف مشخص صبر می‌کنیم و همان کاندیداهای سهمیه‌تمام‌شده را یک دور
  // دیگر امتحان می‌کنیم.
  if (!outcome && quotaFailed.size > 0 && !budgetExceeded && !attemptCapHit) {
    const entries = Array.from(quotaFailed.values());
    const waitMs = Math.min(
      Math.max(0, Math.min(...entries.map((e) => e.until)) - Date.now()),
      maxQuotaWaitMs(),
    );
    if (waitMs > 0) {
      console.log(
        `${tag} همه با 429 مردند؛ ${Math.ceil(waitMs / 1000)} ثانیه صبر و تلاش مجدد روی ${entries.length} کاندیدا`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
    // استراحت درون‌حافظه‌ای این‌ها را پاک می‌کنیم تا پاس ۲ واقعاً تلاش کند
    // (استراحت ماندگار دیتابیس عمداً نادیده گرفته می‌شود: ما صبر کردیم)
    for (const e of entries) routeCooldowns.delete(cooldownKey(e.endpoint.id, e.model));
    outcome = await runAttempts(
      entries.map((e) => ({ endpoint: e.endpoint, model: e.model, isPrimary: e.isPrimary })),
    );
  }

  if (!outcome) {
    const detail = trace.length > 0 ? trace.join('؛ ') : 'کاندیدایی برای تلاش نبود';
    const skipNote =
      plan.skipped.length > 0 ? ` ردشده‌ها: ${plan.skipped.join('؛ ')}.` : '';
    const budgetNote = budgetExceeded ? ' سقف زمانی روتر تمام شد.' : '';
    const capNote = attemptCapHit ? ' سقف تعداد تلاش روتر تمام شد.' : '';
    const msg =
      `همه‌ی مدل‌ها و درگاه‌ها ناموفق بودند و هیچ پاسخی گرفته نشد. ` +
      `جزئیات: ${detail}.${skipNote}${budgetNote}${capNote} ` +
      `اگر سهمیه تمام شده، چند دقیقه صبر کنید یا در تنظیمات مدل دیگری انتخاب کنید.`;
    stats.errors += 1;
    stats.lastError = detail;
    throw new LLMError(msg, { retried: true });
  }
  return outcome;
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
      // مدل‌های امبدینگ گوگل پیش‌فرض ۳۰۷۲ بُعد می‌دهند؛ ستون دیتابیس vector(1536)
      // است، پس بُعد را صریح می‌خواهیم تا بردار همیشه ۱۵۳۶ بُعدی برگردد.
      body: JSON.stringify({ model: normalizedModel, input, dimensions: EXPECTED_EMBEDDING_DIM }),
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
    // ریشه‌ی باگ seo: پاسخ منحط (`{"`) نباید «موفق» ثبت شود؛ روتر باید
    // مدل خراب را خنثی کند و سراغ ترکیب بعدی برود، نه اینکه ۳ بار همان
    // مدل را تکرار کند.
    expectJson: opts.expectJson ?? true,
  });

  const parsed = tryParseJson(raw);
  if (parsed.ok) return parsed.value as T;

  // تلاش دوم: از خود مدل بخواه خروجی را فقط به JSON معتبر تبدیل کند
  const retry = await callLLM(
    `خروجی قبلی‌ات JSON معتبر نبود. فقط و فقط JSON معتبر برگردان، بدون هیچ توضیح اضافه:\n\n${raw.slice(0, 4000)}`,
    { ...opts, temperature: 0, expectJson: opts.expectJson ?? true },
  );
  const parsed2 = tryParseJson(retry);
  if (parsed2.ok) return parsed2.value as T;

  // تلاش سوم: بریدگی خروجی معمولاً از سقف توکن می‌آید؛ همان محتوا را
  // «کوتاه و فشرده» می‌خواهیم تا کامل برسد
  const shortRetry = await callLLM(
    `پاسخ قبلی‌ات ناقص یا نامعتبر بود. این بار همان محتوا را «بسیار کوتاه و فشرده» بده تا ناقص نماند. فقط و فقط JSON معتبر برگردان، بدون هیچ توضیح اضافه:\n\n${prompt.slice(0, 3000)}`,
    {
      ...opts,
      temperature: 0,
      maxTokens: Math.min(opts.maxTokens ?? 4000, 2000),
      expectJson: opts.expectJson ?? true,
    },
  );
  const parsed3 = tryParseJson(shortRetry);
  if (parsed3.ok) return parsed3.value as T;

  throw new LLMError(
    `LLM output was not valid JSON: ${raw.trim().slice(0, 200)}${raw.length > 200 ? "..." : ""}`,
    { retried: true },
  );
}

/** JSON.parse امن: هرگز throw نمی‌کند. */
export function safeJsonParse(text: string): { ok: boolean; value?: unknown } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * استخراج بازه‌های کاندیدای JSON از متن.
 * اول گسترده‌ترین بازه‌ها (از اولین براکت تا انتهای متن؛ برای خروجی بریده‌شده)،
 * بعد بازه‌های دقیق، و آخر از آخرین براکت باز (برای وقتی نثرِ قبل از JSON
 * خودش آکولاد دارد).
 */
function extractJsonSpans(text: string): string[] {
  const spans: string[] = [];
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  const objEnd = text.lastIndexOf('}');
  const arrEnd = text.lastIndexOf(']');
  if (objStart >= 0) spans.push(text.slice(objStart));
  if (arrStart >= 0 && arrStart !== objStart) spans.push(text.slice(arrStart));
  if (objStart >= 0 && objEnd > objStart) spans.push(text.slice(objStart, objEnd + 1));
  if (arrStart >= 0 && arrEnd > arrStart) spans.push(text.slice(arrStart, arrEnd + 1));
  const lastObj = text.lastIndexOf('{');
  const lastArr = text.lastIndexOf('[');
  if (lastObj > objStart) spans.push(text.slice(lastObj));
  if (lastArr > arrStart) spans.push(text.slice(lastArr));
  return spans.filter((s, i) => spans.indexOf(s) === i);
}

/** بستن براکت‌های باز در انتهای متن (با رعایت رشته و escape). */
function closeOpenBrackets(t: string): string {
  let s = t;
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      const open = stack.pop();
      if ((ch === '}' && open !== '{') || (ch === ']' && open !== '[')) {
        if (open) stack.push(open); // براکت بسته‌ی بی‌جفت؛ نادیده بگیر
      }
    }
  }
  if (inString) s += '"'; // رشته‌ی نیمه‌تمام را ببند
  const closer: Record<string, string> = { '{': '}', '[': ']' };
  while (stack.length > 0) {
    const c = closer[stack.pop() as string];
    if (c) s += c;
  }
  return s;
}

/**
 * حذف عضو نیمه‌تمام انتهایی (,"key": مقدارِ ناقص)؛ آکولاد/کروشه‌ی بازِ
 * والد سر جایش می‌ماند تا بستن براکت‌ها آبجکت معتبر بسازد.
 */
function stripPartialTail(t: string): string {
  return t
    .replace(/([{,]\s*)"[^"]*"\s*:\s*("[^"]*|[^,{}[\]]*)$/, '$1')
    .replace(/,\s*$/, '');
}

/**
 * ترمیم JSON بریده‌شده: اول بستن ساده‌ی براکت‌ها، اگر نشد حذف عضو
 * نیمه‌تمام انتهایی و بعد بستن. ترمیم حدسی است؛ نتیجه همیشه با
 * JSON.parse راستی‌آزمایی می‌شود (این تابع خودش throw نمی‌کند).
 */
export function repairTruncatedJson(span: string): string {
  const t = span.trim();
  const closed = closeOpenBrackets(t);
  if (safeJsonParse(closed).ok) return closed;
  const stripped = closeOpenBrackets(stripPartialTail(t));
  if (safeJsonParse(stripped).ok) return stripped;
  return closed; // بهترین حدس؛ فراخواننده راستی‌آزمایی می‌کند
}

/**
 * استخراج تحمل‌پذیر JSON از متن: کدفنس، بعد بزرگ‌ترین بازه‌ی { ... } یا
 * [ ... ]، و در آخر ترمیم براکت‌های ناقصِ خروجیِ بریده‌شده.
 */
export function tryParseJson(text: string): { ok: boolean; value?: unknown } {
  let t = text.trim();
  const fenceMatch = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) t = fenceMatch[1].trim();
  const direct = safeJsonParse(t);
  if (direct.ok) return direct;
  for (const span of extractJsonSpans(t)) {
    const p = safeJsonParse(span);
    if (p.ok) return p;
    const repaired = safeJsonParse(repairTruncatedJson(span));
    if (repaired.ok) return repaired;
  }
  return { ok: false };
}
