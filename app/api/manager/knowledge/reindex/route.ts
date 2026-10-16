/**
 * /api/manager/knowledge/reindex — ری‌ایندکس دستی دانش‌ها (تیم ۳، رفع ریشه‌ای مشکل ۳).
 *
 * زمینه: مایگریشن 20261016070000 جدول knowledge_chunks را خالی کرد و وعده‌ی
 * «اسکریپت ری‌ایندکس» داد، ولی آن اسکریپت هرگز ساخته نشد؛ به همین دلیل ۱۳۵ ران
 * بدون حتی یک چانک ایندکس‌شده گذشت. این روت همان حلقه‌ی گمشده است.
 *
 * GET: تصویر سلامت ایندکس (شمارنده‌ها + دانش‌های بدون ایندکس + رویدادهای اخیر).
 * POST { all?: boolean }: ایندکس مجدد دانش‌ها؛ پیش‌فرض فقط دانش‌های بدون چانک،
 *   با all=true همه‌ی دانش‌ها. هر نتیجه در سلامت مسیر ثبت می‌شود، پس اگر
 *   ایندکس دسته‌جمعی هم بمیرد، این بار همه می‌فهمند.
 */
import { fail, getSupabase, ok } from '../../../../../lib/api';
import { requireManagerAuth } from '../../../../../lib/manager-auth';
import { indexKnowledge } from '../../../../../lib/rag';
import {
  getRagIndexHealth,
  reportIndexOutcome,
} from '../../../../../lib/rag-index-health';

export async function GET(request: Request) {
  const auth = await requireManagerAuth(request);
  if (auth instanceof Response) return auth;
  const snapshot = await getRagIndexHealth(20);
  if (!snapshot) return fail('خواندن وضعیت سلامت ایندکس ناموفق بود.', 500);
  return ok(snapshot);
}

interface ReindexBody {
  all?: boolean;
}

export async function POST(request: Request) {
  const auth = await requireManagerAuth(request);
  if (auth instanceof Response) return auth;

  const body = (await request.json().catch(() => ({}))) as ReindexBody;
  const reindexAll = body.all === true;

  const sb = getSupabase();

  // دانش‌های هدف: پیش‌فرض فقط آن‌هایی که هیچ چانکی ندارند.
  const { data: knowledge, error } = await sb
    .from('team_knowledge')
    .select('id, team, title, content')
    .order('created_at', { ascending: true });
  if (error || !knowledge) {
    return fail(`خواندن دانش‌ها ناموفق بود: ${error?.message ?? 'خطای نامشخص'}`, 500);
  }

  let targets = knowledge as Array<{
    id: string;
    team: string;
    title: string;
    content: string;
  }>;

  if (!reindexAll) {
    const { data: chunked } = await sb
      .from('knowledge_chunks')
      .select('knowledge_id');
    const hasChunk = new Set(
      ((chunked ?? []) as Array<{ knowledge_id: string | null }>)
        .map((c) => c.knowledge_id)
        .filter((id): id is string => !!id),
    );
    targets = targets.filter((k) => !hasChunk.has(k.id));
  }

  let indexed = 0;
  const failures: Array<{ id: string; error: string }> = [];

  // ترتیبی (نه موازی) تا به سهمیه‌ی امبدینگ فشار نیاید.
  for (const k of targets) {
    try {
      await indexKnowledge(k.id, k.team, k.title, k.content);
      indexed++;
      await reportIndexOutcome({
        knowledgeId: k.id,
        team: k.team,
        ok: true,
        source: 'api/manager/knowledge/reindex',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ id: k.id, error: message });
      await reportIndexOutcome({
        knowledgeId: k.id,
        team: k.team,
        ok: false,
        error: message,
        source: 'api/manager/knowledge/reindex',
      });
    }
  }

  return ok({
    total: targets.length,
    indexed,
    failed: failures.length,
    failures: failures.slice(0, 20),
  });
}
