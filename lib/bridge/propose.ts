/**
 * lib/bridge/propose.ts: حلقه خودکار پچ پل (proposed ← needs_review | merged)
 *
 * دستور مسعود: سایت کاملاً خودکار، بدون تأیید دستی.
 * این تنها مسیر تولیدی است که پچ یک تیم را به dev ریپوی سایت می‌رساند:
 *   1. پچ را از bridge_patches می‌خواند (وضعیت باید proposed باشد)
 *   2. دروازه کیفیت (lib/bridge/gate.ts) را اجرا می‌کند
 *   3. قرمز ← وضعیت needs_review + ثبت gate_errors؛ پچ متوقف می‌شود ولی چرخه نمی‌میرد
 *   4. سبز ← کامیت به ai-bridge/<id> ← مرج خودکار به dev ← وضعیت merged
 *
 * امنیت حفظ شده: دروازه کیفیت، محدودیت فایل‌ها، ممنوعیت main، رول‌بک.
 * فقط قدم «تأیید دستی» حذف شده است.
 */

import { validatePatch } from './gate';
import { commitToBridgeBranch, createBridgePR } from './commit';
import { getBridgePatch, mergeBranchIntoDev, updateBridgePatch } from '../bridge';
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
  const patch = await getBridgePatch(patchId);
  if (!patch) throw new Error('پچی با این شناسه پیدا نشد.');
  if (patch.status !== 'proposed') {
    throw new Error(`این پچ در وضعیت «proposed» نیست (وضعیت فعلی: ${patch.status}).`);
  }

  const files = (patch.files ?? []) as PatchFile[];

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
  await updateBridgePatch(patchId, { status: 'gated', gate_errors: null });

  // ۲. کامیت به شاخه پل
  const team = patch.team || 'unknown';
  const { branch, sha } = await commitToBridgeBranch(patchId, files, team, patch.summary || undefined);
  await updateBridgePatch(patchId, { status: 'committed', branch, commit_sha: sha });

  // ۳. ساخت PR (بهترین تلاش؛ برای شفافیت تاریخچه)
  let prUrl: string | undefined;
  try {
    const pr = await createBridgePR(
      branch,
      `[پل] ${patch.summary || patchId}`,
      `تیم: ${team}\nشناسه پچ: ${patchId}\n\nاین PR به‌صورت خودکار مرج می‌شود (دستور مدیر).`,
    );
    prUrl = pr.url;
  } catch {
    /* PR اختیاری است */
  }

  // ۴. مرج خودکار به dev (بدون تأیید دستی)
  try {
    const merge = await mergeBranchIntoDev(branch);
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
    // مرج ناموفق: پچ در committed می‌ماند تا بعداً دوباره تلاش شود؛ چرخه نمی‌میرد
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
