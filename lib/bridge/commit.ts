/**
 * lib/bridge/commit.ts: لایهٔ «پل» (bridge) برای اعمال پچ تیم‌ها روی ریپوی سایت.
 *
 * قانون سفت (دستور مسعود): هیچ‌وقت مستقیم روی dev یا main کامیت زده نمی‌شود.
 * هر پچ روی شاخهٔ ai-bridge/<patchId> (منشعب از dev ریپوی سایت) کامیت می‌شود
 * و بعد با Pull Request به dev پیشنهاد می‌شود.
 *
 * قرارداد توکن همان settings/github_token است (lib/github.ts).
 */

import { applyPatchViaGithub, getGithubConfig, type PatchFile } from '../github';

/** ریپوی سایت تایلندگرد. */
export const SITE_REPO = 'masoudroot/thailandgard';
/** شاخهٔ مبدأ انشعاب و مقصد PR پل: همیشه dev. */
export const BRIDGE_BASE_BRANCH = 'dev';
/** پیشوند شاخه‌های پل. */
export const BRIDGE_BRANCH_PREFIX = 'ai-bridge/';

export interface BridgeCommitResult {
  branch: string;
  sha: string;
}

export interface BridgePRResult {
  number: number;
  url: string;
}

const NOT_CONNECTED_MESSAGE =
  'گیت‌هاب متصل نیست. توکن شخصی گیت‌هاب را در صفحهٔ تنظیمات وارد کنید.';

/**
 * تمیزکاری شناسهٔ پچ برای نام شاخه: حروف کوچک، بدون کاراکتر خاص.
 * هر رشتهٔ دیگری به خط‌تیره تبدیل و خط‌تیره‌های تکراری یکی می‌شوند.
 */
function sanitizePatchId(patchId: string): string {
  const clean = String(patchId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (!clean) throw new Error('شناسهٔ پچ نامعتبر است؛ شاخهٔ پل ساخته نشد.');
  return clean;
}

/** نام کامل شاخهٔ پل برای یک شناسهٔ پچ. */
export function bridgeBranchName(patchId: string): string {
  return `${BRIDGE_BRANCH_PREFIX}${sanitizePatchId(patchId)}`;
}

/** تک‌خطی کردن رشته برای پیام کامیت و عنوان PR. */
function oneLine(value: string, max: number): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * کامیت پچ یک تیم روی شاخهٔ پل ai-bridge/<patchId> (منشعب از dev ریپوی سایت).
 * پیام کامیت: [<team>] <summary>؛ اگر summary داده نشود، خود patchId می‌نشیند.
 * خروجی: نام شاخه و SHA کامیت.
 */
export async function commitToBridgeBranch(
  patchId: string,
  files: PatchFile[],
  team: string,
  summary?: string,
): Promise<BridgeCommitResult> {
  const teamName = oneLine(team, 40);
  if (!teamName) throw new Error('نام تیم خالی است.');
  const branch = bridgeBranchName(patchId);
  const message = `[${teamName}] ${oneLine(summary || patchId, 120)}`;
  const result = await applyPatchViaGithub(branch, message, files, {
    repo: SITE_REPO,
    baseBranch: BRIDGE_BASE_BRANCH,
  });
  return { branch: result.branch, sha: result.commitSha };
}

function bridgeHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

interface GithubPRSummary {
  number?: number;
  html_url?: string;
}

/** اگر برای همین شاخه PR بازی هست، همان را برگردان (رفتار idempotent). */
async function findOpenBridgePR(
  api: string,
  h: Record<string, string>,
  head: string,
): Promise<BridgePRResult | null> {
  try {
    const owner = SITE_REPO.split('/')[0];
    const res = await fetch(
      `${api}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&base=${BRIDGE_BASE_BRANCH}&state=open`,
      { headers: h, signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) return null;
    const list = (await res.json()) as GithubPRSummary[];
    const pr = Array.isArray(list) ? list[0] : undefined;
    if (pr?.number && pr?.html_url) return { number: pr.number, url: pr.html_url };
    return null;
  } catch {
    return null;
  }
}

/**
 * ساخت Pull Request از شاخهٔ پل به dev ریپوی سایت.
 * فقط شاخه‌های ai-bridge/ پذیرفته می‌شوند؛ مقصد همیشه dev است.
 */
export async function createBridgePR(
  branch: string,
  title: string,
  body: string,
): Promise<BridgePRResult> {
  const head = branch.trim();
  if (!head.startsWith(BRIDGE_BRANCH_PREFIX)) {
    throw new Error('فقط شاخه‌های ai-bridge/ می‌توانند PR پل بسازند.');
  }
  const cleanTitle = oneLine(title, 150);
  if (!cleanTitle) throw new Error('عنوان PR خالی است.');
  const { token } = await getGithubConfig();
  if (!token) throw new Error(NOT_CONNECTED_MESSAGE);
  const h = bridgeHeaders(token);
  const api = `https://api.github.com/repos/${SITE_REPO}`;

  const existing = await findOpenBridgePR(api, h, head);
  if (existing) return existing;

  const res = await fetch(`${api}/pulls`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      title: cleanTitle,
      head,
      base: BRIDGE_BASE_BRANCH,
      body: body ?? '',
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ساخت PR ناموفق بود (وضعیت ${res.status}). ${detail.slice(0, 300)}`);
  }
  const pr = (await res.json()) as GithubPRSummary;
  if (!pr.number || !pr.html_url) throw new Error('پاسخ گیت‌هاب برای PR ناقص بود.');
  return { number: pr.number, url: pr.html_url };
}
