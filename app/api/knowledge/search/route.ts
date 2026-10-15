import { NextRequest } from 'next/server';
import { ok, fail, getSupabase } from '@/lib/api';
import { getEmbedding, RAGError } from '@/lib/rag';
import { TEAM_META } from '@/lib/team-meta';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const SNIPPET_LEN = 120;
const RPC_TIMEOUT_MS = 30_000;

interface ChunkRow {
  id: string;
  team: string | null;
  title: string | null;
  chunk: string | null;
  similarity: number | null;
}

function withTimeout<T>(p: PromiseLike<T>): Promise<T> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new RAGError(`جست‌وجو بیش از ${RPC_TIMEOUT_MS / 1000} ثانیه طول کشید.`)),
        RPC_TIMEOUT_MS,
      ),
    ),
  ]);
}

/**
 * POST /api/knowledge/search
 * Body: { query: string, team?: string, limit?: number }
 * → { ok, data: { results: [{ id, team, title, snippet, score }] } }
 *
 * احراز ادمین توسط میان‌افزار موجود انجام می‌شود.
 * اگر سرویس RAG یا کلید امبدینگ در دسترس نباشد، ۵۰۳ با پیام فارسی واضح برمی‌گرداند.
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: { query?: unknown; team?: unknown; limit?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail('بدنه درخواست نامعتبر است.', 400);
  }

  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (query.length < 2) {
    return fail('متن جست‌وجو باید دست‌کم ۲ کاراکتر باشد.', 400);
  }

  let team: string | null = null;
  if (body.team !== undefined && body.team !== null && body.team !== '') {
    if (typeof body.team !== 'string' || !(body.team.trim() in TEAM_META)) {
      return fail('تیم نامعتبر است.', 400);
    }
    team = body.team.trim();
  }

  let limit = DEFAULT_LIMIT;
  if (body.limit !== undefined && body.limit !== null) {
    if (typeof body.limit !== 'number' || !Number.isFinite(body.limit)) {
      return fail('limit باید عدد باشد.', 400);
    }
    limit = Math.min(Math.max(Math.floor(body.limit), 1), MAX_LIMIT);
  }

  try {
    const embedding = await getEmbedding(query);
    const supabase = getSupabase();

    const { data, error } = await withTimeout(
      supabase.rpc('match_knowledge_chunks', {
        query_embedding: embedding,
        match_count: limit,
        filter_team: team,
      }),
    );

    if (error) {
      throw new RAGError(`خطای دیتابیس در جست‌وجو: ${error.message}`);
    }

    const rows = ((data ?? []) as ChunkRow[]).filter((r) => (r.chunk ?? '').trim().length > 0);

    return ok({
      results: rows.map((r) => ({
        id: r.id,
        team: r.team,
        title: r.title,
        snippet: (r.chunk ?? '').trim().slice(0, SNIPPET_LEN),
        score: r.similarity,
      })),
    });
  } catch (err) {
    if (err instanceof RAGError) {
      return fail(`جست‌وجوی معنایی در دسترس نیست: ${err.message}`, 503);
    }
    return fail('خطای غیرمنتظره در جست‌وجو.', 500);
  }
}
