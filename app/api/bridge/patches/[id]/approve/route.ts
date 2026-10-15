/**
 * POST /api/bridge/patches/[id]/approve: تأیید صریح مدیر + مرج به dev.
 *
 * احراز: فقط کلید مدیریتی (lib/manager-auth)؛ هدر Authorization: Bearer <token>.
 * نکته: از دستور «پل کاملاً خودکار» (مهر ۱۴۰۵)، مرج به dev به‌صورت خودکار
 * در lib/bridge/propose.ts انجام می‌شود؛ این مسیر فقط برای موارد دستی/اضطراری مانده است.
 *
 * شرط وضعیت: committed (یا approved بدون merge_sha برای تلاش مجدد پس از خطای گذرا).
 * رفتار مرج:
 *  - اگر برای شاخهٔ پل PR بازی به dev باشد، همان PR مرج می‌شود؛
 *  - وگرنه شاخه مستقیم به dev مرج می‌شود.
 *  - در صورت موفقیت: وضعیت approved + decided_by/decided_at + merge_sha.
 *  - اگر مرج خطا بدهد، وضعیت دست نمی‌خورد و خطا برمی‌گردد.
 */

import { fail, ok } from '../../../../../../lib/api';
import { requireManagerAuth } from '../../../../../../lib/manager-auth';
import {
  getBridgePatch,
  mergeBranchIntoDev,
  updateBridgePatch,
} from '../../../../../../lib/bridge';
import { GithubError } from '../../../../../../lib/github-changes';

function validId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

const TERMINAL = new Set(['rejected', 'merged', 'rolledback']);

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const auth = await requireManagerAuth(request);
  if (auth instanceof Response) return auth;

  try {
    const id = params.id ?? '';
    if (!validId(id)) return fail('شناسهٔ پچ نامعتبر است.', 400);

    const patch = await getBridgePatch(id);
    if (!patch) return fail('پچی با این شناسه پیدا نشد.', 404);
    if (!patch.branch) return fail('این پچ شاخهٔ پل ندارد؛ چیزی برای مرج نیست.', 409);

    if (TERMINAL.has(patch.status)) {
      return fail('این پچ به وضعیت پایانی رسیده و دیگر قابل تأیید نیست.', 409);
    }
    if (patch.status !== 'committed' && patch.status !== 'approved') {
      return fail('فقط پچِ کامیت‌شده قابل تأیید است؛ این پچ هنوز به این مرحله نرسیده.', 409);
    }
    // خودتوانی: اگر قبلاً تأیید و مرج شده، همان نتیجه برگردد
    if (patch.status === 'approved' && patch.merge_sha) {
      return ok({ patch, merge_sha: patch.merge_sha, already_merged: true, pr_number: null });
    }

    let merge: { sha: string | null; already_merged: boolean; pr_number: number | null };
    try {
      merge = await mergeBranchIntoDev(patch.branch);
    } catch (err) {
      if (err instanceof GithubError) {
        return fail(err.message, err.status >= 400 && err.status < 600 ? err.status : 502);
      }
      throw err;
    }

    const now = new Date().toISOString();
    const updated = await updateBridgePatch(id, {
      status: 'approved',
      decided_by: auth.id,
      decided_at: now,
      merge_sha: merge.sha,
    });
    return ok({
      patch: updated,
      merge_sha: merge.sha,
      already_merged: merge.already_merged,
      pr_number: merge.pr_number,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'خطای نامشخص');
  }
}
