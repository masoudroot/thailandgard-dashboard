/**
 * POST /api/manager/knowledge/sources/[id]/test — تست اتصال به منبع.
 * نتیجه لحظه‌ای است و در دیتابیس ذخیره نمی‌شود.
 */
import { fail, getSupabase, ok } from '../../../../../../../lib/api';
import { requireManagerAuth } from '../../../../../../../lib/manager-auth';
import { isUuid, probeUrl } from '../../../../../../../lib/knowledge-sources';

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
      .select('id, url, title')
      .eq('id', id)
      .maybeSingle();
    if (error) return fail(error.message, 500);
    if (!source) return fail('منبع پیدا نشد.', 404);

    const probe = await probeUrl(source.url);
    if (probe.ok) {
      return ok({
        ok: true,
        latency_ms: probe.latencyMs,
        http_status: probe.httpStatus,
        message: `اتصال برقرار شد (${probe.latencyMs} میلی‌ثانیه).`,
      });
    }
    return ok({
      ok: false,
      latency_ms: probe.latencyMs,
      http_status: probe.httpStatus,
      message: probe.error ?? 'اتصال ناموفق بود.',
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
