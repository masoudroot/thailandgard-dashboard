import { NextRequest } from 'next/server';
import { ok, fail, getSupabase } from '@/lib/api';
import { isValidTeam } from '@/lib/knowledge';

/**
 * GET /api/knowledge/categories: فهرست دسته‌های یک تیم (اختیاری ?team=slug).
 * خروجی: { ok, data: { categories: [{ id, team, name, parent_id, created_at }] } }
 */
export async function GET(request: NextRequest): Promise<Response> {
  const team = request.nextUrl.searchParams.get('team')?.trim() ?? '';
  if (team && !isValidTeam(team)) {
    return fail('تیم نامعتبر است.', 400);
  }

  try {
    const sb = getSupabase();
    let query = sb
      .from('knowledge_categories')
      .select('id,team,name,parent_id,created_at')
      .order('name', { ascending: true });
    if (team) query = query.eq('team', team);

    const { data, error } = await query;
    if (error) return fail(`خواندن دسته‌ها ناموفق بود: ${error.message}`);

    return ok({ categories: data ?? [] });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

interface CreateCategoryBody {
  team?: unknown;
  name?: unknown;
  parent_id?: unknown;
}

/**
 * POST /api/knowledge/categories: ساخت دسته تازه.
 * بدنه: { team, name, parent_id? }
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: CreateCategoryBody;
  try {
    body = await request.json();
  } catch {
    return fail('بدنه درخواست نامعتبر است.', 400);
  }

  const team = typeof body.team === 'string' ? body.team.trim() : '';
  if (!isValidTeam(team)) {
    return fail('تیم نامعتبر است.', 400);
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return fail('نام دسته الزامی است.', 400);
  }
  const parentId =
    typeof body.parent_id === 'string' && body.parent_id.trim()
      ? body.parent_id.trim()
      : null;

  try {
    const sb = getSupabase();

    if (parentId) {
      const { data: parent, error: parentErr } = await sb
        .from('knowledge_categories')
        .select('id,team')
        .eq('id', parentId)
        .maybeSingle();
      if (parentErr) return fail(`بررسی دسته والد ناموفق بود: ${parentErr.message}`);
      if (!parent || parent.team !== team) {
        return fail('دسته والد برای این تیم وجود ندارد.', 400);
      }
    }

    const { data: category, error } = await sb
      .from('knowledge_categories')
      .insert({ team, name, parent_id: parentId })
      .select()
      .single();
    if (error) return fail(`ساخت دسته ناموفق بود: ${error.message}`);

    return ok({ category }, 201);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
