import { NextRequest } from 'next/server';
import { ok, fail, getSupabase } from '@/lib/api';
import { TEAM_META } from '@/lib/team-meta';
import {
  isValidTeam,
  isKnowledgeId,
  makeSnippet,
  recordHistory,
  tryIndexKnowledge,
  tryDeleteKnowledgeIndex,
} from '@/lib/knowledge';

interface KnowledgeItem {
  id: string;
  title: string;
  content: string;
  category_id: string | null;
  source: string | null;
  updated_at: string;
}

interface Category {
  id: string;
  name: string;
  parent_id: string | null;
}

/**
 * GET /api/knowledge/[team]: دانش یک تیم با درخت دسته‌ها.
 * خروجی: { ok, data: { team, faName, mission,
 *   categories: [{ id, name, parent_id, items: [{ id, title, snippet, source, updated_at }] }],
 *   uncategorized: [...] } }
 * slug نامعتبر: ۴۰۰ با پیام فارسی.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const team = params.id;
  if (!isValidTeam(team)) {
    return fail('تیم نامعتبر است.', 400);
  }

  try {
    const sb = getSupabase();

    const { data: cats, error: catsErr } = await sb
      .from('knowledge_categories')
      .select('id,name,parent_id')
      .eq('team', team)
      .order('name', { ascending: true });
    if (catsErr) return fail(`خواندن دسته‌ها ناموفق بود: ${catsErr.message}`);

    const { data: items, error: itemsErr } = await sb
      .from('team_knowledge')
      .select('id,title,content,category_id,source,updated_at')
      .eq('team', team)
      .order('updated_at', { ascending: false });
    if (itemsErr) return fail(`خواندن دانش تیم ناموفق بود: ${itemsErr.message}`);

    const categories = ((cats ?? []) as Category[]).map((cat) => ({
      id: cat.id,
      name: cat.name,
      parent_id: cat.parent_id,
      items: ((items ?? []) as KnowledgeItem[])
        .filter((it) => it.category_id === cat.id)
        .map((it) => ({
          id: it.id,
          title: it.title,
          snippet: makeSnippet(it.content),
          source: it.source,
          updated_at: it.updated_at,
        })),
    }));
    // دسته‌های ریشه اول، بعد فرزندان بعد از والد خودشان
    const byId = new Map(categories.map((c) => [c.id, c]));
    const ordered: typeof categories = [];
    for (const c of categories) if (!c.parent_id || !byId.has(c.parent_id)) ordered.push(c);
    for (const c of categories) {
      if (c.parent_id && byId.has(c.parent_id) && !ordered.includes(c)) {
        const idx = ordered.indexOf(byId.get(c.parent_id)!);
        ordered.splice(idx + 1, 0, c);
      }
    }

    const uncategorized = ((items ?? []) as KnowledgeItem[])
      .filter((it) => !it.category_id)
      .map((it) => ({
        id: it.id,
        title: it.title,
        snippet: makeSnippet(it.content),
        source: it.source,
        updated_at: it.updated_at,
      }));

    return ok({
      team,
      faName: TEAM_META[team].faName,
      mission: TEAM_META[team].mission,
      categories: ordered,
      uncategorized,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

interface UpdateBody {
  title?: unknown;
  content?: unknown;
  category_id?: unknown;
  source?: unknown;
}

/**
 * PUT /api/knowledge/[id]: ویرایش دانش.
 * بدنه: هر ترکیبی از { title, content, category_id (یا null برای بی‌دسته), source }.
 * ویرایش + ثبت history با action=update + ری‌ایندکس RAG.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const id = params.id;
  if (!isKnowledgeId(id)) {
    return fail('شناسه دانش نامعتبر است.', 400);
  }

  let body: UpdateBody;
  try {
    body = await request.json();
  } catch {
    return fail('بدنه درخواست نامعتبر است.', 400);
  }

  const patch: {
    title?: string;
    content?: string;
    category_id?: string | null;
    source?: string | null;
  } = {};
  if (typeof body.title === 'string') {
    const title = body.title.trim();
    if (!title) return fail('عنوان نمی‌تواند خالی باشد.', 400);
    patch.title = title;
  }
  if (typeof body.content === 'string') {
    const content = body.content.trim();
    if (!content) return fail('متن دانش نمی‌تواند خالی باشد.', 400);
    patch.content = content;
  }
  if ('category_id' in body) {
    patch.category_id =
      typeof body.category_id === 'string' && body.category_id.trim()
        ? body.category_id.trim()
        : null;
  }
  if ('source' in body) {
    patch.source =
      typeof body.source === 'string' && body.source.trim()
        ? body.source.trim()
        : null;
  }
  if (Object.keys(patch).length === 0) {
    return fail('هیچ فیلدی برای ویرایش فرستاده نشده است.', 400);
  }

  try {
    const sb = getSupabase();

    const { data: existing, error: getErr } = await sb
      .from('team_knowledge')
      .select('id,team,title,content')
      .eq('id', id)
      .maybeSingle();
    if (getErr) return fail(`خواندن دانش ناموفق بود: ${getErr.message}`);
    if (!existing) return fail('دانش پیدا نشد.', 404);

    if (patch.category_id) {
      const { data: cat, error: catErr } = await sb
        .from('knowledge_categories')
        .select('id,team')
        .eq('id', patch.category_id)
        .maybeSingle();
      if (catErr) return fail(`بررسی دسته ناموفق بود: ${catErr.message}`);
      if (!cat || cat.team !== existing.team) {
        return fail('دسته انتخاب‌شده برای این تیم وجود ندارد.', 400);
      }
    }

    const { data: item, error: updErr } = await sb
      .from('team_knowledge')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (updErr) return fail(`ویرایش دانش ناموفق بود: ${updErr.message}`);

    await recordHistory(sb, {
      knowledge_id: id,
      team: existing.team,
      title: item.title,
      content: item.content,
      action: 'update',
    });

    const indexed = await tryIndexKnowledge(id, existing.team, item.title, item.content);

    return ok({ item, indexed });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * DELETE /api/knowledge/[id]: حذف دانش.
 * ثبت history با action=delete از اسنپ‌شات قبل از حذف + حذف ایندکس RAG.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const id = params.id;
  if (!isKnowledgeId(id)) {
    return fail('شناسه دانش نامعتبر است.', 400);
  }

  try {
    const sb = getSupabase();

    const { data: existing, error: getErr } = await sb
      .from('team_knowledge')
      .select('id,team,title,content')
      .eq('id', id)
      .maybeSingle();
    if (getErr) return fail(`خواندن دانش ناموفق بود: ${getErr.message}`);
    if (!existing) return fail('دانش پیدا نشد.', 404);

    await recordHistory(sb, {
      knowledge_id: id,
      team: existing.team,
      title: existing.title,
      content: existing.content,
      action: 'delete',
    });

    const { error: delErr } = await sb.from('team_knowledge').delete().eq('id', id);
    if (delErr) return fail(`حذف دانش ناموفق بود: ${delErr.message}`);

    const deindexed = await tryDeleteKnowledgeIndex(id);

    return ok({ deleted: true, deindexed });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
