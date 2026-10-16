/**
 * lib/bridge/merge.ts: توابع مرج پل به dev (سرور-اونلی).
 *
 * چرا جدا از lib/bridge.ts؟
 * lib/bridge.ts در کامپوننت کلاینتی app/dashboard/bridge/page.tsx هم باندل
 * می‌شود. این توابع به lib/bridge/pre-merge-check.ts وابسته‌اند که از
 * ماژول‌های Node (child_process، fs/promises) استفاده می‌کند؛ حتی import
 * تنبل هم توسط webpack در باندل کلاینت resolve می‌شود و بیلد می‌شکند.
 * پس کل زنجیرهٔ مرج اینجاست و lib/bridge.ts هیچ ارجاعی به آن ندارد.
 *
 * صداکننده‌ها (همه سرور-ساید):
 * - lib/bridge/propose.ts (حلقهٔ خودکار؛ تنها مسیر تولیدی)
 * - app/api/bridge/patches/[id]/approve/route.ts (تأیید دستی/اضطراری)
 * - app/api/bridge/patches/[id]/reject/route.ts (حذف شاخه پس از رد)
 */

import { getGithubConfig } from '../github';
import { GithubError } from '../github-changes';
import { BRIDGE_BASE_BRANCH, SITE_REPO } from './commit';
import { preMergeTypeCheck } from './pre-merge-check';
import {
  GITHUB_NOT_CONNECTED,
  githubHeaders,
  type BridgeMergeResult,
  type BridgePatchFile,
  type GithubPRItem,
} from '../bridge';

/** پیدا کردن PR بازِ شاخهٔ پل به dev؛ null یعنی PRای نیست. */
async function findOpenPR(
  api: string,
  h: Record<string, string>,
  branch: string,
): Promise<GithubPRItem | null> {
  const owner = SITE_REPO.split('/')[0];
  const res = await fetch(
    `${api}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&base=${BRIDGE_BASE_BRANCH}&state=open`,
    { headers: h, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) return null;
  const list = (await res.json()) as GithubPRItem[];
  const pr = Array.isArray(list) ? list[0] : undefined;
  return pr?.number ? pr : null;
}

/**
 * خطای رد تایپ‌چک پیش‌مرج.
 * دائمی است: با تلاش مجدد درست نمی‌شود. صداکننده باید پچ را به needs_review
 * ببرد (نه این‌که گیتِ پرهزینه را بیهوده تکرار کند).
 */
export class PreMergeGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreMergeGateError';
  }
}

/**
 * هوک تایپ‌چک پیش‌مرج: گلوگاه اجباری و fail-closed.
 *
 * ریشهٔ حادثهٔ مهر ۱۴۰۵: این بررسی در lib/bridge/pre-merge-check.ts نوشته شده
 * بود ولی هیچ‌وقت در مسیر واقعی مرج صدا زده نمی‌شد (فقط pipeline.ts که خودش
 * هیچ صداکننده‌ای ندارد)؛ پچ خراب مرج شد و بیلد ۲ بار شکست.
 *
 * قانون: پچ روی کلون تازه‌ای از dev ریپوی سایت اعمال و tsc اجرا می‌شود.
 * - تایپ‌چک سبز ← resolve، مرج می‌تواند ادامه یابد.
 * - تایپ‌چک قرمز یا انجام‌نشدنِ خودِ بررسی (خطای کلون/اجرا) ← throw؛
 *   هیچ مرجی انجام نمی‌شود (fail-closed).
 */
export async function runPreMergeTypeGate(files: BridgePatchFile[]): Promise<void> {
  const siteRepoUrl = `https://github.com/${SITE_REPO}.git`;
  const check = await preMergeTypeCheck(files, siteRepoUrl, BRIDGE_BASE_BRANCH);
  if (!check.passed) {
    const firstErrors = check.errors.slice(0, 3).join(' | ');
    throw new PreMergeGateError(
      `مرج بلاک شد: تایپ‌چک پیش‌مرج رد شد. ${check.message}` +
        (firstErrors ? ` نخستین خطاها: ${firstErrors}` : ''),
    );
  }
}

/**
 * مرج شاخهٔ پل به dev.
 *
 * صداکننده‌ها:
 * - lib/bridge/propose.ts (حلقهٔ خودکار؛ تنها مسیر تولیدی)
 * - app/api/bridge/patches/[id]/approve (مسیر دستی/اضطراری با احراز مدیر)
 *
 * گام صفرِ اجباری: هوک تایپ‌چک پیش‌مرج (runPreMergeTypeGate). بدون تایپ‌چک
 * سبز هیچ فراخوانی مرجی به گیت‌هاب زده نمی‌شود.
 * - اگر PR بازی برای شاخه باشد، همان PR مرج می‌شود؛
 * - وگرنه شاخه مستقیم به dev مرج می‌شود.
 */
export async function mergeBranchIntoDev(
  branch: string,
  files: BridgePatchFile[],
): Promise<BridgeMergeResult> {
  const { token } = await getGithubConfig();
  if (!token) throw new GithubError(GITHUB_NOT_CONNECTED, { notConnected: true, status: 503 });

  // هوک تایپ‌چک پیش‌مرج (fail-closed): پیش از هر فراخوانی مرج به گیت‌هاب.
  await runPreMergeTypeGate(files);

  const h = githubHeaders(token);
  const api = `https://api.github.com/repos/${SITE_REPO}`;

  const openPr = await findOpenPR(api, h, branch);
  if (openPr?.number) {
    const prRes = await fetch(`${api}/pulls/${openPr.number}`, {
      headers: h,
      signal: AbortSignal.timeout(15_000),
    });
    if (!prRes.ok) throw new GithubError(`خواندن PR ناموفق بود (وضعیت ${prRes.status}).`);
    const pr = (await prRes.json()) as GithubPRItem;
    if (pr.merged) {
      return { sha: pr.merge_commit_sha ?? null, already_merged: true, pr_number: openPr.number };
    }
    if (pr.state !== 'open') {
      throw new GithubError('این PR بسته شده و قابل مرج نیست.', { status: 409 });
    }
    const mRes = await fetch(`${api}/pulls/${openPr.number}/merge`, {
      method: 'PUT',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({ merge_method: 'merge' }),
      signal: AbortSignal.timeout(30_000),
    });
    const mBody = (await mRes.json().catch(() => ({}))) as {
      merged?: boolean;
      sha?: string;
      message?: string;
    };
    if (!mRes.ok || !mBody.merged) {
      throw new GithubError(`مرج PR ناموفق بود: ${mBody.message ?? `وضعیت ${mRes.status}`}`, {
        status: 502,
      });
    }
    return { sha: mBody.sha ?? null, already_merged: false, pr_number: openPr.number };
  }

  // مرج مستقیم شاخه به dev
  const mRes = await fetch(`${api}/merges`, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base: BRIDGE_BASE_BRANCH,
      head: branch,
      commit_message: `[bridge] merge ${branch} into ${BRIDGE_BASE_BRANCH}`,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (mRes.status === 204) {
    // dev از قبل شامل شاخه است؛ چیزی برای مرج نبود
    return { sha: null, already_merged: true, pr_number: null };
  }
  if (mRes.status === 404) {
    throw new GithubError(
      `شاخهٔ «${branch}» یا «${BRIDGE_BASE_BRANCH}» در ریپوی ${SITE_REPO} پیدا نشد.`,
      { status: 404 },
    );
  }
  const mBody = (await mRes.json().catch(() => ({}))) as { sha?: string; message?: string };
  if (!mRes.ok) {
    throw new GithubError(`مرج مستقیم ناموفق بود: ${mBody.message ?? `وضعیت ${mRes.status}`}`, {
      status: 502,
    });
  }
  return { sha: mBody.sha ?? null, already_merged: false, pr_number: null };
}

/** حذف شاخهٔ پل (پس از رد)؛ بهترین تلاش، خطا را قورت می‌دهد. */
export async function deleteBranchBestEffort(branch: string): Promise<boolean> {
  try {
    const { token } = await getGithubConfig();
    if (!token) return false;
    const res = await fetch(
      `https://api.github.com/repos/${SITE_REPO}/git/refs/heads/${encodeURIComponent(branch)}`,
      {
        method: 'DELETE',
        headers: githubHeaders(token),
        signal: AbortSignal.timeout(15_000),
      },
    );
    return res.status === 204;
  } catch {
    return false;
  }
}
