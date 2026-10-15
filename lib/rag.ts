/**
 * lib/rag.ts: سرویس خواندن دانش (RAG)، تیم ۲
 *
 * جست‌وجوی معنایی روی جدول `public.knowledge_chunks` در سوپابیس.
 * - `getEmbedding` پیکربندی امبدینگ را از `resolveEmbeddingConfig()`
 *   (lib/llm-endpoints.ts) می‌خواند، نه از env مستقیم. اگر تنظیم نشده باشد،
 *   خطای فارسی واضح پرتاب می‌کند.
 * - `retrieveKnowledge` کوئری را امبد می‌کند، RPC از پیش ساخته‌شده‌ی
 *   `match_knowledge_chunks` را با فیلتر team صدا می‌زند و N چانک برتر را
 *   به یک رشته‌ی فارسی آماده‌ی تزریق در پرامپت تبدیل می‌کند.
 * - مسیر بازیابی fail-soft است: هر خطایی رشته‌ی خالی برمی‌گرداند تا
 *   فراخواننده هیچ‌وقت مسدود نشود.
 */

import { getSupabase } from './api';
import { resolveEmbeddingConfig } from './llm-endpoints';

/** سقف ۳۰ ثانیه برای همه‌ی فراخوانی‌های خروجی RAG. */
const TIMEOUT_MS = 30_000;
/** تعداد پیش‌فرض چانک در بازیابی دانش. */
const DEFAULT_LIMIT = 5;

export class RAGError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RAGError';
  }
}

/**
 * ساخت بردار امبدینگ برای یک متن از طریق endpoint امبدینگ سازگار با OpenAI.
 *
 * در صورت تنظیم نبودن مدل امبدینگ، متن خالی، خطای درگاه، تایم‌اوت یا
 * پاسخ نامعتبر، RAGError با پیام فارسی پرتاب می‌شود.
 */
export async function getEmbedding(text: string): Promise<number[]> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new RAGError('متن خالی است؛ نمی‌توان امبدینگ ساخت.');
  }

  const cfg = await resolveEmbeddingConfig();
  if (!cfg) {
    throw new RAGError(
      'مدل امبدینگ تنظیم نشده است. از بخش تنظیمات سامانه، یک endpoint و یک مدل امبدینگ انتخاب کنید.',
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${cfg.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ model: cfg.model, input: trimmed }),
      signal: controller.signal,
    });

    const body = (await res.json().catch(() => ({}))) as {
      data?: Array<{ embedding?: number[] }>;
      error?: { message?: string };
    };

    if (!res.ok) {
      const detail = body?.error?.message || `خطای HTTP ${res.status}`;
      throw new RAGError(`خطای درگاه امبدینگ (${cfg.model}): ${detail}`);
    }

    const embedding = body.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new RAGError(`درگاه امبدینگ برداری برنگرداند (${cfg.model}).`);
    }
    return embedding;
  } catch (err) {
    if (err instanceof RAGError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new RAGError(
        `درخواست امبدینگ پس از ${TIMEOUT_MS / 1000} ثانیه بی‌پاسخ ماند (تایم‌اوت).`,
      );
    }
    throw new RAGError(
      `درخواست امبدینگ ناموفق بود: ${err instanceof Error ? err.message : String(err)}`,
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

/** مسابقه‌ی promise با تایم‌اوت ۳۰ ثانیه تا فراخوانی RPC هیچ‌وقت آویزان نماند. */
function withTimeout<T>(p: PromiseLike<T>): Promise<T> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new RAGError(`جست‌وجوی دانش پس از ${TIMEOUT_MS / 1000} ثانیه بی‌پاسخ ماند.`)),
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
 * جست‌وجوی معنایی: امبدینگ کوئری، فراخوانی RPC `match_knowledge_chunks`
 * با فیلتر اختیاری team، و قالب‌بندی `limit` چانک برتر به رشته‌ی فارسی
 * آماده‌ی تزریق در پرامپت.
 *
 * در برابر هر خطایی (تنظیم نبودن امبدینگ، خطای درگاه، خطای RPC، تایم‌اوت،
 * نبود چانک) رشته‌ی خالی برمی‌گرداند تا فراخواننده مسدود نشود.
 */
export async function retrieveKnowledge(
  query: string,
  team?: string,
  limit: number = DEFAULT_LIMIT,
): Promise<string> {
  try {
    if (!query.trim()) return '';

    const embedding = await getEmbedding(query);
    const supabase = getSupabase();

    const teamFilter = team?.trim() ? team.trim() : null;

    const { data, error } = await withTimeout(
      supabase.rpc('match_knowledge_chunks', {
        query_embedding: embedding,
        match_count: limit,
        filter_team: teamFilter,
      }),
    );

    if (error) return '';
    const rows = (data ?? []) as KnowledgeChunkRow[];
    const chunks = rows.filter((r) => (r.chunk ?? '').trim().length > 0);
    if (chunks.length === 0) return '';

    return chunks.map((r, i) => formatChunk(r, i)).join('\n\n');
  } catch {
    // fail-soft عمدی: نداشتن دانش بهتر از مسدود شدن تیم است.
    return '';
  }
}

/**
 * کانتکست دانش آماده برای تزریق در پرامپت یک تیم.
 * همان retrieveKnowledge با حد پیش‌فرض (۵ چانک).
 */
export async function getTeamKnowledgeContext(
  team: string,
  task: string,
): Promise<string> {
  return retrieveKnowledge(task, team, DEFAULT_LIMIT);
}
/* ------------------------------------------------------------------ */
/* تیم ۳: ایندکس دانش (مسیر نوشتن)                                     */
/*                                                                    */
/* برخلاف مسیر خواندن که fail-soft است، مسیر نوشتن fail-hard است:     */
/* هر خطایی RAGError پرتاب می‌شود تا API بداند ایندکس انجام نشده.      */
/* ------------------------------------------------------------------ */

/** هدف هر چانک: حدود ۵۰۰ کلمه. */
const CHUNK_WORD_TARGET = 500;
/** هم‌پوشانی بین چانک‌های پیاپی: حدود ۵۰ کلمه. */
const CHUNK_OVERLAP_WORDS = 50;

/** شمارش کلمه با جداکننده‌ی فاصله (نیم‌فاصله بخشی از کلمه حساب می‌شود). */
function countWords(s: string): number {
  const t = s.trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

/**
 * تقسیم یک پاراگراف به جمله‌ها روی مرز جمله‌های فارسی و انگلیسی.
 * نشانه‌ی پایان جمله: نقطه، ؟، ! یا … که بعدش فاصله یا پایان متن است.
 */
function splitIntoSentences(paragraph: string): string[] {
  const parts = paragraph.split(/(?<=[.؟!…])\s+/);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * چانک‌بندی فارسی‌آگاه:
 * - متن اول به پاراگراف و بعد به جمله می‌شکند؛ برش هرگز وسط جمله نیست.
 * - جمله‌ها تا رسیدن به حدود ۵۰۰ کلمه انباشته می‌شوند.
 * - چانک بعدی با هم‌پوشانی حدود ۵۰ کلمه از انتهای چانک قبلی
 *   (در سطح جمله، نه برش وسط جمله) شروع می‌شود.
 */
function chunkText(content: string): string[] {
  const sentences: string[] = [];
  for (const paragraph of content.split(/\n+/)) {
    const p = paragraph.trim();
    if (!p) continue;
    sentences.push(...splitIntoSentences(p));
  }
  if (sentences.length === 0) return [];

  const chunks: string[] = [];
  let current: string[] = [];
  let words = 0;

  const pushChunk = (): void => {
    if (current.length === 0) return;
    chunks.push(current.join(' '));
  };

  for (const sentence of sentences) {
    if (words >= CHUNK_WORD_TARGET && current.length > 0) {
      pushChunk();
      // هم‌پوشانی: جمله‌های انتهایی چانک قبلی تا سقف ۵۰ کلمه به چانک بعدی می‌روند.
      const carry: string[] = [];
      let carryWords = 0;
      for (let i = current.length - 1; i >= 0 && carryWords < CHUNK_OVERLAP_WORDS; i--) {
        carry.unshift(current[i]);
        carryWords += countWords(current[i]);
      }
      current = carry;
      words = carryWords;
    }
    current.push(sentence);
    words += countWords(sentence);
  }
  pushChunk();
  return chunks;
}

interface KnowledgeChunkInsert {
  knowledge_id: string;
  team: string;
  title: string | null;
  chunk: string;
  embedding: number[];
}

/**
 * ایندکس یک دانش تازه: چانک‌بندی + امبدینگ + درج در knowledge_chunks.
 *
 * - عنوان به ابتدای چانک اول چسبانده می‌شود تا هم متن امبدشده و هم
 *   متن بازیابی‌شده زمینه‌ی عنوان را داشته باشند.
 * - اگر برای این knowledge_id از قبل چانکی هست (ری‌ایندکس)، اول حذف
 *   و بعد درج می‌شود تا چانک تکراری نماند.
 * - ترتیب امن: اول همه‌ی امبدینگ‌ها ساخته می‌شوند؛ اگر امبدینگ خطا
 *   بدهد، هنوز هیچ چانکی حذف یا درج نشده است.
 *
 * در هر خطایی (ورودی نامعتبر، متن خالی، خطای امبدینگ، خطای حذف یا
 * درج) RAGError پرتاب می‌شود.
 */
export async function indexKnowledge(
  knowledgeId: string,
  team: string,
  title: string,
  content: string,
): Promise<void> {
  const id = knowledgeId?.trim();
  if (!id) throw new RAGError('indexKnowledge: شناسه‌ی دانش نامعتبر است.');
  const teamSlug = team?.trim();
  if (!teamSlug) throw new RAGError('indexKnowledge: نام تیم نامعتبر است.');
  const cleanTitle = title?.trim() ?? '';

  const chunks = chunkText(content);
  if (chunks.length === 0) {
    throw new RAGError('indexKnowledge: متن دانش خالی است؛ چیزی برای ایندکس نیست.');
  }

  // مرحله‌ی ۱: ساخت همه‌ی امبدینگ‌ها (بدون هیچ تغییری در دیتابیس).
  const rows: KnowledgeChunkInsert[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const text =
      i === 0 && cleanTitle ? `عنوان: ${cleanTitle}\n\n${chunks[i]}` : chunks[i];
    const embedding = await getEmbedding(text);
    rows.push({
      knowledge_id: id,
      team: teamSlug,
      title: cleanTitle || null,
      chunk: text,
      embedding,
    });
  }

  const supabase = getSupabase();

  // مرحله‌ی ۲: حذف چانک‌های قبلی این دانش (برای ری‌ایندکسِ تمیز).
  const { error: delError } = await withTimeout(
    supabase.from('knowledge_chunks').delete().eq('knowledge_id', id),
  );
  if (delError) {
    throw new RAGError(`indexKnowledge: حذف چانک‌های قبلی ناموفق بود: ${delError.message}`);
  }

  // مرحله‌ی ۳: درج چانک‌های تازه.
  const { error: insError } = await withTimeout(
    supabase.from('knowledge_chunks').insert(rows),
  );
  if (insError) {
    throw new RAGError(`indexKnowledge: درج چانک‌ها ناموفق بود: ${insError.message}`);
  }
}

/**
 * حذف همه‌ی چانک‌های یک دانش از ایندکس (knowledge_id).
 * در صورت خطا RAGError پرتاب می‌شود (مسیر نوشتن fail-hard است).
 */
export async function deleteKnowledgeIndex(knowledgeId: string): Promise<void> {
  const id = knowledgeId?.trim();
  if (!id) throw new RAGError('deleteKnowledgeIndex: شناسه‌ی دانش نامعتبر است.');

  const supabase = getSupabase();
  const { error } = await withTimeout(
    supabase.from('knowledge_chunks').delete().eq('knowledge_id', id),
  );
  if (error) {
    throw new RAGError(`deleteKnowledgeIndex: حذف ایندکس ناموفق بود: ${error.message}`);
  }
}
