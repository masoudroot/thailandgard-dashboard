/**
 * GET /api/settings/llm: لیست endpointهای LLM (کلیدها ماسک‌شده) + نگاشت «مدل هر تیم»
 * + مدل پیش‌فرض + مدل امبدینگ.
 * POST /api/settings/llm: افزودن endpoint جدید یا ویرایش موجود (با id).
 *
 * اگر env سوپابیس ست نباشد، GET با connected:false برمی‌گردد تا UI صادقانه
 * «متصل نیست» نشان بدهد؛ POST در این حالت 503 می‌دهد.
 */

import { fail, ok } from '../../../../lib/api';
import {
  InputError,
  getDefaultModel,
  getEmbeddingModel,
  getTeamModelMap,
  isSupabaseConfigured,
  listEndpointsMasked,
  saveEndpoint,
} from '../../../../lib/llm-endpoints';

export async function GET(): Promise<Response> {
  if (!isSupabaseConfigured()) {
    return ok({ connected: false, endpoints: [], teamModels: {}, defaultModel: null, embeddingModel: null });
  }
  try {
    const [endpoints, teamModels, defaultModel, embeddingModel] = await Promise.all([
      listEndpointsMasked(),
      getTeamModelMap(),
      getDefaultModel(),
      getEmbeddingModel(),
    ]);
    return ok({ connected: true, endpoints, teamModels, defaultModel, embeddingModel });
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
    const endpoint = await saveEndpoint({
      id: typeof b.id === 'string' ? b.id : undefined,
      name: b.name,
      baseUrl: b.baseUrl,
      apiKey: b.apiKey,
    });
    return ok(endpoint, 201);
  } catch (err) {
    if (err instanceof InputError) return fail(err.message, 400);
    return fail(err instanceof Error ? err.message : String(err));
  }
}
