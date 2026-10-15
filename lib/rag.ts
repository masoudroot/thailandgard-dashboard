/**
 * lib/rag.ts: سرویس خواندن دانش (RAG)، تیم ۲
 *
 * جست‌وجوی معنایی روی جدول `public.knowledge_chunks` در سوپابیس.
 * - `getEmbedding` زنجیره‌ی هوشمند fallback را از `resolveEmbeddingChain()`
 *   (lib/llm-endpoints.ts) می‌خواند: مدل اصلی ← مدل خوب دیگر روی همان API ←
 *   API بعدی. اگر هیچ کاندیدایی جواب نداد خطای فارسی واضح پرتاب می‌کند.
 * - `retrieveKnowledge` کوئری را امبد می‌کند، RPC از پیش ساخته‌شده‌ی
 *   `match_knowledge_chunks` را با فیلتر team صدا می‌زند و N چانک برتر را
 *   به یک رشته‌ی فارسی آماده‌ی تزریق در پرامپت تبدیل می‌کند.
 * - مسیر بازیابی fail-soft است: هر خطایی رشته‌ی خالی برمی‌گرداند تا
 *   فراخواننده هیچ‌وقت مسدود نشود.
 * - `indexKnowledge` دانش تازه را چانک‌بندی و امبد می‌کند و در
 *   `knowledge_chunks` می‌نویسد؛ `deleteKnowledgeIndex` چانک‌های یک دانش
 *   را پاک می‌کند (قرارداد KNOWLEDGE_CONTRACT.md).
 */

import { getSupabase } from './api';
import {
  EXPECTED_EMBEDDING_DIM,
  resolveEmbeddingChain,
  type ResolvedTeamLLM,
} from './llm-endpoints';
import {
  classifyError,
  getCooldownKeys,
  normModelKey,
  recordModelFailure,
  recordModelSuccess,
} from './model-health';

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
/**
 * ساخت بردار امبدینگ برای یک متن با زنجیره‌ی هوشمند fallback.
 *
 * ترتیب تلاش دقیقاً همان منطق درخواستی است:
 *   ۱. مدل اصلی روی endpoint اصلی
 *   ۲. مدل‌های خوب دیگر (۱۵۳۶ بُعدی) روی همان endpoint
 *   ۳. همان مدل اصلی روی endpointهای بعدی (سهمیه‌ی تازه)
 *   ۴. مدل‌های خوب روی endpointهای بعدی
 *
 * طبقه‌بندی خطا:
 *   - 401/403 (کلید مرده): بقیه‌ی مدل‌های همان endpoint رد می‌شوند
 *   - 429/404/408/5xx، تایم‌اوت، خطای شبکه: کاندیدای بعدی
 *   - بُعد نامعتبر بردار: کاندیدای بعدی (جست‌وجوی معنایی فقط با ۱۵۳۶ بُعد کار می‌کند)
 *
 * اگر هیچ کاندیدایی جواب نداد، RAGError پرتاب می‌شود؛ فراخواننده‌های مسیر
 * خواندن (buildKnowledgePromptSection و retrieveKnowledgeChunks) این خطا را
 * می‌گیرند و بدون بخش دانش ادامه می‌دهند تا سیستم هرگز نمیرد.
 */
export async function getEmbedding(text: string): Promise<number[]> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new RAGError('متن خالی است؛ نمی‌توان امبدینگ ساخت.');
  }

  const chain = await resolveEmbeddingChain();
  if (chain.length === 0) {
    throw new RAGError(
      'مدل امبدینگ تنظیم نشده است. از بخش تنظیمات سامانه، یک endpoint و یک مدل امبدینگ انتخاب کنید.',
    );
  }

  // cooldownهای ماندگار: کاندیداهایی که در ران‌های قبلی خطا گرفتند رد می‌شوند
  const dbCooldowns = await getCooldownKeys(chain.map((c) => c.endpointId));

  const failures: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const cfg = chain[i];
    if (dbCooldowns.has(`${cfg.endpointId}::${normModelKey(cfg.model)}`)) {
      failures.push(`${cfg.model} (در استراحت از ران قبلی)`);
      continue;
    }
    const outcome = await tryEmbeddingCandidate(cfg, trimmed);
    if (outcome.ok) {
      await recordModelSuccess(cfg.endpointId, cfg.model);
      return outcome.embedding;
    }
    await recordModelFailure(
      cfg.endpointId,
      cfg.model,
      classifyError(outcome.status ?? outcome.kind),
      outcome.status,
    );
    failures.push(`${cfg.model} (${outcome.status ?? 'خطا'})`);
    console.warn(
      `[embedding] کاندیدای ${i + 1}/${chain.length} ناموفق بود (${cfg.model}): ${outcome.status ?? outcome.kind}؛ تلاش با کاندیدای بعدی.`,
    );
    if (outcome.kind === 'skip-endpoint') {
      // کلید این endpoint مرده است؛ بقیه‌ی مدل‌های همان endpoint را رد کن
      while (i + 1 < chain.length && chain[i + 1].baseUrl === cfg.baseUrl) {
        i++;
      }
    }
  }

  throw new RAGError(
    `همه‌ی مدل‌های امبدینگ ناموفق بودند (${chain.length} کاندیدا): ${failures.slice(0, 4).join('؛ ')}${failures.length > 4 ? '؛ …' : ''}`,
  );
}

/** صادرشده برای تست: نتیجه‌ی تلاش یک کاندیدای امبدینگ. */
export type EmbeddingCandidateOutcome =
  | { ok: true; embedding: number[] }
  | { ok: false; kind: 'next' | 'skip-endpoint'; status?: string };

/** صادرشده برای تست: طبقه‌بندی خطای یک کاندیدا. */
export async function tryEmbeddingCandidate(
  cfg: ResolvedTeamLLM,
  text: string,
): Promise<EmbeddingCandidateOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${cfg.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ model: cfg.model, input: text }),
      signal: controller.signal,
    });

    const body = (await res.json().catch(() => ({}))) as {
      data?: Array<{ embedding?: number[] }>;
      error?: { message?: string };
    };

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return { ok: false, kind: 'skip-endpoint', status: `خطای ${res.status} (کلید)` };
      }
      // 429 سهمیه/ریت‌لیمیت، 404 مدل منسوخ، 408/5xx خطای موقت درگاه
      return { ok: false, kind: 'next', status: `خطای ${res.status}` };
    }

    const embedding = body.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      return { ok: false, kind: 'next', status: 'پاسخ خالی' };
    }
    if (embedding.length !== EXPECTED_EMBEDDING_DIM) {
      return {
        ok: false,
        kind: 'next',
        status: `بُعد نامعتبر (${embedding.length} به‌جای ${EXPECTED_EMBEDDING_DIM})`,
      };
    }
    return { ok: true, embedding };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, kind: 'next', status: 'تایم‌اوت' };
    }
    // خطای شبکه و سایر خطاها: موقت فرض می‌شود
    return { ok: false, kind: 'next', status: 'خطای شبکه' };
  } finally {
    clearTimeout(timeout);
  }
}

interface KnowledgeChunkRow {
  id: string;
  knowledge_id: string | null;
  source: string | null;
  team: string | null;
  title: string | null;
  chunk: string | null;
  similarity: number | null;
  usefulness_score: number | null;
}

/** چانک بازیابی‌شده با شناسه (برای ردیابی استفاده). */
export interface RetrievedChunk {
  id: string;
  knowledgeId: string | null;
  title: string | null;
  chunk: string;
  similarity: number;
  usefulnessScore: number;
  /** تیم مالک چانک (برای فیلتر دانش مشترک؛ داخلی). */
  chunkTeam?: string | null;
  /** دانش نیازمند بازبینی: در پرامپت با برچسب هشدار می‌آید. */
  stale?: boolean;
}

/**
 * آخرین چانک‌های تزریق‌شده به تفکیک تیم.
 * تیم‌ها buildKnowledgePromptSection را صدا می‌زنند؛ ارکستراتور بعد از
 * پایان runTeam با getLastRetrievedChunkIds(team) می‌فهمد چه دانشی استفاده شد.
 */
const lastRetrieval = new Map<string, string[]>();

export function getLastRetrievedChunkIds(team: string): string[] {
  return lastRetrieval.get(team) ?? [];
}

function rememberRetrieval(team: string | undefined, ids: string[]): void {
  if (team) lastRetrieval.set(team, ids);
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

function formatChunk(row: KnowledgeChunkRow, index: number, stale = false): string {
  const meta: string[] = [`دانش ${index + 1}`];
  if (stale) meta.push('هشدار: نیازمند بازبینی');
  if (row.title) meta.push(`عنوان: ${row.title}`);
  if (row.team) meta.push(`تیم: ${row.team}`);
  if (row.source) meta.push(`منبع: ${row.source}`);
  const body = (row.chunk ?? '').trim();
  return `[${meta.join(' | ')}]\n${body}`;
}

/**
 * فیلتر دیده‌شدن دانش (تیم ۱۳):
 * - فقط دانش‌های تازه (`freshness_status = 'fresh'`) از تیم خودی یا تیم‌های
 *   مشترک (`related_teams` شامل تیم جاری) می‌مانند.
 * - دانش آرشیوشده (`archived`) هرگز برنمی‌گردد.
 * - اگر چانک تازه کم آمد، دانش نیازمند بازبینی (`stale`) با پرچم هشدار
 *   به انتهای فهرست اضافه می‌شود.
 *
 * کاملاً fail-soft است: هر خطایی (کوئری، ستون ناموجود، دیتای قدیمی)
 * چانک‌ها را بدون فیلتر برمی‌گرداند تا بازیابی دانش هیچ‌وقت خراب نشود.
 */
async function applyKnowledgeVisibilityFilter(
  chunks: RetrievedChunk[],
  team: string | null,
): Promise<RetrievedChunk[]> {
  try {
    const knowledgeIds = Array.from(
      new Set(chunks.map((c) => c.knowledgeId).filter((id): id is string => !!id)),
    );
    if (knowledgeIds.length === 0) return chunks;

    const supabase = getSupabase();
    const { data, error } = await withTimeout(
      supabase
        .from('team_knowledge')
        .select('id, freshness_status, related_teams')
        .in('id', knowledgeIds),
    );
    if (error) return chunks;

    const visibility = new Map<
      string,
      { freshness: string | null; relatedTeams: string[] }
    >();
    for (const row of (data ?? []) as Array<{
      id: string;
      freshness_status: string | null;
      related_teams: string[] | null;
    }>) {
      visibility.set(row.id, {
        freshness: row.freshness_status ?? null,
        relatedTeams: row.related_teams ?? [],
      });
    }

    const fresh: RetrievedChunk[] = [];
    const stale: RetrievedChunk[] = [];

    for (const chunk of chunks) {
      const parent = chunk.knowledgeId ? visibility.get(chunk.knowledgeId) : undefined;
      // والد نامشخص (دیتای قدیمی یا حذف‌شده): fail-open، مثل رفتار قبلی نمایش بده.
      if (chunk.knowledgeId && !parent) {
        fresh.push(chunk);
        continue;
      }
      // فیلتر تیم: تیم مالک چانک یا یکی از تیم‌های مشترکِ دانش.
      if (team) {
        const ownTeam = chunk.chunkTeam === team;
        const shared = parent?.relatedTeams.includes(team) === true;
        if (!ownTeam && !shared) continue;
      }
      const freshness = parent?.freshness ?? 'fresh';
      if (freshness === 'archived') continue;
      if (freshness === 'stale') {
        stale.push({ ...chunk, stale: true });
      } else {
        fresh.push(chunk);
      }
    }

    return [...fresh, ...stale];
  } catch {
    return chunks;
  }
}

/**
 * جست‌وجوی معنایی ساخت‌یافته: برمی‌گرداند چانک‌ها را با شناسه، شباهت و
 * امتیاز مفید بودن (برای ردیابی استفاده و مرتب‌سازی هوشمند).
 *
 * پارامتر maxAgeDays: فقط چانک‌های تازه‌تر از این تعداد روز (null یعنی بدون فیلتر).
 * مرتب‌سازی نهایی: ترکیب شباهت معنایی و امتیاز مفید بودن؛ اگر RPC قدیمی
 * usefulness_score را برنگرداند، فقط با similarity مرتب می‌شود (سازگار با عقب).
 */
export async function retrieveKnowledgeChunks(
  query: string,
  team?: string,
  limit: number = DEFAULT_LIMIT,
  maxAgeDays: number | null = null,
): Promise<RetrievedChunk[]> {
  try {
    if (!query.trim()) return [];

    const embedding = await getEmbedding(query);
    const supabase = getSupabase();

    const teamFilter = team?.trim() ? team.trim() : null;

    // فیلتر تیم در RPC اعمال نمی‌شود تا دانش مشترک تیم‌های دیگر هم بازیابی
    // شود؛ فیلتر تیم/تازگی/اشتراک سمت کلاینت است (applyKnowledgeVisibilityFilter).
    // match_count بزرگ‌تر می‌خواهیم چون بعد از فیلتر به limit می‌رسیم.
    const rpcParams: Record<string, unknown> = {
      query_embedding: embedding,
      match_count: Math.min(Math.max(limit * 4, 12), 40),
      filter_team: null,
    };
    // اگر RPC جدید max_age_days را پشتیبانی کند، می‌فرستیم؛ وگرنه نادیده گرفته می‌شود
    if (maxAgeDays !== null) rpcParams.max_age_days = maxAgeDays;

    const { data, error } = await withTimeout(
      supabase.rpc('match_knowledge_chunks', rpcParams),
    );

    if (error) return [];
    const rows = (data ?? []) as KnowledgeChunkRow[];
    const chunks = rows.filter((r) => (r.chunk ?? '').trim().length > 0);

    let result: RetrievedChunk[] = chunks.map((r) => ({
      id: r.id,
      knowledgeId: r.knowledge_id ?? null,
      title: r.title ?? null,
      chunk: (r.chunk ?? '').trim(),
      similarity: r.similarity ?? 0,
      usefulnessScore: r.usefulness_score ?? 0,
      chunkTeam: r.team ?? null,
    }));

    // فیلتر دیده‌شدن: فقط دانش تازهٔ تیم خودی یا مشترک؛ کمبود با stale پر می‌شود.
    // fail-soft: در صورت خطا، همان چانک‌های بدون فیلتر برمی‌گردند.
    result = await applyKnowledgeVisibilityFilter(result, teamFilter);

    // مرتب‌سازی سمت کلاینت (اگر RPC قدیمی بود و ترکیب را اعمال نکرد):
    // شباهت ۷۰٪ + امتیاز مفید بودن نرمال‌شده ۳۰٪
    result.sort((a, b) => {
      const scoreA = a.similarity * 0.7 + Math.max(a.usefulnessScore, 0) / 10 * 0.3;
      const scoreB = b.similarity * 0.7 + Math.max(b.usefulnessScore, 0) / 10 * 0.3;
      return scoreB - scoreA;
    });

    result = result.slice(0, limit);

    rememberRetrieval(team, result.map((r) => r.id));
    return result;
  } catch {
    return [];
  }
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
  const chunks = await retrieveKnowledgeChunks(query, team, limit);
  if (chunks.length === 0) return '';
  return chunks
    .map((c, i) =>
      formatChunk(
        {
          id: c.id,
          knowledge_id: c.knowledgeId,
          source: null,
          team: c.chunkTeam ?? team ?? null,
          title: c.title,
          chunk: c.chunk,
          similarity: c.similarity,
          usefulness_score: c.usefulnessScore,
        },
        i,
        c.stale === true,
      ),
    )
    .join('\n\n');
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

/**
 * بخش آمادهٔ پرامپت از دانش یک تیم (تیم ۱۳: اتصال تیم‌ها به دانش).
 *
 * خروجی `getTeamKnowledgeContext` را با سربرگ فارسی قالب‌بندی می‌کند تا
 * تیم‌ها آن را در ابتدای بخش «زمینه»ی پرامپت سرپرست تزریق کنند.
 * اگر دانشی نبود (جدول خالی، امبدینگ تنظیم نشده، خطای درگاه یا هر خطای
 * دیگر) رشتهٔ خالی برمی‌گرداند تا پرامپت تیم دقیقاً مثل قبل بماند.
 * هرگز خطا پرتاب نمی‌کند (best-effort).
 */
export async function buildKnowledgePromptSection(
  team: string,
  task: string,
): Promise<string> {
  try {
    const context = await getTeamKnowledgeContext(team, task);
    const trimmed = context.trim();
    if (!trimmed) return '';
    return [
      `دانش ثبت‌شدهٔ تیم «${team}» (مرجع: هنگام تصمیم‌گیری و اجرا از آن استفاده کن):`,
      trimmed,
    ].join('\n');
  } catch {
    // fail-soft عمدی: نداشتن دانش بهتر از مسدود شدن تیم است.
    return '';
  }
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
  source: string;
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
      source: 'team-lesson',
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

/* ------------------------------------------------------------------ */
/* تیم ۹: ردیابی استفاده از دانش و امتیاز مفید بودن                      */
/* ------------------------------------------------------------------ */

/**
 * ثبت استفاده از چانک‌های دانش در یک اجرای تیم و به‌روزرسانی امتیاز
 * مفید بودن.
 *
 * - `chunkIds`: شناسه‌ی چانک‌هایی که در پرامپت این اجرا تزریق شدند
 *   (از getLastRetrievedChunkIds گرفته می‌شود).
 * - `teamRunId`: ردیف team_runs برای لاگ.
 * - `approved`: اگر خروجی تیم تأیید شد (verdict.approved یا status موفق)،
 *   هر چانک +۱ می‌گیرد؛ وگرنه −۱.
 *
 * best-effort است: هرگز خطا پرتاب نمی‌کند تا اجرای تیم را خراب نکند.
 */
export async function recordKnowledgeUsage(
  chunkIds: string[],
  teamRunId: string,
  approved: boolean,
): Promise<void> {
  try {
    if (chunkIds.length === 0 || !teamRunId) return;
    const supabase = getSupabase();
    const delta = approved ? 1 : -1;
    const now = new Date().toISOString();

    // ۱) لاگ روی team_runs
    await supabase
      .from('team_runs')
      .update({ knowledge_chunk_ids: chunkIds })
      .eq('id', teamRunId);

    // ۲) به‌روزرسانی امتیاز چانک‌ها (تک‌تک تا با RLS و تریگرها سازگار بماند)
    for (const chunkId of chunkIds) {
      const { data: row } = await supabase
        .from('knowledge_chunks')
        .select('usefulness_score, use_count')
        .eq('id', chunkId)
        .maybeSingle();
      if (!row) continue;
      await supabase
        .from('knowledge_chunks')
        .update({
          usefulness_score: (row.usefulness_score ?? 0) + delta,
          use_count: (row.use_count ?? 0) + 1,
          last_used_at: now,
        })
        .eq('id', chunkId);
    }
  } catch {
    // best-effort: خطای ردیابی نباید اجرای تیم را خراب کند
  }
}
