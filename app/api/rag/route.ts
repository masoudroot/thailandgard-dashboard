import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api';
import { retrieveKnowledge } from '@/lib/rag';

/**
 * POST /api/rag: test endpoint for the RAG service.
 * Body: { query: string, team?: string, topK?: number }
 * (Auth is enforced by middleware; the session cookie is required.)
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: { query?: unknown; team?: unknown; topK?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail('درخواست نامعتبر است.', 400);
  }

  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) {
    return fail('query الزامی است.', 400);
  }

  const team = typeof body.team === 'string' ? body.team.trim() : '';
  const topK =
    typeof body.topK === 'number' && Number.isFinite(body.topK)
      ? Math.min(Math.max(Math.floor(body.topK), 1), 20)
      : 5;

  const context = await retrieveKnowledge(query, team, topK);

  return ok({
    context,
    chunks: context ? context.split('\n\n').length : 0,
    team: team || null,
    topK,
  });
}
