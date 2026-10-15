/**
 * POST /api/debug/[id]/apply: اعمال فیکس با تأیید مسعود از طریق GitHub API.
 *
 * ورودی: { branch?: string, message: string, files: [{ path, content }] }
 * اگر گیت‌هاب متصل نباشد: ۴۰۰ با پیام صادقانه (نه ساختگی)؛ فرانت‌اند در این
 * حالت فقط «کپی پچ» را پیشنهاد می‌دهد.
 *
 * پس از موفقیت، وضعیت نشست به applied می‌رود و لینک مقایسه برمی‌گردد.
 */

import { fail, getSupabase, ok } from '../../../../../lib/api';
import { applyPatchViaGithub, type PatchFile } from '../../../../../lib/github';

function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}

/** POST /api/debug/[id]/apply */
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const id = params.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return fail('شناسه‌ی نشست نامعتبر است.', 400);
  }
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return fail('پیام کامیت خالی است.', 400);
    const files = body.files as PatchFile[] | undefined;
    if (!Array.isArray(files) || files.length === 0) {
      return fail('لیست فایل‌های پچ خالی است.', 400);
    }
    let branch = typeof body.branch === 'string' ? body.branch.trim() : '';
    if (!branch) {
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      branch = `fix/debug-${shortId(id)}-${today}`;
    }

    let result;
    try {
      result = await applyPatchViaGithub(branch, message, files);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const notConnected = msg.includes('متصل نیست');
      return fail(
        notConnected
          ? `${msg} فیکس اعمال نشد؛ می‌توانید پچ را کپی و دستی اعمال کنید.`
          : `اعمال فیکس ناموفق بود: ${msg}`,
        notConnected ? 400 : 502,
      );
    }

    const { error } = await getSupabase()
      .from('debug_sessions')
      .update({ status: 'applied', updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) {
      // کامیت روی گیت‌هاب موفق بود؛ فقط به‌روزرسانی وضعیت نشست خطا خورد
      return ok({
        ...result,
        warning: `فیکس روی گیت‌هاب اعمال شد ولی وضعیت نشست ذخیره نشد: ${error.message}`,
      });
    }

    return ok(result);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
