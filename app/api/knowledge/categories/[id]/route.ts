import { NextRequest } from 'next/server';
import { ok, fail, getSupabase } from '@/lib/api';

/**
 * DELETE /api/knowledge/categories/[id]: حذف یک دسته.
 *
 * رفتار حذف (طبق محدودیت‌های اسکیمای قرارداد):
 * - آیتم‌های دانش دستهٔ حذف‌شده بی‌دسته می‌شوند (category_id با on delete set null خالی می‌شود).
 * - فرزندان دسته به‌صورت آبشاری حذف می‌شوند (parent_id با on delete cascade)،
 *   و آیتم‌های آن‌ها هم بی‌دسته می‌شوند.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const id = params.id;

  try {
    const sb = getSupabase();

    const { data: category, error: getErr } = await sb
      .from('knowledge_categories')
      .select('id,team,name')
      .eq('id', id)
      .maybeSingle();
    if (getErr) return fail(`خواندن دسته ناموفق بود: ${getErr.message}`);
    if (!category) return fail('دسته پیدا نشد.', 404);

    // شمارش نوادگان برای گزارش، قبل از حذف آبشاری
    const { data: all, error: allErr } = await sb
      .from('knowledge_categories')
      .select('id,parent_id')
      .eq('team', category.team);
    if (allErr) return fail(`خواندن دسته‌ها ناموفق بود: ${allErr.message}`);

    const children = new Map<string, string[]>();
    for (const row of (all ?? []) as { id: string; parent_id: string | null }[]) {
      if (row.parent_id) {
        const list = children.get(row.parent_id) ?? [];
        list.push(row.id);
        children.set(row.parent_id, list);
      }
    }
    let cascaded = 0;
    const stack = [...(children.get(id) ?? [])];
    while (stack.length > 0) {
      const current = stack.pop()!;
      cascaded += 1;
      stack.push(...(children.get(current) ?? []));
    }

    const { error: delErr } = await sb.from('knowledge_categories').delete().eq('id', id);
    if (delErr) return fail(`حذف دسته ناموفق بود: ${delErr.message}`);

    return ok({ deleted: true, id, cascaded });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
