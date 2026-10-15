/**
 * lib/bridge/propose.ts: حلقه تولید پچ پل (proposed ← gated ← committed)
 *
 * این تنها مسیر تولیدی است که پچ یک تیم را به شاخه پل می‌رساند:
 *   1. پچ را از bridge_patches می‌خواند (وضعیت باید proposed باشد)
 *   2. دروازه کیفیت (lib/bridge/gate.ts) را اجرا می‌کند
 *   3. قرمز ← ثبت gate_errors و ماندن در proposed
 *   4. سبز ← ثبت gated، کامیت به ai-bridge/<id>، ثبت committed + ساخت PR
 *
 * قانون: هیچ‌چیز مستقیم به dev نمی‌رود. مرج به dev فقط از مسیر
 * POST /api/bridge/patches/[id]/approve با تأیید صریح مدیر.
 */

import { validatePatch } from './gate';
import { commitToBridgeBranch, createBridgePR } from './commit';
import { getBridgePatch, updateBridgePatch } from '../bridge';
import type { PatchFile } from '../types';

export interface ProposeResult {
  patchId: string;
  gated: boolean;
  committed: boolean;
  branch?: string;
  sha?: string;
  prUrl?: string;
  gateErrors?: string[];
}

/** پردازش یک پچ proposed تا کامیت روی شاخه پل. */
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
    await updateBridgePatch(patchId, { gate_errors: JSON.stringify(gate.errors) });
    return { patchId, gated: false, committed: false, gateErrors: gate.errors };
  }
  await updateBridgePatch(patchId, { status: 'gated', gate_errors: null });

  // ۲. کامیت به شاخه پل
  const team = patch.team || 'unknown';
  const { branch, sha } = await commitToBridgeBranch(patchId, files, team, patch.summary || undefined);
  await updateBridgePatch(patchId, { status: 'committed', branch, commit_sha: sha });

  // ۳. ساخت PR (بهترین تلاش؛ اگر نساخته شد، کامیت سر جایش است)
  let prUrl: string | undefined;
  try {
    const pr = await createBridgePR(
      branch,
      `[پل] ${patch.summary || patchId}`,
      `تیم: ${team}\nشناسه پچ: ${patchId}\n\nاین PR را فقط مدیر می‌تواند مرج کند.`,
    );
    prUrl = pr.url;
  } catch {
    /* PR اختیاری است */
  }

  return { patchId, gated: true, committed: true, branch, sha, prUrl };
}
