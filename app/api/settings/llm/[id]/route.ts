/**
 * DELETE /api/settings/llm/[id]: حذف یک endpoint.
 * ارجاع تیم‌ها به این endpoint هم پاک می‌شود (به رفتار پیش‌فرض برمی‌گردند).
 */

import { fail, ok } from '../../../../../lib/api';
import {
  InputError,
  deleteEndpoint,
  isSupabaseConfigured,
} from '../../../../../lib/llm-endpoints';

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  if (!isSupabaseConfigured()) {
    return fail('سوپابیس متصل نیست؛ ابتدا اتصال پایگاه داده را برقرار کنید.', 503);
  }
  try {
    await deleteEndpoint(decodeURIComponent(params.id));
    return ok({ deleted: true });
  } catch (err) {
    if (err instanceof InputError) return fail(err.message, 404);
    return fail(err instanceof Error ? err.message : String(err));
  }
}
