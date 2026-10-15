/**
 * lib/github.ts: اتصال واقعی به GitHub API برای بخش «دستیار فنی».
 *
 * قانون مطلق مسعود: بدون دادهٔ نمایشی. اگر توکن گیت‌هاب در settings یا env
 * نباشد، همه‌ی توابع اتصال { connected: false } برمی‌گردانند و صداکننده
 * باید صادقانه به کاربر بگوید «متصل نیست».
 *
 * ترتیب جست‌وجوی توکن: settings (کلید github_token) ← env GITHUB_TOKEN.
 * ریپوی پیش‌فرض: masoudroot/thailandgard-dashboard (قابل بازنویسی با
 * settings کلید github_repo یا env GITHUB_REPO).
 */

import { getSetting } from './settings';
import type { TeamName } from './types';

export const DEFAULT_REPO = 'masoudroot/thailandgard-dashboard';
/** ریپوی سایت تایلندگرد؛ تیم‌ها تغییراتشان را اینجا کامیت می‌کنند. */
export const SITE_REPO_FULL = 'masoudroot/thailandgard';
export const COMMITTER_NAME = 'Masoud Akbari';
export const COMMITTER_EMAIL = 'masoud.akbari.ai@gmail.com';

export interface GithubConfig {
  token: string | null;
  repo: string;
}

export interface GithubStatus {
  connected: boolean;
  repo: string;
  user?: string;
  /** پیام فارسی صادقانه برای نمایش به کاربر وقتی متصل نیست. */
  message: string;
}

export interface GithubCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

import type { PatchFile } from './types';
export type { PatchFile } from './types';

const NOT_CONNECTED_MESSAGE =
  'گیت‌هاب متصل نیست. برای اتصال خودکار، توکن شخصی گیت‌هاب را در صفحهٔ تنظیمات وارد کنید؛ تا آن‌موقع فیکس به‌صورت قابل کپی داده می‌شود.';

/** خواندن توکن و ریپو از settings و env. */
export async function getGithubConfig(): Promise<GithubConfig> {
  let token: string | null = null;
  let repo = DEFAULT_REPO;
  try {
    const storedToken = await getSetting<string | { token?: string } | null>('github_token', null);
    if (typeof storedToken === 'string' && storedToken.trim()) {
      token = storedToken.trim();
    } else if (storedToken && typeof storedToken === 'object' && storedToken.token) {
      token = String(storedToken.token).trim();
    }
    const storedRepo = await getSetting<string | null>('github_repo', null);
    if (typeof storedRepo === 'string' && storedRepo.trim()) {
      repo = storedRepo.trim();
    }
  } catch {
    // settings در دسترس نیست؛ به env تکیه می‌کنیم
  }
  if (!token && process.env.GITHUB_TOKEN) token = process.env.GITHUB_TOKEN.trim();
  if (process.env.GITHUB_REPO && process.env.GITHUB_REPO.trim()) repo = process.env.GITHUB_REPO.trim();
  return { token: token || null, repo };
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** وضعیت اتصال گیت‌هاب؛ با یک فراخوانی سبک (/user) راستی می‌شود. */
export async function githubStatus(): Promise<GithubStatus> {
  const { token, repo } = await getGithubConfig();
  if (!token) {
    return { connected: false, repo, message: NOT_CONNECTED_MESSAGE };
  }
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: headers(token),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return {
        connected: false,
        repo,
        message: `توکن گیت‌هاب نامعتبر است (وضعیت ${res.status})؛ در تنظیمات توکن تازه وارد کنید.`,
      };
    }
    const body = (await res.json()) as { login?: string };
    return {
      connected: true,
      repo,
      user: body.login,
      message: `گیت‌هاب متصل است (${body.login ?? 'نامشخص'}).`,
    };
  } catch (err) {
    return {
      connected: false,
      repo,
      message: `خطا در بررسی اتصال گیت‌هاب: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** آخرین کامیت‌های شاخهٔ master از GitHub API واقعی. */
export async function fetchRecentCommits(count = 8): Promise<GithubCommit[]> {
  const { token, repo } = await getGithubConfig();
  if (!token) throw new Error(NOT_CONNECTED_MESSAGE);
  const res = await fetch(
    `https://api.github.com/repos/${repo}/commits?per_page=${Math.min(count, 20)}&sha=master`,
    { headers: headers(token), signal: AbortSignal.timeout(20_000) },
  );
  if (!res.ok) throw new Error(`خواندن کامیت‌ها ناموفق بود (وضعیت ${res.status}).`);
  const list = (await res.json()) as Array<{
    sha: string;
    commit: { message: string; author: { name?: string; date?: string } };
  }>;
  return list.map((c) => ({
    sha: c.sha.slice(0, 7),
    message: (c.commit.message ?? '').split('\n')[0].slice(0, 120),
    author: c.commit.author?.name ?? 'نامشخص',
    date: c.commit.author?.date ?? '',
  }));
}

/** خواندن محتوای یک فایل از ریپوی گیت‌هاب (شاخهٔ master). null یعنی فایل نیست. */
export async function readRepoFile(path: string): Promise<string | null> {
  const { token, repo } = await getGithubConfig();
  if (!token) throw new Error(NOT_CONNECTED_MESSAGE);
  const clean = path.replace(/^\/+/, '');
  const res = await fetch(
    `https://api.github.com/repos/${repo}/contents/${clean}?ref=master`,
    { headers: headers(token), signal: AbortSignal.timeout(20_000) },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`خواندن فایل «${clean}» ناموفق بود (وضعیت ${res.status}).`);
  const body = (await res.json()) as { content?: string; encoding?: string };
  if (!body.content || body.encoding !== 'base64') return null;
  return Buffer.from(body.content, 'base64').toString('utf-8');
}

function validateFiles(files: PatchFile[]): void {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('لیست فایل‌های پچ خالی است؛ چیزی برای اعمال نیست.');
  }
  if (files.length > 10) throw new Error('حداکثر ۱۰ فایل در هر اعمال پشتیبانی می‌شود.');
  for (const f of files) {
    if (typeof f.path !== 'string' || !f.path.trim()) throw new Error('مسیر یک فایل نامعتبر است.');
    const p = f.path.trim().replace(/^\/+/, '');
    if (p.includes('..') || p.startsWith('.git') || p.includes('.env')) {
      throw new Error(`مسیر غیرمجاز در پچ: ${p}`);
    }
    if (typeof f.content !== 'string') throw new Error(`محتوای فایل «${p}» نامعتبر است.`);
    if (f.content.length > 200_000) throw new Error(`فایل «${p}» بیش از حد بزرگ است.`);
  }
}

export interface ApplyResult {
  branch: string;
  commitSha: string;
  compareUrl: string;
}

export interface ApplyPatchOptions {
  /** ریپوی هدف به شکل owner/name؛ پیش‌فرض: ریپوی کانفیگ‌شده (settings یا env). */
  repo?: string;
  /** شاخهٔ مبدأ برای انشعاب؛ پیش‌فرض: master. */
  baseBranch?: string;
}

/**
 * شاخه‌های محافظت‌شده: کامیت مستقیم روی آن‌ها ممنوع است.
 * پچ‌ها فقط روی شاخهٔ پل (مثل ai-bridge/...) کامیت می‌شوند و با PR به مقصد می‌روند.
 */
const PROTECTED_BRANCHES = new Set(['main', 'master', 'dev', 'production', 'prod', 'staging']);

/**
 * اعمال فیکس روی گیت‌هاب: ساخت شاخهٔ تازه از شاخهٔ مبدأ، کامیت، برگرداندن لینک مقایسه.
 * هویت کامیت همیشه Masoud Akbari است.
 * قانون سفت: هرگز روی شاخهٔ محافظت‌شده (dev/main/...) کامیت مستقیم نمی‌زند؛ فقط شاخهٔ پل + PR.
 */
export async function applyPatchViaGithub(
  branch: string,
  message: string,
  files: PatchFile[],
  options?: ApplyPatchOptions,
): Promise<ApplyResult> {
  const { token, repo: configuredRepo } = await getGithubConfig();
  if (!token) throw new Error(NOT_CONNECTED_MESSAGE);
  if (!/^[a-zA-Z0-9/_.-]{1,100}$/.test(branch)) {
    throw new Error('نام شاخه نامعتبر است.');
  }
  if (PROTECTED_BRANCHES.has(branch.toLowerCase())) {
    throw new Error('کامیت مستقیم روی شاخهٔ محافظت‌شده ممنوع است؛ فقط شاخهٔ پل + PR.');
  }
  if (!message.trim()) throw new Error('پیام کامیت خالی است.');
  validateFiles(files);
  const repo = options?.repo?.trim() || configuredRepo;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('نام ریپو نامعتبر است.');
  const baseBranch = options?.baseBranch?.trim() || 'master';
  if (!/^[a-zA-Z0-9/_.-]{1,100}$/.test(baseBranch)) {
    throw new Error('نام شاخهٔ مبدأ نامعتبر است.');
  }
  const h = headers(token);
  const api = `https://api.github.com/repos/${repo}`;

  // ۱) SHA رأس شاخهٔ مبدأ
  const refRes = await fetch(`${api}/git/refs/heads/${baseBranch}`, {
    headers: h,
    signal: AbortSignal.timeout(15_000),
  });
  if (!refRes.ok) throw new Error(`خواندن رأس ${baseBranch} ناموفق بود (وضعیت ${refRes.status}).`);
  const refBody = (await refRes.json()) as { object?: { sha?: string } };
  const baseSha = refBody.object?.sha;
  if (!baseSha) throw new Error(`SHA رأس ${baseBranch} پیدا نشد.`);

  // ۲) ساخت شاخه
  const branchRes = await fetch(`${api}/git/refs`, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!branchRes.ok) {
    const detail = await branchRes.text().catch(() => '');
    throw new Error(
      `ساخت شاخه ناموفق بود (وضعیت ${branchRes.status}).${branchRes.status === 422 ? ' شاید شاخه از قبل هست.' : ''} ${detail.slice(0, 200)}`,
    );
  }

  // ۳) بلاب برای هر فایل
  const blobs: Array<{ path: string; sha: string }> = [];
  for (const f of files) {
    const p = f.path.trim().replace(/^\/+/, '');
    const blobRes = await fetch(`${api}/git/blobs`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: f.content, encoding: 'utf-8' }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!blobRes.ok) throw new Error(`ساخت بلاب برای «${p}» ناموفق بود (وضعیت ${blobRes.status}).`);
    const blobBody = (await blobRes.json()) as { sha?: string };
    if (!blobBody.sha) throw new Error(`SHA بلاب برای «${p}» برنگشت.`);
    blobs.push({ path: p, sha: blobBody.sha });
  }

  // ۴) درخت + کامیت
  const treeRes = await fetch(`${api}/git/trees`, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_tree: baseSha,
      tree: blobs.map((b) => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha })),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!treeRes.ok) throw new Error(`ساخت درخت گیت ناموفق بود (وضعیت ${treeRes.status}).`);
  const treeBody = (await treeRes.json()) as { sha?: string };
  if (!treeBody.sha) throw new Error('SHA درخت برنگشت.');

  const commitRes = await fetch(`${api}/git/commits`, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: message.trim(),
      tree: treeBody.sha,
      parents: [baseSha],
      author: { name: COMMITTER_NAME, email: COMMITTER_EMAIL },
      committer: { name: COMMITTER_NAME, email: COMMITTER_EMAIL },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!commitRes.ok) throw new Error(`ساخت کامیت ناموفق بود (وضعیت ${commitRes.status}).`);
  const commitBody = (await commitRes.json()) as { sha?: string };
  if (!commitBody.sha) throw new Error('SHA کامیت برنگشت.');

  // ۵) به‌روزرسانی رأس شاخه
  const updateRes = await fetch(`${api}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: commitBody.sha }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!updateRes.ok) throw new Error(`به‌روزرسانی شاخه ناموفق بود (وضعیت ${updateRes.status}).`);

  return {
    branch,
    commitSha: commitBody.sha.slice(0, 7),
    compareUrl: `https://github.com/${repo}/compare/${baseBranch}...${branch}`,
  };
}

/** پسوند تصادفی کوتاه برای یکتایی نام شاخه. */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * شاخهٔ پیش‌فرض یک ریپو از GitHub API (برای ریپوهایی که main دارند نه master).
 */
async function getDefaultBranch(repo: string, token: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: headers(token),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`خواندن اطلاعات ریپو ناموفق بود (وضعیت ${res.status}).`);
  const body = (await res.json()) as { default_branch?: string };
  return body.default_branch?.trim() || 'master';
}

/**
 * کامیت تغییرات یک تیم روی ریپوی سایت (masoudroot/thailandgard).
 * یک شاخهٔ تازه می‌سازد (team/<team>-<timestamp>-<rand>) از روی شاخهٔ
 * پیش‌فرض ریپو، فایل‌ها را کامیت می‌کند و اطلاعات شاخه + لینک مقایسه
 * را برمی‌گرداند. در صورت تداخل نام شاخه (۴۲۲)، یک بار با نام تازه
 * تلاش مجدد می‌کند.
 */
export async function commitTeamChanges(
  team: TeamName,
  files: PatchFile[],
  message: string,
): Promise<ApplyResult> {
  const { token } = await getGithubConfig();
  if (!token) throw new Error(NOT_CONNECTED_MESSAGE);
  const baseBranch = await getDefaultBranch(SITE_REPO_FULL, token);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const makeBranch = () => `team/${team}-${stamp}-${randomSuffix()}`;
  const opts = { repo: SITE_REPO_FULL, baseBranch };
  try {
    return await applyPatchViaGithub(makeBranch(), message, files, opts);
  } catch (err) {
    if (err instanceof Error && err.message.includes('(وضعیت 422)')) {
      return await applyPatchViaGithub(makeBranch(), message, files, opts);
    }
    throw err;
  }
}

/** حذف یک شاخهٔ team/ از ریپوی سایت (برای پاک‌سازی تست‌ها). */
export async function deleteSiteBranch(branch: string): Promise<void> {
  const { token } = await getGithubConfig();
  if (!token) throw new Error(NOT_CONNECTED_MESSAGE);
  if (!/^[a-zA-Z0-9/_.-]{1,100}$/.test(branch)) {
    throw new Error('نام شاخه نامعتبر است.');
  }
  if (!branch.startsWith('team/')) {
    throw new Error('فقط شاخه‌های team/ قابل حذف‌اند.');
  }
  const res = await fetch(
    `https://api.github.com/repos/${SITE_REPO_FULL}/git/refs/heads/${branch}`,
    { method: 'DELETE', headers: headers(token), signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`حذف شاخه ناموفق بود (وضعیت ${res.status}).`);
  }
}
