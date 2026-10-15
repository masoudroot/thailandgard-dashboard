/**
 * POST /api/settings/llm/[id]/test: تست اتصال واقعی به یک endpoint.
 *
 * خروجی موفق: { ok: true, models: string[], count, latencyMs }
 * خطای سرویس: { ok: false, message } با HTTP 200 تا UI پیام واقعی را نشان بدهد.
 */

import { fail, ok } from '../../../../../../lib/api';
import {
  InputError,
  fetchEndpointModels,
  isSupabaseConfigured,
} from '../../../../../../lib/llm-endpoints';

export async function POST(
  _request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  if (!isSupabaseConfigured()) {
    return fail('سوپابیس متصل نیست؛ ابتدا اتصال پایگاه داده را برقرار کنید.', 503);
  }
  try {
    const { models, latencyMs } = await fetchEndpointModels(
      decodeURIComponent(params.id),
    );
    return ok({ ok: true, models, count: models.length, latencyMs });
  } catch (err) {
    if (err instanceof InputError) return fail(err.message, 404);
    return ok({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
}
