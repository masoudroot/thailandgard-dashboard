/**
 * POST /api/manager/knowledge: ثبت دانش جدید برای یک تیم از طریق API مدیر.
 * ورودی: { team, title, content }
 */
import { fail, ok } from '../../../../lib/api';
import { requireManagerAuth } from '../../../../lib/manager-auth';
import { indexKnowledge } from '../../../../lib/rag';

export async function POST(request: Request): Promise<Response> {
  const auth = await requireManagerAuth(request);
  if (auth instanceof Response) return auth;
  try {
    const body = (await request.json().catch(() => ({}))) as {
      team?: string;
      title?: string;
      content?: string;
    };
    const team = body.team?.trim();
    const title = body.title?.trim() ?? '';
    const content = body.content?.trim() ?? '';
    if (!team) return fail('تیم لازم است.', 400);
    if (!content) return fail('متن دانش لازم است.', 400);
    const knowledgeId = `manager-${team}-${Date.now()}`;
    await indexKnowledge(knowledgeId, team, title, content);
    return ok({ knowledge_id: knowledgeId });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
