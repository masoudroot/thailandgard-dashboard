/**
 * lib/bridge/rollback.ts: رول‌بک پچ مرج‌شده‌ی پل اجرا.
 *
 * سیاست (بخش ۸ سند docs/execution-bridge.md):
 * ۱. فقط پچ «merged» قابل رول‌بک است؛ بقیه‌ی وضعیت‌ها خطای فارسی می‌گیرند.
 * ۲. همیشه با یک کامیت revert تازه روی شاخه‌ی dev. بازنویسی تاریخچه
 *    (force-push، حذف کامیت، rebase) مطلقاً ممنوع؛ تاریخچه باید نشان بدهد
 *    چه آمد و چه برگشت.
 * ۳. پل به main دست نمی‌زند، در رول‌بک هم.
 * ۴. رول‌بک خودکار فقط وقتی امن است که کامیت مرج، رأس فعلی dev باشد.
 *    اگر dev جلوتر رفته باشد، به‌جای revert حدسی، خطای فارسی صادقانه
 *    برمی‌گردد تا مدیر دستی بررسی کند.
 *
 * ترتیب قدم‌ها عمداً این است: اول کامیت revert ساخته می‌شود، بعد رأس dev
 * جلو می‌رود (fast-forward، هرگز force)، و آخر سر وضعیت دیتابیس به‌روز
 * می‌شود. اگر قدم آخر بیفتد، خطا صراحتاً می‌گوید revert انجام شده ولی
 * ثبت دیتابیس نه، تا کسی دوباره و کورکورانه تلاش نکند.
 */

import { getSupabase } from '../api';
import { COMMITTER_EMAIL, COMMITTER_NAME, SITE_REPO_FULL, getGithubConfig } from '../github';
import { getSetting } from '../settings';

export interface RollbackOptions {
  /** دلیل رول‌بک؛ در پیام کامیت revert ثبت می‌شود. */
  reason?: string;
  /** نام تأییدکننده (نام کلید مدیریتی) برای ثبت در decided_by. */
  decidedBy?: string;
}

interface BridgePatchRow {
  id: string;
  status: string;
  merge_sha: string | null;
  branch: string | null;
  team: string | null;
  summary: string | null;
}

const STATUS_FA: Record<string, string> = {
  proposed: 'پیشنهادشده',
  gated: 'گذرکرده از دروازه',
  committed: 'کامیت‌شده',
  approved: 'تأییدشده',
  merged: 'مرج‌شده',
  rejected: 'ردشده',
  rolledback: 'رول‌بک‌شده',
};

function statusFa(status: string): string {
  return STATUS_FA[status] ?? status;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/**
 * ریپوی هدف رول‌بک: ریپوی سایت تایلندگرد؛ مگر اینکه در تنظیمات
 * (یا env) ریپوی دیگری صراحتاً ست شده باشد.
 */
async function resolveTargetRepo(): Promise<string> {
  try {
    const stored = await getSetting<string | null>('github_repo', null);
    if (typeof stored === 'string' && stored.trim()) return stored.trim();
  } catch {
    // تنظیمات در دسترس نیست؛ به env و پیش‌فرض تکیه می‌کنیم
  }
  if (process.env.GITHUB_REPO && process.env.GITHUB_REPO.trim()) {
    return process.env.GITHUB_REPO.trim();
  }
  return SITE_REPO_FULL;
}

interface GithubRefBody {
  object?: { sha?: string };
}

interface GithubCommitBody {
  sha?: string;
  parents?: Array<{ sha?: string }>;
  tree?: { sha?: string };
}

function buildRevertMessage(input: {
  mergeSha: string;
  patchId: string;
  team: string | null;
  summary: string | null;
  reason?: string;
}): string {
  const short = input.mergeSha.slice(0, 7);
  const lines = [
    `[bridge] revert مرج ${short}${input.team ? ` (${input.team})` : ''}`,
    '',
    `برگرداندن اثر پچی که به dev مرج شده بود (شناسه‌ی پچ: ${input.patchId}).`,
    `کامیت مرج: ${input.mergeSha}`,
  ];
  if (input.summary) lines.push(`موضوع پچ: ${input.summary.slice(0, 200)}`);
  lines.push(`دلیل رول‌بک: ${input.reason?.trim() ? input.reason.trim() : 'ثبت نشده'}`);
  return lines.join('\n');
}

/**
 * رول‌بک یک پچ: ساخت کامیت revert روی dev با GitHub API و
 * تغییر وضعیت پچ به rolledback.
 *
 * فقط برای پچ‌های merged مجاز است؛ بقیه‌ی وضعیت‌ها خطای فارسی می‌دهند.
 * برمی‌گرداند: SHA کامل کامیت revert تازه‌ساخته‌شده.
 */
export async function rollbackPatch(
  patchId: string,
  options?: RollbackOptions,
): Promise<{ sha: string }> {
  const id = (patchId ?? '').trim();
  if (!id) throw new Error('شناسه‌ی پچ خالی است.');

  // ۱) خواندن پچ از دیتابیس
  const sb = getSupabase();
  const { data, error } = await sb
    .from('bridge_patches')
    .select('id, status, merge_sha, branch, team, summary')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`خواندن پچ از دیتابیس ناموفق بود: ${error.message}`);
  if (!data) throw new Error('پچی با این شناسه پیدا نشد.');
  const patch = data as BridgePatchRow;

  // ۲) نگهبان وضعیت: فقط merged
  if (patch.status !== 'merged') {
    throw new Error(
      `رول‌بک فقط برای پچ‌های «مرج‌شده» مجاز است؛ وضعیت فعلی این پچ «${statusFa(patch.status)}» است.`,
    );
  }
  const mergeSha = (patch.merge_sha ?? '').trim();
  if (!mergeSha) {
    throw new Error('برای این پچ SHA کامیت مرج ثبت نشده؛ رول‌بک ممکن نیست.');
  }

  // ۳) اتصال گیت‌هاب
  const { token } = await getGithubConfig();
  if (!token) {
    throw new Error(
      'گیت‌هاب متصل نیست. توکن را در صفحه‌ی تنظیمات وارد کنید؛ بدون اتصال، رول‌بک ممکن نیست.',
    );
  }
  const repo = await resolveTargetRepo();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('نام ریپو نامعتبر است.');
  const h = ghHeaders(token);
  const api = `https://api.github.com/repos/${repo}`;

  // ۴) خواندن کامیت مرج و پیدا کردن والد اول (خط dev پیش از مرج)
  const mergeRes = await fetch(`${api}/commits/${mergeSha}`, {
    headers: h,
    signal: AbortSignal.timeout(15_000),
  });
  if (mergeRes.status === 404) {
    throw new Error(
      `کامیت مرج (${mergeSha.slice(0, 7)}) در گیت‌هاب پیدا نشد؛ شاید ریپو عوض شده یا کامیت پاک شده.`,
    );
  }
  if (!mergeRes.ok) throw new Error(`خواندن کامیت مرج ناموفق بود (وضعیت ${mergeRes.status}).`);
  const mergeCommit = (await mergeRes.json()) as GithubCommitBody;
  const firstParent = mergeCommit.parents?.[0]?.sha;
  if (!firstParent) {
    throw new Error('والد کامیت مرج پیدا نشد؛ ساختار کامیت غیرمنتظره است.');
  }

  // ۵) رأس فعلی dev؛ رول‌بک خودکار فقط وقتی که مرج هنوز رأس باشد
  const refRes = await fetch(`${api}/git/refs/heads/dev`, {
    headers: h,
    signal: AbortSignal.timeout(15_000),
  });
  if (refRes.status === 404) throw new Error('شاخه‌ی dev در گیت‌هاب پیدا نشد.');
  if (!refRes.ok) throw new Error(`خواندن رأس dev ناموفق بود (وضعیت ${refRes.status}).`);
  const refBody = (await refRes.json()) as GithubRefBody;
  const devSha = refBody.object?.sha;
  if (!devSha) throw new Error('SHA رأس dev پیدا نشد.');
  if (devSha !== mergeSha) {
    throw new Error(
      'شاخه‌ی dev از کامیت مرج جلوتر رفته است. رول‌بک خودکار فقط وقتی امن است که ' +
        'کامیت مرج، رأس فعلی dev باشد؛ لطفاً دستی بررسی و revert کنید.',
    );
  }

  // ۶) درخت والد اول = وضعیت دقیق پیش از مرج
  const parentRes = await fetch(`${api}/git/commits/${firstParent}`, {
    headers: h,
    signal: AbortSignal.timeout(15_000),
  });
  if (!parentRes.ok) throw new Error(`خواندن کامیت والد ناموفق بود (وضعیت ${parentRes.status}).`);
  const parentCommit = (await parentRes.json()) as GithubCommitBody;
  const parentTree = parentCommit.tree?.sha;
  if (!parentTree) throw new Error('درخت کامیت والد پیدا نشد.');

  // ۷) ساخت کامیت revert تازه (بدون force-push، بدون حذف تاریخچه)
  const message = buildRevertMessage({
    mergeSha,
    patchId: id,
    team: patch.team,
    summary: patch.summary,
    reason: options?.reason,
  });
  const commitRes = await fetch(`${api}/git/commits`, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      tree: parentTree,
      parents: [devSha],
      author: { name: COMMITTER_NAME, email: COMMITTER_EMAIL },
      committer: { name: COMMITTER_NAME, email: COMMITTER_EMAIL },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!commitRes.ok) {
    throw new Error(`ساخت کامیت revert ناموفق بود (وضعیت ${commitRes.status}).`);
  }
  const commitBody = (await commitRes.json()) as GithubCommitBody;
  const revertSha = commitBody.sha;
  if (!revertSha) throw new Error('SHA کامیت revert برنگشت.');

  // ۸) جلو بردن dev تا کامیت revert؛ fast-forward، هرگز force
  const updateRes = await fetch(`${api}/git/refs/heads/dev`, {
    method: 'PATCH',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: revertSha }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!updateRes.ok) {
    throw new Error(
      `کامیت revert ساخته شد (${revertSha.slice(0, 7)}) ولی جلو بردن شاخه‌ی dev ` +
        `ناموفق بود (وضعیت ${updateRes.status})؛ لطفاً دستی بررسی کنید.`,
    );
  }

  // ۹) ثبت وضعیت در دیتابیس
  const now = new Date().toISOString();
  const patchUpdate: Record<string, string> = {
    status: 'rolledback',
    decided_at: now,
    updated_at: now,
  };
  if (options?.decidedBy) patchUpdate.decided_by = options.decidedBy;
  const { error: dbError } = await sb.from('bridge_patches').update(patchUpdate).eq('id', id);
  if (dbError) {
    throw new Error(
      `کامیت revert روی dev ساخته شد (${revertSha.slice(0, 7)}) ولی ثبت وضعیت ` +
        `«رول‌بک‌شده» در دیتابیس ناموفق بود: ${dbError.message}؛ لطفاً دستی بررسی کنید.`,
    );
  }

  return { sha: revertSha };
}
