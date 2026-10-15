/**
 * GET /api/settings/llm/embedding: خواندن «مدل امبدینگ» سامانه.
 * POST /api/settings/llm/embedding: ذخیره یا پاک کردن.
 *
 * ورودی: { endpointId: string, model: string } یا { clear: true }.
 * جست‌وجوی معنایی در حافظه تیم‌ها از این پیکربندی استفاده می‌کند.
 */

import { fail, ok } from '../../../../../lib/api';
import {
  InputError,
  getEmbeddingModel,
  isSupabaseConfigured,
  saveEmbeddingModel,
} from '../../../../../lib/llm-endpoints';

export async function GET(): Promise<Response> {
  if (!isSupabaseConfigured()) {
    return ok({ connected: false, embeddingModel: null });
  }
  try {
    return ok({ connected: true, embeddingModel: await getEmbeddingModel() });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isSupabaseConfigured()) {
    return fail('سوپابیس متصل نیست؛ ابتدا اتصال پایگاه داده را برقرار کنید.', 503);
  }
  try {
    const body: unknown = await request.json().catch(() => ({}));
    const b = (body ?? {}) as Record<string, unknown>;
    const entry = await saveEmbeddingModel(b.clear === true ? null : b);
    return ok({ embeddingModel: entry });
  } catch (err) {
    if (err instanceof InputError) return fail(err.message, 400);
    return fail(err instanceof Error ? err.message : String(err));
  }
}
