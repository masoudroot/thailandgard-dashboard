/**
 * lib/bridge/propose.ts: حلقه خودکار پچ پل (proposed ← needs_review | merged)
 *
 * دستور مسعود: سایت کاملاً خودکار، بدون تأیید دستی.
 * این تنها مسیر تولیدی است که پچ یک تیم را به dev ریپوی سایت می‌رساند:
 *   ۱. ادعای اتمیک پچ (proposed ← gated)؛ دو ورکر هم‌زمان یک پچ را پردازش نمی‌کنند
 *   ۲. دروازه کیفیت (lib/bridge/gate.ts) را اجرا می‌کند
 *   ۳. قرمز ← وضعیت needs_review + ثبت gate_errors؛ پچ متوقف می‌شود ولی چرخه نمی‌میرد
 *   ۴. سبز ← کامیت به ai-bridge/<id> ← مرج خودکار به dev ← وضعیت merged
 *
 * بازیابی از خطا:
 * - خطای کامیت: وضعیت به proposed برمی‌گردد تا جاروی بعدی دوباره تلاش کند؛
 *   کامیت روی گیت‌هاب idempotent است (شاخهٔ موجود با محتوای یکسان دوباره استفاده می‌شود).
 * - خطای مرج: پچ در committed می‌ماند تا بعداً دوباره تلاش شود؛ چرخه نمی‌میرد.
 *
 * امنیت حفظ شده: دروازه کیفیت، محدودیت فایل‌ها، ممنوعیت main، رول‌بک.
 * فقط قدم «تأیید دستی» حذف شده است.
 */

import { validatePatch } from './gate';
import { commitToBridgeBranch, createBridgePR } from './commit';
import { claimBridgePatch, getBridgePatch, updateBridgePatch } from '../bridge';
import { mergeBranchIntoDev, PreMergeGateError } from './merge';
import type { PatchFile } from '../types';

export interface ProposeResult {
  patchId: string;
  gated: boolean;
  committed: boolean;
  /** مرج خودکار به dev انجام شد؟ */
  merged: boolean;
  branch?: string;
  sha?: string;
  prUrl?: string;
  mergeSha?: string;
  gateErrors?: string[];
  mergeError?: string;
}

/** پردازش کامل خودکار یک پچ proposed تا مرج در dev. */
export async function processProposedPatch(patchId: string): Promise<ProposeResult> {
  // ۰. ادعای اتمیک: اگر ورکر دیگری همین پچ را برداشته، بی‌صدا عقب می‌نشینیم
  const claimed = await claimBridgePatch(patchId);
  if (!claimed) {
    const current = await getBridgePatch(patchId);
    throw new Error(
      current
        ? `پچ ${patchId} دیگر در وضعیت «proposed» نیست (وضعیت فعلی: ${current.status})؛ احتمالاً ورکر دیگری آن را برداشته است.`
        : 'پچی با این شناسه پیدا نشد.',
    );
  }

  const files = (claimed.files ?? []) as PatchFile[];

  // ۱. دروازه کیفیت
  const gate = validatePatch(files);
  if (!gate.ok) {
    await updateBridgePatch(patchId, {
      status: 'needs_review',
      gate_errors: JSON.stringify(gate.errors),
    });
    console.log(
      `[bridge] پچ ${patchId} در دروازه کیفیت رد شد؛ وضعیت needs_review ثبت شد.`,
    );
    return { patchId, gated: false, committed: false, merged: false, gateErrors: gate.errors };
  }

  // ۲. کامیت به شاخه پل (با بازیابی: خطا ← بازگشت به proposed برای تلاش بعدی)
  const team = claimed.team || 'unknown';
  let branch: string;
  let sha: string;
  try {
    const res = await commitToBridgeBranch(patchId, files, team, claimed.summary || undefined);
    branch = res.branch;
    sha = res.sha;
  } catch (err) {
    await updateBridgePatch(patchId, { status: 'proposed' });
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[bridge] کامیت پچ ${patchId} ناموفق بود؛ به proposed برگشت:`, message);
    throw new Error(`کامیت پچ ${patchId} ناموفق بود و برای تلاش بعدی به proposed برگشت: ${message}`);
  }
  await updateBridgePatch(patchId, { status: 'committed', branch, commit_sha: sha });

  // ۳. ساخت PR (بهترین تلاش؛ برای شفافیت تاریخچه)
  let prUrl: string | undefined;
  try {
    const pr = await createBridgePR(
      branch,
      `[پل] ${claimed.summary || patchId}`,
      `تیم: ${team}\nشناسه پچ: ${patchId}\n\nاین PR به‌صورت خودکار مرج می‌شود (دستور مدیر).`,
    );
    prUrl = pr.url;
  } catch {
    /* PR اختیاری است */
  }

  // ۴. مرج خودکار به dev (بدون تأیید دستی)
  try {
    const merge = await mergeBranchIntoDev(branch, files);
    const now = new Date().toISOString();
    await updateBridgePatch(patchId, {
      status: 'merged',
      decided_by: 'auto',
      decided_at: now,
      merge_sha: merge.sha,
    });
    console.log(`[bridge] پچ ${patchId} به‌صورت خودکار به dev مرج شد (sha=${merge.sha ?? 'already'}).`);
    return {
      patchId,
      gated: true,
      committed: true,
      merged: true,
      branch,
      sha,
      prUrl,
      mergeSha: merge.sha ?? undefined,
    };
  } catch (err) {
    // رد تایپ‌چک پیش‌مرج دائمی است (با تلاش مجدد درست نمی‌شود): پچ به
    // needs_review می‌رود تا چرخه گیتِ پرهزینه را روی پچ خراب تکرار نکند.
    if (err instanceof PreMergeGateError) {
      const gateMessage = err.message;
      await updateBridgePatch(patchId, {
        status: 'needs_review',
        gate_errors: JSON.stringify([gateMessage]),
      });
      console.error(
        `[bridge] پچ ${patchId} در تایپ‌چک پیش‌مرج رد شد؛ وضعیت needs_review ثبت شد.`,
      );
      return {
        patchId,
        gated: true,
        committed: true,
        merged: false,
        branch,
        sha,
        prUrl,
        gateErrors: [gateMessage],
      };
    }
    // مرج ناموفق (گذرا): پچ در committed می‌ماند تا بعداً دوباره تلاش شود؛ چرخه نمی‌میرد
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[bridge] مرج خودکار پچ ${patchId} به dev ناموفق بود:`, message);
    return {
      patchId,
      gated: true,
      committed: true,
      merged: false,
      branch,
      sha,
      prUrl,
      mergeError: message,
    };
  }
}
