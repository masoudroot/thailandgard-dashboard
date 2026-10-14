/**
 * lib/llm.ts — Backend 10: LLM service
 *
 * Thin wrapper around any OpenAI-compatible chat API.
 * - Base URL: `LLM_API_BASE` (default https://api.reformboss.com/v1)
 * - API key: `LLM_API_KEY` (required at call time, never hardcoded)
 * - Default model: opts.model -> settings -> `LLM_MODEL` env -> fallback constant
 * - Fallback: on provider error (503 / 429 / timeout / network failure) one retry
 *   with a substitute model is attempted before throwing.
 * - Timeout: default 180s (3 min) via AbortController; never hangs forever.
 * - Call counts are tracked for statistics (see getLLMStats).
 */

export interface LLMCallOptions {
  /** Model to use. Defaults to settings or LLM_MODEL env. */
  model?: string;
  /** Timeout in ms. Default 180_000 (3 minutes). */
  timeoutMs?: number;
  /** Max completion tokens. Default 2000. */
  maxTokens?: number;
  /** Optional system prompt. */
  system?: string;
  /** Sampling temperature. Default 0.7. */
  temperature?: number;
}

export interface LLMStats {
  total: number;
  success: number;
  fallback: number;
  errors: number;
  lastError: string | null;
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
 * Resolve the model: explicit opt > settings > LLM_MODEL env > built-in default.
 * `settings` is an optional DI hook for callers that keep the model in DB/settings;
 * if none is wired in, it is simply ignored.
 */
type SettingsProvider = () => Promise<{ model?: string } | null> | { model?: string } | null;
let settingsProvider: SettingsProvider | null = null;

/** Allow the app to plug a settings store (e.g. Supabase) for the default model. */
export function setLLMSettingsProvider(p: SettingsProvider | null): void {
  settingsProvider = p;
}

async function resolveModel(explicit?: string): Promise<string> {
  if (explicit) return explicit;
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

async function postChatCompletions(
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

    const res = await fetch(`${base.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
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
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new LLMError("LLM_API_KEY is not set");
  }
  const base = process.env.LLM_API_BASE || DEFAULT_API_BASE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = await resolveModel(opts.model);

  const callOpts = {
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    system: opts.system,
    timeoutMs,
  };

  stats.total += 1;

  try {
    const text = await postChatCompletions(base, apiKey, model, prompt, callOpts);
    stats.success += 1;
    return text;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (isRetryable(err)) {
      const fallback = fallbackModel(model);
      try {
        const text = await postChatCompletions(base, apiKey, fallback, prompt, callOpts);
        stats.success += 1;
        stats.fallback += 1;
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
  opts: LLMCallOptions = {},
): Promise<T> {
  const raw = await callLLM(prompt, {
    ...opts,
    temperature: opts.temperature ?? 0.2, // cooler by default for structured output
  });

  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LLMError(
      `LLM output was not valid JSON: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`,
      { retried: true },
    );
  }
}
