/**
 * POST /api/manager/knowledge/sources/[id]/refresh — بازخوانی دستی منبع.
 * صفحه را می‌گیرد، اگر محتوای تازه‌ای داشت یک رکورد دانش می‌سازد و ایندکس RAG می‌کند.
 * تکراریِ دقیق (هش محتوا) ذخیره نمی‌شود.
 */
import { fail, getSupabase, ok } from '../../../../../../../lib/api';
import { requireManagerAuth } from '../../../../../../../lib/manager-auth';
import { indexKnowledge, RAGError } from '../../../../../../../lib/rag';
import {
  contentHash,
  fetchPageText,
  isUuid,
} from '../../../../../../../lib/knowledge-sources';

const MIN_TEXT_LENGTH = 200;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireManagerAuth(request);
  if (auth instanceof Response) return auth;
  try {
    const { id } = await params;
    if (!isUuid(id)) return fail('شناسه منبع نامعتبر است.', 400);

    const sb = getSupabase();
    const { data: source, error } = await sb
      .from('knowledge_sources')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) return fail(error.message, 500);
    if (!source) return fail('منبع پیدا نشد.', 404);

    const markFetch = async (status: 'ok' | 'failed', errMsg: string | null) => {
      await sb
        .from('knowledge_sources')
        .update({
          last_fetched_at: new Date().toISOString(),
          last_fetch_status: status,
          last_fetch_error: errMsg,
        })
        .eq('id', id);
    };

    // ۱. دریافت صفحه
    const fetched = await fetchPageText(source.url);
    if (!fetched.ok) {
      await markFetch('failed', fetched.error);
      return fail(`بازخوانی ناموفق بود: ${fetched.error}`, 502);
    }
    if (fetched.text.length < MIN_TEXT_LENGTH) {
      await markFetch('failed', 'محتوای استخراج‌شده خیلی کوتاه بود.');
      return fail('محتوای معناداری از این صفحه استخراج نشد.', 422);
    }

    // ۲. تکراریِ دقیق؟
    const hash = contentHash(fetched.text);
    const { data: dup } = await sb
      .from('team_knowledge')
      .select('id')
      .eq('source_id', id)
      .eq('content_hash', hash)
      .maybeSingle();
    if (dup) {
      await markFetch('ok', null);
      return ok({ refreshed: false, reason: 'رکورد تازه‌ای نبود؛ همین محتوا قبلاً ثبت شده است.' });
    }

    // ۳. ساخت رکورد دانش
    const title = (source.title as string) || fetched.text.slice(0, 80);
    const content = fetched.text.slice(0, 20000);
    const { data: item, error: insertErr } = await sb
      .from('team_knowledge')
      .insert({
        team: source.team,
        title,
        content,
        source: 'knowledge-source',
        source_id: id,
        authority_tier: source.authority_tier,
        origin: 'source-fetch',
        extracted_at: new Date().toISOString(),
        content_hash: hash,
      })
      .select('id')
      .single();
    if (insertErr || !item) {
      await markFetch('failed', insertErr?.message ?? 'خطای ثبت دانش');
      return fail(`ثبت دانش ناموفق بود: ${insertErr?.message ?? 'خطای ناشناخته'}`, 500);
    }

    // ۴. ایندکس RAG (best-effort)
    let warning: string | null = null;
    try {
      await indexKnowledge(item.id, source.team as string, title, content);
    } catch (err) {
      warning = err instanceof RAGError ? err.message : 'ایندکس معنایی انجام نشد.';
    }

    await markFetch('ok', null);
    return ok({
      refreshed: true,
      knowledge_id: item.id,
      chars: fetched.text.length,
      ...(warning ? { warning } : {}),
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
