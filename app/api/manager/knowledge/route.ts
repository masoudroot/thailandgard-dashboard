/**
 * POST /api/manager/knowledge: ثبت دانش جدید برای یک تیم از طریق API مدیر.
 * ورودی: { team, title, content }
 */
import { fail, getSupabase, ok } from '../../../../lib/api';
import { requireManagerAuth } from '../../../../lib/manager-auth';
import { indexKnowledge, RAGError } from '../../../../lib/rag';

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

    // اول رکورد والد در team_knowledge، بعد ایندکس RAG
    const supabase = getSupabase();
    const { data: item, error } = await supabase
      .from('team_knowledge')
      .insert({ team, title: title || content.slice(0, 80), content, source: 'manager' })
      .select('id')
      .single();
    if (error || !item) {
      return fail(`ثبت دانش ناموفق بود: ${error?.message ?? 'خطای ناشناخته'}`, 500);
    }
    try {
      await indexKnowledge(item.id, team, title, content);
    } catch (err) {
      const msg = err instanceof RAGError ? err.message : 'ایندکس معنایی انجام نشد.';
      return ok({ knowledge_id: item.id, warning: msg });
    }
    return ok({ knowledge_id: item.id });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
