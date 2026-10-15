import { NextRequest } from 'next/server';
import { ok, fail, getSupabase } from '@/lib/api';
import { formatJalali } from '@/lib/jalali';

/** نگاشت کد action به برچسب فارسی. */
const ACTION_FA: Record<string, string> = {
  create: 'ساخته شد',
  update: 'ویرایش شد',
  delete: 'حذف شد',
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type KnowledgeVersion = {
  id: string;
  action: 'create' | 'update' | 'delete' | string;
  actionFa: string;
  title: string;
  content: string;
  created_at: string;
  dateFa: string;
};

/**
 * GET /api/knowledge/[id]/history
 * فهرست نسخه‌های یک دانش، از جدید به قدیم.
 * خواندن صرف است؛ ثبت نسخه‌ها با تیم ۱۱ است.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const id = params.id?.trim() ?? '';
  if (!UUID_RE.test(id)) {
    return fail('شناسهٔ دانش نامعتبر است.', 400);
  }

  let supabase;
  try {
    supabase = getSupabase();
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'خطای اتصال به دیتابیس.');
  }

  try {
    const { data, error } = await supabase
      .from('knowledge_history')
      .select('id, action, title, content, created_at')
      .eq('knowledge_id', id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const versions: KnowledgeVersion[] = (data ?? []).map((row) => ({
      id: row.id,
      action: row.action,
      actionFa: ACTION_FA[row.action] ?? row.action,
      title: row.title,
      content: row.content,
      created_at: row.created_at,
      dateFa: formatJalali(new Date(row.created_at), { weekday: true }),
    }));

    return ok({ knowledge_id: id, versions });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'خطای خواندن تاریخچه.';
    // جدول هنوز ساخته نشده باشد، تاریخچهٔ خالی برمی‌گردانیم
    if (/relation .* does not exist|PGRST205/i.test(message)) {
      return ok({ knowledge_id: id, versions: [] as KnowledgeVersion[] });
    }
    return fail(message);
  }
}
