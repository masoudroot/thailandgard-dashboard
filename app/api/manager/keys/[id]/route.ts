/**
 * /api/manager/keys/[id]: لغو کلید API مدیر داشبورد.
 *
 * DELETE: کلید را لغو می‌کند (حذف فیزیکی نه؛ برای حسابرسی می‌ماند).
 * با سشن ادمین محافظت می‌شود.
 */

import { fail, getSupabase, ok } from '../../../../../lib/api';

/** DELETE /api/manager/keys/[id]: لغو کلید */
export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  try {
    const id = params.id?.trim();
    if (!id) return fail('شناسه کلید لازم است.', 400);
    const sb = getSupabase();
    const { error } = await sb
      .from('manager_api_keys')
      .update({ revoked: true })
      .eq('id', id);
    if (error) return fail(`لغو کلید ناموفق بود: ${error.message}`);
    return ok({ revoked: true });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'خطای نامشخص');
  }
}
