/**
 * lib/llm.ts: Backend 10: LLM service
 *
 * Thin wrapper around any OpenAI-compatible chat API.
 * - Endpoint/key/model can come from the per-team configuration in the
 *   `settings` table (keys `llm_endpoints` / `team_models`), resolved via the
 *   team context set by the orchestrator (see runWithTeamContext).
 * - Otherwise: env `LLM_API_BASE` (default https://api.reformboss.com/v1),
 *   env `LLM_API_KEY` (required at call time, never hardcoded), model from
 *   opts.model -> settings provider -> `LLM_MODEL` env -> fallback constant.
 * - Fallback: on provider error (503 / 429 / timeout / network failure) one retry
 *   with a substitute model is attempted before throwing.
 * - Timeout: default 180s (3 min) via AbortController; never hangs forever.
 * - Call counts are tracked for statistics (see getLLMStats).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { TeamName } from './types';
import { getEndpoint, resolveTeamConfig } from './llm-endpoints';

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
}

/**
 * Circuit breaker: مدل‌های خراب را موقتاً از مدار خارج می‌کند.
 * بعد از ۳ خطای پیاپی، مدل ۱۰ دقیقه استراحت می‌کند.
 */
const circuitBreaker = new Map<string, { failures: number; trippedUntil: number }>();
const CB_THRESHOLD = 3;
const CB_COOLDOWN_MS = 10 * 60 * 1000;

function isCircuitOpen(modelKey: string): boolean {
  const cb = circuitBreaker.get(modelKey);
  if (!cb) return false;
  if (Date.now() > cb.trippedUntil) {
    circuitBreaker.delete(modelKey);
    return false;
  }
  return cb.failures >= CB_THRESHOLD;
}

function recordSuccess(modelKey: string): void {
  circuitBreaker.delete(modelKey);
}

function recordFailure(modelKey: string): void {
  const cb = circuitBreaker.get(modelKey) ?? { failures: 0, trippedUntil: 0 };
  cb.failures += 1;
  if (cb.failures >= CB_THRESHOLD) {
    cb.trippedUntil = Date.now() + CB_COOLDOWN_MS;
    console.log(`[llm] circuit breaker tripped for ${modelKey} (${CB_COOLDOWN_MS / 60000}min cooldown)`);
  }
  circuitBreaker.set(modelKey, cb);
}

const stats: LLMStats = {
  total: 0,
  success: 0,
  fallback: 0,
  errors: 0,
  lastError: null,
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
}

const DEFAULT_TIMEOUT_MS = 180_000; // 3 minutes
const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_API_BASE = "https://api.reformboss.com/v1";

/**
 * Resolve the model: explicit opt > team config > settings provider >
 * LLM_MODEL env > built-in default.
 * `settings` is an optional DI hook for callers that keep the model in DB/settings;
 * if none is wired in, it is simply ignored.
 */
type SettingsProvider = () => Promise<{ model?: string } | null> | { model?: string } | null;
let settingsProvider: SettingsProvider | null = null;

/** Allow the app to plug a settings store (e.g. Supabase) for the default model. */
export function setLLMSettingsProvider(p: SettingsProvider | null): void {
  settingsProvider = p;
}

async function resolveModel(
  explicit?: string,
  teamModel?: string | null,
): Promise<string> {
  if (explicit) return explicit;
  if (teamModel) return teamModel;
  try {
    const s = await settingsProvider?.();
    if (s?.model) return s.model;
  } catch {
    // settings lookup must never break the call; fall through to env default
  }
  return process.env.LLM_MODEL || "glm-5.3-flash";
}

/** Model used for the single fallback retry. */
function fallbackModel(primary: string): string {
  const fromEnv = process.env.LLM_FALLBACK_MODEL;
  if (fromEnv && fromEnv !== primary) return fromEnv;
  const hardFallback = "gemini-3.8-flash";
  return primary === hardFallback ? "qwen3.8-flash" : hardFallback;
}

/**
 * جست‌وجوی هوشمند مدل جایگزین: مدل‌های سالم درگاه تیم را در لحظه تست می‌کند
 * و اولین مدلی که پاسخ می‌دهد را برمی‌گرداند.
 */
/**
 * مدل‌های جایگزین شناخته‌شده به تفکیک درگاه (سریع، بدون فچ داینامیک).
 * وقتی درگاهی خوابیده، مستقیم سراغ این‌ها می‌رویم.
 */
const KNOWN_FALLBACK_MODELS: Record<string, string[]> = {
  reformboss: ['deepseek-v4-flash', 'glm-5.3-flash', 'qwen3.8-flash'],
  cheapvibecode: ['glm-5.3-flash', 'gemini-3.8-flash'],
};

async function findWorkingModel(
  team: string,
  base: string,
  apiKey: string,
  failedModel: string,
): Promise<{ model: string; endpointId: string } | null> {
  try {
    const { getTeamModelMap, listEndpoints } = await import('./llm-endpoints');
    const map = await getTeamModelMap();
    const entry = (map as Record<string, { endpointId: string; model: string }>)[team];
    const endpoints = await listEndpoints();
    console.log(`[findWorkingModel] team=${team}, endpoints=${endpoints.length}`);
    // اول درگاه خود تیم، بعد بقیه (غیر gemini اول، چون خوابیده)
    const orderedEndpoints = [
      ...(entry?.endpointId ? [entry.endpointId] : []),
      ...endpoints
        .map((e) => e.id)
        .filter((id) => id !== entry?.endpointId)
        .sort((a, b) => {
          const aIsGemini = (endpoints.find((e) => e.id === a)?.name ?? '').toLowerCase().includes('gemini') ? 1 : 0;
          const bIsGemini = (endpoints.find((e) => e.id === b)?.name ?? '').toLowerCase().includes('gemini') ? 1 : 0;
          return aIsGemini - bIsGemini;
        }),
    ];
    for (const epId of orderedEndpoints) {
      const ep = endpoints.find((e) => e.id === epId);
      if (!ep?.apiKey) {
        console.log(`[findWorkingModel] skipping ${epId}: no apiKey`);
        continue;
      }
      const epName = ep.name.toLowerCase();
      console.log(`[findWorkingModel] trying endpoint ${ep.name}`);
      // مدل‌های شناخته‌شده این درگاه را مستقیم تست کن (سریع)
      const knownModels = Object.entries(KNOWN_FALLBACK_MODELS).find(([key]) =>
        epName.includes(key),
      )?.[1] ?? [];
      for (const m of knownModels) {
        if (m === failedModel) continue;
        try {
          await postChatCompletions(ep.baseUrl, ep.apiKey, m, 'سلام', {
            maxTokens: 8,
            temperature: 0,
            timeoutMs: 10000,
          });
          console.log(`[findWorkingModel] FOUND working model: ${m} on ${ep.name}`);
          return { model: m, endpointId: epId };
        } catch (testErr) {
          console.log(`[findWorkingModel] ${m} on ${ep.name} failed: ${testErr instanceof Error ? testErr.message.slice(0, 80) : String(testErr).slice(0, 80)}`);
          continue;
        }
      }
    }
    console.log(`[findWorkingModel] no working model found for team ${team}`);
    return null;
  } catch (err) {
    console.log(`[findWorkingModel] fatal: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** ذخیره مدل جدید برای تیم در تنظیمات. */
async function persistTeamModel(team: string, endpointId: string, model: string): Promise<void> {
  try {
    const { getTeamModelMap, saveTeamModelMap } = await import('./llm-endpoints');
    const map = await getTeamModelMap();
    (map as Record<string, { endpointId: string; model: string }>)[team] = { endpointId, model };
    await saveTeamModelMap(map);
  } catch {
    /* نادیده */
  }
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

/** Status codes / failure kinds that are worth one fallback retry. */
function isRetryable(err: unknown): boolean {
  if (err instanceof LLMError) {
    if (err.status === 503 || err.status === 429) return true;
    if (/timed out|fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT/i.test(err.message))
      return true;
  }
  return false;
}

/**
 * Call the LLM and return the assistant's text.
 * On provider error (503/429/timeout/network) retries ONCE with the fallback model.
 */
export async function callLLM(
  prompt: string,
  opts: LLMCallOptions = {},
): Promise<string> {
  // Team context: explicit opt wins, otherwise the ambient context set by the
  // orchestrator via runWithTeamContext.
  const team = opts.team ?? currentTeam() ?? null;

  // Resolution priority for base URL + API key + model:
  //   task override > team config (settings table) > env vars.
  // If the DB is unreachable or the selection is stale, silently fall back
  // down the chain; the call must never break because of this.
  let base = process.env.LLM_API_BASE || DEFAULT_API_BASE;
  let apiKey: string | undefined = process.env.LLM_API_KEY;
  let configuredModel: string | null = null;

  if (team) {
    try {
      const teamCfg = await resolveTeamConfig(team);
      if (teamCfg) {
        base = teamCfg.baseUrl;
        apiKey = teamCfg.apiKey;
        configuredModel = teamCfg.model;
      }
    } catch {
      // fall through to env defaults
    }
  }

  if (opts.task?.endpointId && opts.task?.model) {
    try {
      const taskEp = await getEndpoint(opts.task.endpointId);
      if (taskEp?.apiKey) {
        base = taskEp.baseUrl;
        apiKey = taskEp.apiKey;
        configuredModel = opts.task.model;
      }
      // stale/deleted endpoint: keep the team/env resolution above
    } catch {
      // fall through
    }
  }

  if (!apiKey) {
    throw new LLMError(
      team
        ? `no API key for team "${team}": configure an endpoint for it in settings, or set LLM_API_KEY`
        : "LLM_API_KEY is not set",
    );
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = await resolveModel(opts.model, configuredModel);
  const modelKey = `${base}::${model}`;

  const callOpts = {
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    system: opts.system,
    timeoutMs,
  };

  stats.total += 1;

  // اگر مدار این مدل باز است (خراب شناخته شده)، مستقیم برو سراغ جایگزین هوشمند
  if (isCircuitOpen(modelKey)) {
    console.log(`[llm] circuit open for ${model}, using smart fallback`);
    const smartFallback = team ? await findWorkingModel(team, base, apiKey, model) : null;
    if (smartFallback) {
      let fbBase = base;
      let fbKey = apiKey;
      try {
        const ep = await getEndpoint(smartFallback.endpointId);
        if (ep?.baseUrl && ep?.apiKey) {
          fbBase = ep.baseUrl;
          fbKey = ep.apiKey;
        }
      } catch { /* نادیده */ }
      const text = await postChatCompletions(fbBase, fbKey, smartFallback.model, prompt, callOpts);
      stats.success += 1;
      stats.fallback += 1;
      if (team) await persistTeamModel(team, smartFallback.endpointId, smartFallback.model).catch(() => {});
      return text;
    }
    // جایگزین پیدا نشد؛ همان را امتحان کن شاید درست شده باشد
  }

  try {
    const text = await postChatCompletions(base, apiKey, model, prompt, callOpts);
    stats.success += 1;
    recordSuccess(modelKey);
    return text;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (isRetryable(err)) {
      recordFailure(modelKey);
      // جست‌وجوی هوشمند: مدل‌های سالم همه درگاه‌ها را در لحظه تست کن
      const smartFallback = team ? await findWorkingModel(team, base, apiKey, model) : null;
      const fallback = smartFallback?.model ?? fallbackModel(model);
      // اگر مدل از درگاه دیگری آمد، از کلید و آدرس همان درگاه استفاده کن
      let fbBase = base;
      let fbKey = apiKey;
      if (smartFallback) {
        try {
          const { getEndpoint } = await import('./llm-endpoints');
          const ep = await getEndpoint(smartFallback.endpointId);
          if (ep?.baseUrl && ep?.apiKey) {
            fbBase = ep.baseUrl;
            fbKey = ep.apiKey;
          }
        } catch { /* نادیده */ }
      }
      try {
        const text = await postChatCompletions(fbBase, fbKey, fallback, prompt, callOpts);
        stats.success += 1;
        stats.fallback += 1;
        // اگر مدل جدید کار کرد، برای این تیم ذخیره‌اش کن
        if (smartFallback && team) {
          await persistTeamModel(team, smartFallback.endpointId, fallback).catch(() => {});
        }
        return text;
      } catch (fallbackErr) {
        const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        stats.errors += 1;
        stats.lastError = `primary(${model}): ${errMsg} | fallback(${fallback}): ${fbMsg}`;
        throw new LLMError(
          `LLM failed on both primary (${model}) and fallback (${fallback}): ${errMsg} / ${fbMsg}`,
          { retried: true },
        );
      }
    }
    stats.errors += 1;
    stats.lastError = errMsg;
    throw err;
  }
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
