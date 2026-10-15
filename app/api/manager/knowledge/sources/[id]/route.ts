/**
 * PATCH /api/manager/knowledge/sources/[id] — ویرایش منبع (همه فیلدها اختیاری).
 * DELETE /api/manager/knowledge/sources/[id] — حذف منبع.
 * نکته: رکوردهای دانش استخراج‌شده حذف نمی‌شوند؛ فقط بازخوانی بعدی متوقف می‌شود.
 */
import { fail, getSupabase, ok } from '../../../../../../lib/api';
import { requireManagerAuth } from '../../../../../../lib/manager-auth';
import {
  isUuid,
  toSourceResponse,
  validateSourceInput,
  type SourceInput,
} from '../../../../../../lib/knowledge-sources';

async function getSource(sb: ReturnType<typeof getSupabase>, id: string) {
  const { data, error } = await sb.from('knowledge_sources').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function countRecords(sb: ReturnType<typeof getSupabase>, id: string): Promise<number> {
  const { count } = await sb
    .from('team_knowledge')
    .select('id', { count: 'exact', head: true })
    .eq('source_id', id);
  return count ?? 0;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireManagerAuth(request);
  if (auth instanceof Response) return auth;
  try {
    const { id } = await params;
    if (!isUuid(id)) return fail('شناسه منبع نامعتبر است.', 400);

    const sb = getSupabase();
    const existing = await getSource(sb, id);
    if (!existing) return fail('منبع پیدا نشد.', 404);

    const body = (await request.json().catch(() => ({}))) as SourceInput;
    const validated = validateSourceInput(body, true);
    if (!validated.ok) return fail(validated.error, 400);
    if (Object.keys(validated.value).length === 0) {
      return fail('هیچ فیلدی برای ویرایش داده نشد.', 400);
    }

    const patch: Record<string, unknown> = { ...validated.value };
    const { data, error } = await sb
      .from('knowledge_sources')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single();
    if (error || !data) {
      if (error?.code === '23505') {
        return fail('این نشانی قبلاً برای این تیم ثبت شده است.', 409);
      }
      return fail(`ویرایش منبع ناموفق بود: ${error?.message ?? 'خطای ناشناخته'}`, 500);
    }
    return ok({ source: toSourceResponse(data, await countRecords(sb, id)) });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireManagerAuth(request);
  if (auth instanceof Response) return auth;
  try {
    const { id } = await params;
    if (!isUuid(id)) return fail('شناسه منبع نامعتبر است.', 400);

    const sb = getSupabase();
    const existing = await getSource(sb, id);
    if (!existing) return fail('منبع پیدا نشد.', 404);

    const { error } = await sb.from('knowledge_sources').delete().eq('id', id);
    if (error) return fail(`حذف منبع ناموفق بود: ${error.message}`, 500);
    return ok({ deleted: id });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
