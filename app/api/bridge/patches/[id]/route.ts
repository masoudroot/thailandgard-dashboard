/**
 * GET /api/bridge/patches/[id]: جزئیات یک پچ + diff.
 *
 * diff از GitHub API می‌آید: مقایسهٔ شاخهٔ پل با dev ریپوی سایت.
 * اگر گیت‌هاب متصل نباشد، جزئیات برمی‌گردد و diff خالی است با پیام صادقانه؛
 * هیچ دادهٔ نمایشی تولید نمی‌شود.
 * محتوای فایل‌ها در پاسخ نیست؛ فقط مسیرها (diff تغییرات را نشان می‌دهد).
 * احراز: سشن ادمین داشبورد (middleware).
 */

import { fail, ok } from '../../../../../lib/api';
import {
  compareBranchWithDev,
  getBridgePatch,
  patchCompareUrl,
} from '../../../../../lib/bridge';
import { GithubError } from '../../../../../lib/github-changes';

function validId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  try {
    const id = params.id ?? '';
    if (!validId(id)) return fail('شناسهٔ پچ نامعتبر است.', 400);

    const patch = await getBridgePatch(id);
    if (!patch) return fail('پچی با این شناسه پیدا نشد.', 404);
    if (!patch.branch) return fail('این پچ شاخهٔ پل ندارد؛ diff قابل محاسبه نیست.', 409);

    const slim = {
      ...patch,
      files: patch.files.map((f) => f.path),
      compare_url: patchCompareUrl(patch),
    };

    try {
      const diff = await compareBranchWithDev(patch.branch);
      return ok({ patch: slim, diff, github_connected: true });
    } catch (err) {
      if (err instanceof GithubError) {
        // جزئیات پچ هست؛ فقط diff در دسترس نیست
        return ok({
          patch: slim,
          diff: null,
          github_connected: false,
          github_message: err.message,
        });
      }
      throw err;
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'خطای نامشخص');
  }
}
