/**
 * POST /api/manager/knowledge/sources — افزودن منبع دانش جدید برای یک تیم.
 * ورودی: { name, url, team, type, authority, refresh_interval, is_active?, notes? }
 */
import { fail, getSupabase, ok } from '../../../../../lib/api';
import { requireManagerAuth } from '../../../../../lib/manager-auth';
import {
  toSourceResponse,
  validateSourceInput,
  type SourceInput,
} from '../../../../../lib/knowledge-sources';

export async function POST(request: Request): Promise<Response> {
  const auth = await requireManagerAuth(request);
  if (auth instanceof Response) return auth;
  try {
    const body = (await request.json().catch(() => ({}))) as SourceInput;
    const validated = validateSourceInput(body);
    if (!validated.ok) return fail(validated.error, 400);

    const sb = getSupabase();
    const { data, error } = await sb
      .from('knowledge_sources')
      .insert({
        team: validated.value.team,
        url: validated.value.url,
        title: validated.value.title,
        source_type: validated.value.source_type,
        authority_tier: validated.value.authority_tier,
        fetch_frequency_hours: validated.value.fetch_frequency_hours,
        is_active: validated.value.is_active ?? true,
        notes: validated.value.notes ?? null,
      })
      .select('*')
      .single();
    if (error || !data) {
      // یکتایی (team, url)
      if (error?.code === '23505') {
        return fail('این نشانی قبلاً برای این تیم ثبت شده است.', 409);
      }
      return fail(`ثبت منبع ناموفق بود: ${error?.message ?? 'خطای ناشناخته'}`, 500);
    }
    return ok({ source: toSourceResponse(data, 0) }, 201);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
