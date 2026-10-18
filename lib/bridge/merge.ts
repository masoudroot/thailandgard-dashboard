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
  getBridgePatch,
  githubHeaders,
  updateBridgePatch,
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

export interface DevToMainMergeResult {
  /** آیا مرج انجام شد؟ */
  merged: boolean;
  /** آیا dev از قبل در main بود؟ */
  alreadyUpToDate: boolean;
  /** آیا تداخل مرج داشت؟ (در این صورت هیچ کاری نشده) */
  conflict: boolean;
  /** dev دقیقاً عقب‌تر از main است (نشانهٔ کامیت مستقیم روی main)؛ مرج انجام نشد. */
  devBehindMain?: boolean;
  /** تاریخچهٔ dev و main واگرا شده؛ مرج خودکار انجام نشد. */
  diverged?: boolean;
  /** تایپ‌چک dev رد شد؛ مرج به main بلاک شد (fail-closed). */
  blockedByTypeGate?: boolean;
  /** وضعیت مقایسهٔ main...dev از API گیت‌هاب (اگر خوانده شده باشد). */
  compareStatus?: string;
  sha?: string | null;
  message?: string;
}

/** نتیجهٔ مقایسهٔ main با dev از API گیت‌هاب. */
interface DevMainComparison {
  status: 'ahead' | 'behind' | 'identical' | 'diverged' | 'unknown';
  aheadBy: number;
  behindBy: number;
  devSha?: string;
}

/** لاگ بلند و قابل‌جست‌وجو برای رویدادهای خط لولهٔ dev به main. */
function alertDevMain(stage: string, detail: string): void {
  console.error(`[bridge][dev→main][ALERT] [${stage}] ${detail}`);
}

/**
 * نگهبان ۱: مقایسهٔ main...dev.
 *
 * - identical: چیزی برای مرج نیست.
 * - behind: dev عقب‌تر از main است؛ یعنی کسی مستقیم روی main کامیت زده و
 *   ناوردای خط لوله (main = مرج dev) شکسته شده. مرج خودکار انجام نمی‌شود.
 * - diverged: تاریخچه واگرا شده؛ ساخت مرج‌کامیت خودکار روی تاریخچهٔ واگرا
 *   ترکیبِ تست‌نشده را به پروداکشن (ورسل) می‌برد. مرج انجام نمی‌شود.
 * - ahead: مسیر سالم؛ ادامه.
 * - unknown (خطای API): بدون نگهبان ادامه می‌دهیم؛ خودِ فراخوانی مرج
 *   منبع حقیقت است و اگر API خراب باشد آنجا بلند خطا می‌دهد.
 */
async function compareDevToMain(
  api: string,
  h: Record<string, string>,
): Promise<DevMainComparison> {
  const res = await fetch(`${api}/compare/main...dev`, {
    headers: h,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    alertDevMain(
      'compare',
      `خواندن مقایسهٔ main...dev ناموفق بود (وضعیت ${res.status})؛ بدون نگهبان واگرایی ادامه می‌دهیم.`,
    );
    return { status: 'unknown', aheadBy: 0, behindBy: 0 };
  }
  const body = (await res.json().catch(() => ({}))) as {
    status?: string;
    ahead_by?: number;
    behind_by?: number;
    head_commit?: { sha?: string };
  };
  const s = body.status;
  const status =
    s === 'ahead' || s === 'behind' || s === 'identical' || s === 'diverged' ? s : 'unknown';
  return {
    status,
    aheadBy: typeof body.ahead_by === 'number' ? body.ahead_by : 0,
    behindBy: typeof body.behind_by === 'number' ? body.behind_by : 0,
    devSha: body.head_commit?.sha,
  };
}

/**
 * نگهبان ۲: هوک تایپ‌چک dev پیش از مرج به main (fail-closed).
 *
 * ریشهٔ خطر: مرج خودکار dev به main هیچ اعتبارسنجی نداشت؛ هر چیزی که
 * مستقیم روی dev نشسته باشد (دور از پل و دروازهٔ تایپ‌چک پچ) بی‌محابا به
 * main می‌رفت و ورسل همان را دیپلوی می‌کرد.
 *
 * قانون: HEADـِ dev روی کلون تازه تایپ‌چک می‌شود (همان زیرساخت
 * preMergeTypeCheck با فهرست خالی فایل‌ها). سبز ← ادامه؛ قرمز یا
 * انجام‌نشدنِ خودِ بررسی ← PreMergeGateError و هیچ مرجی انجام نمی‌شود.
 */
export async function runDevMainTypeGate(): Promise<void> {
  const siteRepoUrl = `https://github.com/${SITE_REPO}.git`;
  const check = await preMergeTypeCheck([], siteRepoUrl, BRIDGE_BASE_BRANCH);
  if (!check.passed) {
    const firstErrors = check.errors.slice(0, 3).join(' | ');
    throw new PreMergeGateError(
      `مرج dev به main بلاک شد: تایپ‌چک dev رد شد. ${check.message}` +
        (firstErrors ? ` نخستین خطاها: ${firstErrors}` : ''),
    );
  }
}

/**
 * ثبت بهترین‌تلاشِ خطای dev→main روی ردیف پچ تا در داشبورد دیده شود.
 * ورودی‌های قبلی gate_errors حفظ می‌شوند. هرگز throw نمی‌کند: خرابی
 * دیتابیس نباید جریان مرج را بشکند.
 */
async function recordDevMainFailure(
  patchId: string | undefined,
  stage: string,
  message: string,
): Promise<void> {
  if (!patchId) return;
  try {
    const patch = await getBridgePatch(patchId);
    let entries: unknown[] = [];
    try {
      const raw = patch?.gate_errors;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      /* قالب ناآشنای gate_errors؛ از نو شروع می‌کنیم */
    }
    entries.push({
      at: new Date().toISOString(),
      stage: `dev-to-main:${stage}`,
      message,
    });
    await updateBridgePatch(patchId, { gate_errors: JSON.stringify(entries) });
  } catch (err) {
    alertDevMain(
      'persist',
      `ثبت خطا روی ردیف پچ ${patchId} ناموفق بود: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * مرج خودکار dev به main (دستور مسعود: خط لوله کاملاً خودکار).
 *
 * چه زمانی صدا زده می‌شود: پس از مرج موفق پچ به dev در propose.ts
 * (و مسیر دستی approve). پارامتر patchId اختیاری است؛ اگر داده شود،
 * هر خطا/بلاکی روی ردیف همان پچ هم ثبت می‌شود تا در داشبورد دیده شود.
 *
 * بهترین تلاش است: خطا را throw نمی‌کند، فقط بلند لاگ می‌کند و نتیجه
 * برمی‌گرداند. چرخهٔ بعدی دوباره تلاش می‌کند (خودترمیم).
 *
 * نگهبان‌ها (به ترتیب):
 * ۱. مقایسهٔ main...dev: فقط وقتی dev دقیقاً جلوتر است ادامه می‌دهد؛
 *    عقب‌ماندگی یا واگرایی، بلند لاگ و ثبت می‌شود و مرج انجام نمی‌شود.
 * ۲. تایپ‌چک dev (fail-closed): کد تایپ‌خراب هرگز به main (ورسل) نمی‌رسد.
 *
 * امنیت:
 * - هرگز force-push نمی‌کند (فقط مرج معمولی GitHub API)
 * - اگر تداخل (409) باشد، هیچ کاری نمی‌کند و conflict=true برمی‌گرداند
 * - اگر dev جلوتر نباشد (204 یا identical)، کاری نمی‌کند
 */
export async function mergeDevIntoMainBestEffort(
  patchId?: string,
): Promise<DevToMainMergeResult> {
  /** مسیر خروجِ خطا: بلند لاگ + ثبت روی پچ + نتیجهٔ یکدست. */
  const fail = async (
    stage: string,
    message: string,
    extra: Partial<DevToMainMergeResult> = {},
  ): Promise<DevToMainMergeResult> => {
    alertDevMain(stage, message);
    await recordDevMainFailure(patchId, stage, message);
    return { merged: false, alreadyUpToDate: false, conflict: false, message, ...extra };
  };

  try {
    const { token } = await getGithubConfig();
    if (!token) {
      return fail('auth', 'گیت‌هاب متصل نیست؛ مرج خودکار dev به main انجام نشد.');
    }
    const h = githubHeaders(token);
    const api = `https://api.github.com/repos/${SITE_REPO}`;

    // نگهبان ۱: مقایسهٔ main...dev
    const cmp = await compareDevToMain(api, h);
    if (cmp.status === 'identical') {
      console.log('[bridge] مرج خودکار dev←main: main از قبل به‌روز است.');
      return { merged: false, alreadyUpToDate: true, conflict: false, compareStatus: cmp.status };
    }
    if (cmp.status === 'behind') {
      return fail(
        'diverged-history',
        `dev دقیقاً ${cmp.behindBy} کامیت عقب‌تر از main است؛ احتمالاً کامیت مستقیم روی main زده شده و ناوردای خط لوله شکسته شده. مرج خودکار انجام نشد؛ نیاز به بررسی دستی.`,
        { devBehindMain: true, compareStatus: cmp.status },
      );
    }
    if (cmp.status === 'diverged') {
      return fail(
        'diverged-history',
        `تاریخچهٔ dev و main واگرا شده (dev ${cmp.aheadBy} جلو و ${cmp.behindBy} عقب). ساخت خودکار مرج‌کامیت روی تاریخچهٔ واگرا ترکیب تست‌نشده را به پروداکشن می‌برد؛ مرج انجام نشد؛ نیاز به بررسی دستی.`,
        { diverged: true, compareStatus: cmp.status },
      );
    }
    // ahead یا unknown: ادامه

    // نگهبان ۲: تایپ‌چک dev (fail-closed)
    try {
      await runDevMainTypeGate();
      console.log(
        `[bridge] تایپ‌چک dev سبز است (sha=${cmp.devSha ?? 'unknown'})؛ مرج به main ادامه می‌یابد.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail('type-gate', message, { blockedByTypeGate: true, compareStatus: cmp.status });
    }

    const mRes = await fetch(`${api}/merges`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base: 'main',
        head: 'dev',
        commit_message: '[bridge] مرج خودکار dev به main (خط لوله خودکار)',
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (mRes.status === 204) {
      // main از قبل شامل dev است؛ چیزی برای مرج نبود
      console.log('[bridge] مرج خودکار dev←main: main از قبل به‌روز است.');
      return { merged: false, alreadyUpToDate: true, conflict: false, compareStatus: cmp.status };
    }
    if (mRes.status === 409) {
      // تداخل مرج: خودکار مرج نمی‌کنیم، بلند هشدار می‌دهیم
      return fail(
        'conflict',
        'مرج dev به main تداخل دارد (409)؛ هیچ کاری انجام نشد؛ نیاز به بررسی دستی.',
        { conflict: true, compareStatus: cmp.status },
      );
    }
    if (mRes.status === 404) {
      return fail('not-found', 'شاخهٔ dev یا main در ریپوی سایت پیدا نشد (404).', {
        compareStatus: cmp.status,
      });
    }
    const mBody = (await mRes.json().catch(() => ({}))) as { sha?: string; message?: string };
    if (!mRes.ok) {
      return fail(
        'merge-api',
        `مرج خودکار dev به main ناموفق بود: ${mBody.message ?? `وضعیت ${mRes.status}`}`,
        { compareStatus: cmp.status },
      );
    }
    if (!mBody.sha) {
      alertDevMain(
        'anomaly',
        `پاسخ مرج موفق بود (وضعیت ${mRes.status}) ولی sha نداشت؛ وضعیت main باید دستی راستی شود.`,
      );
    }
    console.log(`[bridge] مرج خودکار dev←main انجام شد (sha=${mBody.sha ?? 'unknown'}). ورسل به‌زودی دیپلوی می‌کند.`);
    return {
      merged: true,
      alreadyUpToDate: false,
      conflict: false,
      sha: mBody.sha ?? null,
      compareStatus: cmp.status,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    alertDevMain('exception', message);
    await recordDevMainFailure(patchId, 'exception', message);
    return { merged: false, alreadyUpToDate: false, conflict: false, message };
  }
}
