import { NextRequest } from 'next/server';
import { ok, fail, getSupabase } from '@/lib/api';
import { TEAM_META } from '@/lib/team-meta';
import type { TeamName } from '@/lib/types';
import {
  TEAM_SLUGS,
  isValidTeam,
  recordHistory,
  tryIndexKnowledge,
} from '@/lib/knowledge';

interface TeamStat {
  team: TeamName;
  faName: string;
  count: number;
  categoryCount: number;
  lastUpdated: string | null;
  score: number | null;
}

/**
 * GET /api/knowledge: آمار دانش هر ۱۵ تیم.
 * خروجی: { ok, data: { teams: [{ team, faName, count, categoryCount, lastUpdated, score }] } }
 * امتیاز هنوز توسط تیم ۱۴ ساخته نشده، پس score همیشه null است.
 */
export async function GET(): Promise<Response> {
  try {
    const sb = getSupabase();

    const { data: items, error: itemsErr } = await sb
      .from('team_knowledge')
      .select('team,updated_at');
    if (itemsErr) return fail(`خواندن دانش تیم‌ها ناموفق بود: ${itemsErr.message}`);

    const { data: cats, error: catsErr } = await sb
      .from('knowledge_categories')
      .select('team');
    if (catsErr) return fail(`خواندن دسته‌ها ناموفق بود: ${catsErr.message}`);

    const counts = new Map<string, number>();
    const catCounts = new Map<string, number>();
    const latest = new Map<string, string>();
    for (const row of (items ?? []) as { team: string; updated_at: string }[]) {
      counts.set(row.team, (counts.get(row.team) ?? 0) + 1);
      const prev = latest.get(row.team);
      if (!prev || row.updated_at > prev) latest.set(row.team, row.updated_at);
    }
    for (const row of (cats ?? []) as { team: string }[]) {
      catCounts.set(row.team, (catCounts.get(row.team) ?? 0) + 1);
    }

    const teams: TeamStat[] = TEAM_SLUGS.map((team) => ({
      team,
      faName: TEAM_META[team].faName,
      count: counts.get(team) ?? 0,
      categoryCount: catCounts.get(team) ?? 0,
      lastUpdated: latest.get(team) ?? null,
      score: null,
    }));

    return ok({ teams });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

interface CreateBody {
  team?: unknown;
  title?: unknown;
  content?: unknown;
  category_id?: unknown;
  source?: unknown;
}

/**
 * POST /api/knowledge: ساخت دانش تازه.
 * بدنه: { team, title, content, category_id?, source? }
 * ساخت + ثبت history با action=create + ایندکس RAG (اگر indexKnowledge آماده بود).
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: CreateBody;
  try {
    body = await request.json();
  } catch {
    return fail('بدنه درخواست نامعتبر است.', 400);
  }

  const team = typeof body.team === 'string' ? body.team.trim() : '';
  if (!isValidTeam(team)) {
    return fail('تیم نامعتبر است.', 400);
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!title || !content) {
    return fail('عنوان و متن دانش الزامی است.', 400);
  }
  const categoryId =
    typeof body.category_id === 'string' && body.category_id.trim()
      ? body.category_id.trim()
      : null;
  const source =
    typeof body.source === 'string' && body.source.trim()
      ? body.source.trim()
      : null;

  try {
    const sb = getSupabase();

    if (categoryId) {
      const { data: cat, error: catErr } = await sb
        .from('knowledge_categories')
        .select('id,team')
        .eq('id', categoryId)
        .maybeSingle();
      if (catErr) return fail(`بررسی دسته ناموفق بود: ${catErr.message}`);
      if (!cat || cat.team !== team) {
        return fail('دسته انتخاب‌شده برای این تیم وجود ندارد.', 400);
      }
    }

    const { data: item, error } = await sb
      .from('team_knowledge')
      .insert({ team, title, content, category_id: categoryId, source })
      .select()
      .single();
    if (error) return fail(`ساخت دانش ناموفق بود: ${error.message}`);

    await recordHistory(sb, {
      knowledge_id: item.id,
      team,
      title,
      content,
      action: 'create',
    });

    const indexed = await tryIndexKnowledge(item.id, team, title, content);

    return ok({ item, indexed }, 201);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
