/**
 * POST /api/settings/llm/prompt-test: تست واقعی پرامپت روی یک endpoint+مدل.
 *
 * ورودی: { endpointId: string, model: string, prompt: string }.
 * خروجی موفق: { ok: true, text, latencyMs }.
 * خطای سرویس: { ok: false, message } با HTTP 200 تا UI پیام واقعی را نشان بدهد.
 * کلید API هیچ‌وقت در پاسخ برنمی‌گردد.
 */

import { fail, ok } from '../../../../../lib/api';
import {
  InputError,
  isSupabaseConfigured,
  testPrompt,
} from '../../../../../lib/llm-endpoints';

export async function POST(request: Request): Promise<Response> {
  if (!isSupabaseConfigured()) {
    return fail('سوپابیس متصل نیست؛ ابتدا اتصال پایگاه داده را برقرار کنید.', 503);
  }
  try {
    const body: unknown = await request.json().catch(() => ({}));
    const b = (body ?? {}) as Record<string, unknown>;
    const endpointId = typeof b.endpointId === 'string' ? b.endpointId : '';
    const model = typeof b.model === 'string' ? b.model : '';
    const prompt = typeof b.prompt === 'string' ? b.prompt : '';
    const { text, latencyMs } = await testPrompt(endpointId, model, prompt);
    return ok({ ok: true, text, latencyMs });
  } catch (err) {
    if (err instanceof InputError) return fail(err.message, 400);
    return ok({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
}
