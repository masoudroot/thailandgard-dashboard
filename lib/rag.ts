/**
 * lib/rag.ts — Backend 8: RAG service
 *
 * Vector search over `public.knowledge_chunks` (Supabase).
 * - `getEmbedding` posts to `{LLM_API_BASE}/embeddings` (OpenAI-compatible).
 * - `retrieveKnowledge` runs the `match_knowledge_chunks` RPC and formats the
 *   top chunks into a Persian context string.
 * - Both fail soft: on missing env, provider error or RPC error the retrieval
 *   path returns an empty string instead of blocking the caller.
 */

import { getSupabase } from './api';

/** 30s timeout for all outbound RAG calls (per spec). */
const TIMEOUT_MS = 30_000;

const DEFAULT_API_BASE = 'https://api.reformboss.com/v1';
/** knowledge_chunks.embedding is vector(1536); keep the default aligned. */
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

export class RAGError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RAGError';
  }
}

/**
 * Resolve the embedding model: explicit opt > settings > LLM_EMBEDDING_MODEL env.
 * `settings` is an optional DI hook (same pattern as lib/llm.ts); if none is
 * wired in, it is simply ignored.
 */
type SettingsProvider =
  | (() => Promise<{ embeddingModel?: string } | null>)
  | (() => { embeddingModel?: string } | null)
  | null;
let settingsProvider: SettingsProvider = null;

/** Allow the app to plug a settings store (e.g. Supabase) for the embedding model. */
export function setRAGSettingsProvider(p: SettingsProvider): void {
  settingsProvider = p;
}

async function resolveEmbeddingModel(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  try {
    const s = settingsProvider ? await settingsProvider() : null;
    if (s?.embeddingModel) return s.embeddingModel;
  } catch {
    // settings lookup must never break embedding; fall through to env default
  }
  return process.env.LLM_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
}

/**
 * Get the embedding vector for a text via the OpenAI-compatible /embeddings endpoint.
 * Throws RAGError on misconfiguration, provider error, timeout, or bad payload.
 */
export async function getEmbedding(text: string, model?: string): Promise<number[]> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new RAGError('LLM_API_KEY is not set');
  }
  const trimmed = text.trim();
  if (!trimmed) {
    throw new RAGError('getEmbedding: empty text');
  }
  const base = (process.env.LLM_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
  const embeddingModel = await resolveEmbeddingModel(model);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: embeddingModel, input: trimmed }),
      signal: controller.signal,
    });

    const body = (await res.json().catch(() => ({}))) as {
      data?: Array<{ embedding?: number[] }>;
      error?: { message?: string };
    };

    if (!res.ok) {
      const detail = body?.error?.message || `HTTP ${res.status}`;
      throw new RAGError(`Embedding provider error (${embeddingModel}): ${detail}`);
    }

    const embedding = body.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new RAGError(`Embedding provider returned no vector (${embeddingModel})`);
    }
    return embedding;
  } catch (err) {
    if (err instanceof RAGError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new RAGError(
        `Embedding request timed out after ${TIMEOUT_MS / 1000}s (${embeddingModel})`,
      );
    }
    throw new RAGError(
      `Embedding request failed (${embeddingModel}): ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

interface KnowledgeChunkRow {
  id: string;
  source: string | null;
  team: string | null;
  title: string | null;
  chunk: string | null;
  similarity: number | null;
}

/** Race a promise against the 30s timeout so RPC calls never hang forever. */
function withTimeout<T>(p: PromiseLike<T>): Promise<T> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new RAGError(`Knowledge search timed out after ${TIMEOUT_MS / 1000}s`)),
        TIMEOUT_MS,
      ),
    ),
  ]);
}

function formatChunk(row: KnowledgeChunkRow, index: number): string {
  const meta: string[] = [`دانش ${index + 1}`];
  if (row.title) meta.push(`عنوان: ${row.title}`);
  if (row.team) meta.push(`تیم: ${row.team}`);
  if (row.source) meta.push(`منبع: ${row.source}`);
  const body = (row.chunk ?? '').trim();
  return `[${meta.join(' | ')}]\n${body}`;
}

/**
 * Retrieve the topK most similar knowledge chunks for a query.
 *
 * Returns a Persian context string ready to inject into a team prompt.
 * Returns '' on ANY failure (embedding error, missing RPC, RPC error,
 * timeout, no chunks) so the caller is never blocked.
 */
export async function retrieveKnowledge(
  query: string,
  team: string,
  topK = 5,
): Promise<string> {
  try {
    if (!query.trim()) return '';

    const embedding = await getEmbedding(query);
    const supabase = getSupabase();

    const { data, error } = await withTimeout(
      supabase.rpc('match_knowledge_chunks', {
        query_embedding: embedding,
        match_count: topK,
        filter_team: team.trim() || null,
      }),
    );

    if (error) return '';
    const rows = (data ?? []) as KnowledgeChunkRow[];
    const chunks = rows.filter((r) => (r.chunk ?? '').trim().length > 0);
    if (chunks.length === 0) return '';

    return chunks.map((r, i) => formatChunk(r, i)).join('\n\n');
  } catch {
    // Soft failure by design: no knowledge is better than a blocked team.
    return '';
  }
}
