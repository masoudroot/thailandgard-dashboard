/**
 * lib/bridge.ts: لایهٔ تأیید مدیر پل اجرا (مهندس ۶).
 *
 * قرارداد معماری: docs/execution-bridge.md
 * اسکیمای جدول: supabase/migrations/20261015200000_bridge_patches.sql
 *   (+ 20261015201000 برای rejection_reason)
 *
 * - تنها منبع حقیقت وضعیت پچ‌ها، جدول bridge_patches است.
 * - مرج به dev فقط با تأیید صریح مدیر انجام می‌شود؛ این فایل هیچ مسیری
 *   برای مرج خودکار ندارد. مرج فقط از روت approve صدا زده می‌شود.
 * - شاخه‌های پل روی ریپوی سایت زندگی می‌کنند و مبنای مقایسه و مرج، dev است
 *   (ثابت‌های مشترک از lib/bridge/commit).
 * - قانون مسعود: هیچ دادهٔ نمایشی. اگر جدول نیست یا گیت‌هاب وصل نیست،
 *   خطای صادقانه برمی‌گردد.
 */

import { getSupabase } from './api';
import { getGithubConfig } from './github';
import { GithubError } from './github-changes';
import { BRIDGE_BASE_BRANCH, SITE_REPO } from './bridge/commit';

/** وضعیت‌های پچ طبق ماشین حالت docs/execution-bridge.md بخش ۶. */
export type BridgePatchStatus =
  | 'proposed'
  | 'gated'
  | 'committed'
  | 'approved'
  | 'merged'
  | 'rejected'
  | 'rolledback'
  | 'needs_review';

export const BRIDGE_STATUS_FA: Record<BridgePatchStatus, string> = {
  proposed: 'پیشنهادشده',
  gated: 'در دروازه',
  committed: 'کامیت‌شده',
  approved: 'تأییدشده',
  merged: 'مرج‌شده',
  rejected: 'ردشده',
  rolledback: 'برگردانده‌شده',
  needs_review: 'نیاز به بررسی',
};

/** یک فایل پچ در ستون files جدول. */
export interface BridgePatchFile {
  path: string;
  content: string;
}

/** ردیف کامل جدول bridge_patches. */
export interface BridgePatch {
  id: string;
  cycle_id: string | null;
  team: string | null;
  summary: string | null;
  files: BridgePatchFile[];
  status: BridgePatchStatus;
  branch: string | null;
  commit_sha: string | null;
  merge_sha: string | null;
  gate_errors: unknown;
  decided_by: string | null;
  decided_at: string | null;
  rejection_reason: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** نمای سبک پچ برای فهرست: بدون محتوای فایل‌ها، با فیلدهای مشتق. */
export interface BridgePatchSummary extends Omit<BridgePatch, 'files'> {
  files: never[];
  file_count: number;
  total_bytes: number;
  file_paths: string[];
  compare_url: string | null;
}

/** یک فایل در diff مقایسهٔ شاخهٔ پل با dev. */
export interface BridgeDiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /** متن unified diff؛ null یعنی باینری/خیلی بزرگ. */
  patch: string | null;
}

/** خلاصهٔ مقایسهٔ شاخهٔ پل با dev از GitHub API. */
export interface BridgeDiff {
  base: string;
  head: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
  files: BridgeDiffFile[];
  compare_url: string;
  truncated: boolean;
}

export interface BridgeMergeResult {
  sha: string | null;
  /** true یعنی چیزی برای مرج نبود (PR از قبل مرج شده یا شاخه جلوتر نیست). */
  already_merged: boolean;
  /** شمارهٔ PRای که مرج شد؛ null یعنی مرج مستقیم. */
  pr_number: number | null;
}

const VALID_STATUSES = new Set<string>([
  'proposed',
  'gated',
  'committed',
  'approved',
  'merged',
  'rejected',
  'rolledback',
  'needs_review',
]);

const SUMMARY_COLUMNS =
  'id,cycle_id,team,summary,files,status,branch,commit_sha,merge_sha,gate_errors,decided_by,decided_at,rejection_reason,created_at,updated_at';
/** ستون‌ها بدون rejection_reason؛ برای دیتابیسی که مایگریشن جدید را ندارد. */
const SUMMARY_COLUMNS_BASE =
  'id,cycle_id,team,summary,files,status,branch,commit_sha,merge_sha,gate_errors,decided_by,decided_at,created_at,updated_at';

/** خطای دیتابیس با کد PostgREST، برای تصمیم‌گیری صادقانه در روت‌ها. */
export class BridgeDbError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'BridgeDbError';
    this.code = code;
  }
}

function dbErrorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return undefined;
}

/** true یعنی ستونی که می‌خواهیم در دیتابیس نیست (مایگریشن جدید اعمال نشده). */
export function isMissingColumnError(err: unknown): boolean {
  return dbErrorCode(err) === '42703';
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function patchFiles(v: unknown): BridgePatchFile[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (f): f is Record<string, unknown> =>
        !!f && typeof f === 'object' && typeof (f as Record<string, unknown>).path === 'string',
    )
    .map((f) => ({
      path: String(f.path),
      content: typeof f.content === 'string' ? f.content : '',
    }));
}

/** نگاشت سطر خام دیتابیس به BridgePatch با پیش‌فرض‌های امن. */
function toBridgePatch(row: Record<string, unknown>): BridgePatch {
  const statusRaw = str(row.status);
  return {
    id: String(row.id ?? ''),
    cycle_id: str(row.cycle_id),
    team: str(row.team),
    summary: str(row.summary),
    files: patchFiles(row.files),
    status: (statusRaw && VALID_STATUSES.has(statusRaw) ? statusRaw : 'proposed') as BridgePatchStatus,
    branch: str(row.branch),
    commit_sha: str(row.commit_sha),
    merge_sha: str(row.merge_sha),
    gate_errors: row.gate_errors ?? null,
    decided_by: str(row.decided_by),
    decided_at: str(row.decided_at),
    rejection_reason: str(row.rejection_reason),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

/** لینک مقایسهٔ شاخهٔ پل با dev در گیت‌هاب. */
export function patchCompareUrl(patch: Pick<BridgePatch, 'branch'>): string | null {
  if (!patch.branch) return null;
  return `https://github.com/${SITE_REPO}/compare/${BRIDGE_BASE_BRANCH}...${patch.branch}`;
}

function toSummary(patch: BridgePatch): BridgePatchSummary {
  const file_paths = patch.files.map((f) => f.path);
  const total_bytes = patch.files.reduce((s, f) => s + f.content.length, 0);
  return {
    ...patch,
    files: [],
    file_count: patch.files.length,
    total_bytes,
    file_paths,
    compare_url: patchCompareUrl(patch),
  };
}

/** true یعنی خطا از نبود جدول bridge_patches است (هنوز ساخته نشده). */
export function isMissingTableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === 'PGRST205') return true;
  return (
    typeof e.message === 'string' &&
    e.message.includes('bridge_patches') &&
    e.message.includes('schema cache')
  );
}

export interface ListPatchesOptions {
  /** یک وضعیت یا چند وضعیت با کاما، مثل «approved,merged». */
  status?: string;
  team?: string;
  limit?: number;
}

/**
 * فهرست پچ‌ها از جدول bridge_patches (نمای سبک، بدون محتوای فایل‌ها).
 * اگر جدول هنوز ساخته نشده باشد، آرایهٔ خالی برمی‌گردد (نه خطا).
 * اگر ستون rejection_reason هنوز نباشد، بدون آن خوانده می‌شود.
 */
export async function listBridgePatches(opts: ListPatchesOptions = {}): Promise<BridgePatchSummary[]> {
  const sb = getSupabase();
  const statuses = (opts.status ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => VALID_STATUSES.has(s));
  const buildQuery = (columns: string) => {
    let query = sb
      .from('bridge_patches')
      .select(columns)
      .order('created_at', { ascending: false })
      .limit(opts.limit ?? 100);
    if (statuses.length === 1) query = query.eq('status', statuses[0]);
    else if (statuses.length > 1) query = query.in('status', statuses);
    if (opts.team?.trim()) query = query.eq('team', opts.team.trim());
    return query;
  };

  let { data, error } = await buildQuery(SUMMARY_COLUMNS);
  if (error && isMissingColumnError(error)) {
    ({ data, error } = await buildQuery(SUMMARY_COLUMNS_BASE));
  }
  if (error) {
    if (isMissingTableError(error)) return [];
    throw new BridgeDbError(`خواندن پچ‌ها ناموفق بود: ${error.message}`, dbErrorCode(error));
  }
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => toSummary(toBridgePatch(row)));
}

/** خواندن یک پچ کامل؛ null یعنی نیست (یا جدول نیست). */
export async function getBridgePatch(id: string): Promise<BridgePatch | null> {
  const sb = getSupabase();
  let { data, error } = await sb
    .from('bridge_patches')
    .select(SUMMARY_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error && isMissingColumnError(error)) {
    ({ data, error } = await sb
      .from('bridge_patches')
      .select(SUMMARY_COLUMNS_BASE)
      .eq('id', id)
      .maybeSingle());
  }
  if (error) {
    if (isMissingTableError(error)) return null;
    throw new BridgeDbError(`خواندن پچ ناموفق بود: ${error.message}`, dbErrorCode(error));
  }
  if (!data) return null;
  return toBridgePatch(data as Record<string, unknown>);
}

/** به‌روزرسانی فیلدهای یک پچ و برگرداندن سطر تازه. */
export async function updateBridgePatch(
  id: string,
  fields: Record<string, string | number | boolean | null>,
): Promise<BridgePatch> {
  const sb = getSupabase();
  const runUpdate = (columns: string) =>
    sb
      .from('bridge_patches')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select(columns)
      .single();
  let { data, error } = await runUpdate(SUMMARY_COLUMNS);
  if (error && isMissingColumnError(error)) {
    ({ data, error } = await runUpdate(SUMMARY_COLUMNS_BASE));
  }
  if (error) {
    throw new BridgeDbError(`به‌روزرسانی پچ ناموفق بود: ${error.message}`, dbErrorCode(error));
  }
  return toBridgePatch(data as unknown as Record<string, unknown>);
}

/**
 * ادعای اتمیک یک پچ proposed برای پردازش.
 *
 * به‌روزرسانی شرطی proposed ← gated در یک کوئری واحد انجام می‌شود؛
 * اگر دو ورکر هم‌زمان همین پچ را بردارند، فقط یکی موفق می‌شود و دیگری
 * null می‌گیرد (پردازش موازی یک پچ غیرممکن است).
 *
 * برمی‌گرداند: ردیف تازه در صورت موفقیت، null اگر پچ دیگر proposed نبود.
 */
export async function claimBridgePatch(id: string): Promise<BridgePatch | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('bridge_patches')
    .update({ status: 'gated', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'proposed')
    .select(SUMMARY_COLUMNS)
    .maybeSingle();
  if (error) {
    throw new BridgeDbError(`ادعای پچ ناموفق بود: ${error.message}`, dbErrorCode(error));
  }
  if (!data) return null;
  return toBridgePatch(data as unknown as Record<string, unknown>);
}

/* ------------------------------------------------------------------ */
/*  گیت‌هاب: مقایسه و مرج                                              */
/* ------------------------------------------------------------------ */

const PATCH_TRUNCATE_CHARS = 6000;
const MAX_DIFF_FILES = 50;

interface GithubComparePayload {
  ahead_by?: number;
  behind_by?: number;
  total_commits?: number;
  html_url?: string;
  permalink_url?: string;
  files?: Array<{
    filename?: string;
    status?: string;
    additions?: number;
    deletions?: number;
    patch?: string;
  }>;
}

interface GithubPRItem {
  number?: number;
  html_url?: string;
  merged?: boolean;
  merge_commit_sha?: string | null;
  state?: string;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

const GITHUB_NOT_CONNECTED = 'گیت‌هاب متصل نیست؛ توکن را در تنظیمات وارد کنید.';

/**
 * مقایسهٔ شاخهٔ پل با dev از GitHub API.
 * خطای صادقانه می‌دهد؛ هیچ دادهٔ نمایشی تولید نمی‌کند.
 */
export async function compareBranchWithDev(branch: string): Promise<BridgeDiff> {
  const { token } = await getGithubConfig();
  if (!token) throw new GithubError(GITHUB_NOT_CONNECTED, { notConnected: true, status: 503 });
  const url =
    `https://api.github.com/repos/${SITE_REPO}/compare/` +
    `${encodeURIComponent(BRIDGE_BASE_BRANCH)}...${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: githubHeaders(token),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) {
    throw new GithubError(
      `شاخهٔ «${branch}» یا مبنای «${BRIDGE_BASE_BRANCH}» در ریپوی ${SITE_REPO} پیدا نشد.`,
      { status: 404 },
    );
  }
  if (!res.ok) {
    throw new GithubError(`مقایسهٔ شاخه‌ها ناموفق بود (وضعیت ${res.status}).`, {
      status: res.status,
    });
  }
  const body = (await res.json()) as GithubComparePayload;
  const rawFiles = Array.isArray(body.files) ? body.files : [];
  const truncated = rawFiles.length > MAX_DIFF_FILES;
  const files: BridgeDiffFile[] = rawFiles.slice(0, MAX_DIFF_FILES).map((f) => {
    const rawPatch = typeof f.patch === 'string' ? f.patch : null;
    return {
      filename: f.filename ?? 'نامشخص',
      status: f.status ?? 'changed',
      additions: typeof f.additions === 'number' ? f.additions : 0,
      deletions: typeof f.deletions === 'number' ? f.deletions : 0,
      patch:
        rawPatch && rawPatch.length > PATCH_TRUNCATE_CHARS
          ? rawPatch.slice(0, PATCH_TRUNCATE_CHARS)
          : rawPatch,
    };
  });
  const additions = files.reduce((s, f) => s + f.additions, 0);
  const deletions = files.reduce((s, f) => s + f.deletions, 0);
  return {
    base: BRIDGE_BASE_BRANCH,
    head: branch,
    ahead_by: typeof body.ahead_by === 'number' ? body.ahead_by : 0,
    behind_by: typeof body.behind_by === 'number' ? body.behind_by : 0,
    total_commits: typeof body.total_commits === 'number' ? body.total_commits : 0,
    additions,
    deletions,
    changed_files: rawFiles.length,
    files,
    compare_url:
      body.permalink_url ??
      body.html_url ??
      `https://github.com/${SITE_REPO}/compare/${BRIDGE_BASE_BRANCH}...${branch}`,
    truncated,
  };
}

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
 * مرج شاخهٔ پل به dev. فقط از روت approve صدا زده می‌شود (قانون بخش ۳ سند).
 * - اگر PR بازی برای شاخه باشد، همان PR مرج می‌شود؛
 * - وگرنه شاخه مستقیم به dev مرج می‌شود.
 */
export async function mergeBranchIntoDev(branch: string): Promise<BridgeMergeResult> {
  const { token } = await getGithubConfig();
  if (!token) throw new GithubError(GITHUB_NOT_CONNECTED, { notConnected: true, status: 503 });
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
