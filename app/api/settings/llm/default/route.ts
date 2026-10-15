/**
 * POST /api/settings/llm/default: ذخیره یا پاک کردن «مدل پیش‌فرض سامانه».
 *
 * ورودی: { endpointId: string, model: string } یا { clear: true }.
 * تیم‌هایی که مدل اختصاصی ندارند از این پیکربندی استفاده می‌کنند.
 */

import { fail, ok } from '../../../../../lib/api';
import {
  InputError,
  isSupabaseConfigured,
  saveDefaultModel,
} from '../../../../../lib/llm-endpoints';

export async function POST(request: Request): Promise<Response> {
  if (!isSupabaseConfigured()) {
    return fail('سوپابیس متصل نیست؛ ابتدا اتصال پایگاه داده را برقرار کنید.', 503);
  }
  try {
    const body: unknown = await request.json().catch(() => ({}));
    const b = (body ?? {}) as Record<string, unknown>;
    const entry = await saveDefaultModel(b.clear === true ? null : b);
    return ok({ defaultModel: entry });
  } catch (err) {
    if (err instanceof InputError) return fail(err.message, 400);
    return fail(err instanceof Error ? err.message : String(err));
  }
}
