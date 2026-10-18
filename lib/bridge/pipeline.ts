/**
 * lib/bridge/pipeline.ts: منطق چرخهٔ عمر پچ پل (تیم ← ریپوی سایت).
 *
 * وضعیت‌ها (مطابق جدول bridge_patches):
 *   proposed → gated → committed → approved → merged
 *   rejected / rolledback وضعیت‌های پایانی‌اند.
 *
 * ترتیب دروازه‌ها:
 * ۱. gateAndCommit: دروازهٔ کیفیت (lib/quality-gate)؛ قرمز یعنی ماندن در
 *    proposed + ثبت gate_errors؛ سبز یعنی کامیت روی شاخهٔ ai-bridge و وضعیت committed.
 * ۲. approvePatch: فقط با توکن معتبر مدیر؛ وگرنه خطای ۴۰۱.
 * ۳. mergePatch: ادغام شاخهٔ پل در dev ریپوی سایت.
 * ۴. rollbackPatch: فقط روی پچ merged؛ ساخت کامیت revert روی dev.
 *
 * ذخیره‌سازی از بیرون تزریق می‌شود (PatchStore) تا تست بدون دیتابیس واقعی
 * و کد پروداکشن با Supabase کار کند. همهٔ تماس‌های گیت‌هاب از fetch سراسری
 * می‌گذرند تا در تست mock شوند؛ هیچ تماس واقعی در تست گرفته نمی‌شود.
 */

import { validatePatch } from './gate';
import { commitToBridgeBranch, SITE_REPO } from './commit';
import { getGithubConfig } from '../github';
import { preMergeTypeCheck } from './pre-merge-check';
import type { PatchFile } from '../github';

export type BridgePatchStatus =
  | 'proposed'
  | 'gated'
  | 'committed'
  | 'approved'
  | 'merged'
  | 'rejected'
  | 'rolledback'
  | 'needs_review';

export interface BridgePatch {
  id: string;
  team: string;
  summary: string;
  files: PatchFile[];
  status: BridgePatchStatus;
  branch?: string;
  commit_sha?: string;
  merge_sha?: string;
  revert_sha?: string;
  gate_errors?: string[];
  rejection_reason?: string;
  decided_by?: string;
  decided_at?: string;
  created_at: string;
  updated_at: string;
}

/** ذخیره‌سازی پچ؛ در تست حافظه‌ای، در پروداکشن روی bridge_patches. */
export interface PatchStore {
  get(id: string): BridgePatch | undefined;
  save(patch: BridgePatch): void;
}

export function createMemoryStore(): PatchStore {
  const map = new Map<string, BridgePatch>();
  return {
    get: (id: string) => map.get(id),
    save: (patch: BridgePatch) => {
      map.set(patch.id, patch);
    },
  };
}

/** خطای HTTP با کد وضعیت؛ برای ۴۰۱ و ۴۰۴ در لایهٔ پل. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const nowIso = (): string => new Date().toISOString();

let patchSeq = 0;

/** ثبت پچ تازهٔ یک تیم؛ وضعیت اولیه proposed. */
export function proposePatch(
  store: PatchStore,
  team: string,
  files: PatchFile[],
  summary = '',
): BridgePatch {
  const cleanTeam = team.trim();
  if (!cleanTeam) throw new Error('نام تیم خالی است.');
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('پچ بدون فایل پذیرفته نیست.');
  }
  const patch: BridgePatch = {
    id: `patch-${Date.now().toString(36)}-${(patchSeq++).toString(36)}`,
    team: cleanTeam,
    summary: summary.trim(),
    files,
    status: 'proposed',
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  store.save(patch);
  return patch;
}

export interface GateCommitResult {
  patch: BridgePatch;
  gatePassed: boolean;
}

/**
 * دروازهٔ کیفیت و سپس کامیت.
 * - gate قرمز: وضعیت همان proposed می‌ماند و gate_errors ثبت می‌شود.
 * - gate سبز: کامیت روی شاخهٔ ai-bridge/<id> و وضعیت committed.
 */
export async function gateAndCommit(
  store: PatchStore,
  patchId: string,
): Promise<GateCommitResult> {
  const patch = store.get(patchId);
  if (!patch) throw new HttpError(404, 'پچ پیدا نشد.');
  if (patch.status !== 'proposed') {
    throw new Error(`فقط پچ proposed از دروازه رد می‌شود (وضعیت فعلی: ${patch.status}).`);
  }
  // قیف یکپارچه (ممیزی مسیرهای دورزن C4): همان دروازهٔ کیفیت حلقهٔ زندهٔ
  // پل (processProposedPatch)، نه دروازهٔ ضعیف‌تر quality-gate. همهٔ مسیرها
  // باید از یک قیف رد شوند.
  const gate = validatePatch(patch.files);
  if (!gate.ok) {
    patch.gate_errors = gate.errors;
    patch.updated_at = nowIso();
    store.save(patch);
    return { patch, gatePassed: false };
  }
  patch.status = 'gated';
  patch.updated_at = nowIso();
  store.save(patch);

  const { branch, sha } = await commitToBridgeBranch(
    patch.id,
    patch.files,
    patch.team,
    patch.summary || patch.id,
  );
  patch.branch = branch;
  patch.commit_sha = sha;
  patch.status = 'committed';
  patch.updated_at = nowIso();
  store.save(patch);
  return { patch, gatePassed: true };
}

export interface ApproveContext {
  /** توکن مدیر؛ معمولاً از هدر Authorization می‌آید. */
  managerToken?: string;
  /** راستی‌آزمایی توکن؛ در پروداکشن همان verifyManagerToken است. */
  verifyManagerToken: (token: string) => Promise<boolean>;
}

/**
 * تأیید مدیر برای انتشار. بدون توکن معتبر مدیر ← خطای ۴۰۱.
 */
export async function approvePatch(
  store: PatchStore,
  patchId: string,
  ctx: ApproveContext,
): Promise<BridgePatch> {
  const token = (ctx.managerToken ?? '').trim();
  const ok = token.length > 0 && (await ctx.verifyManagerToken(token));
  if (!ok) {
    throw new HttpError(401, 'احراز مدیر لازم است؛ توکن معتبر مدیریتی بفرستید.');
  }
  const patch = store.get(patchId);
  if (!patch) throw new HttpError(404, 'پچ پیدا نشد.');
  if (patch.status !== 'committed') {
    throw new Error(`فقط پچ committed تأیید می‌شود (وضعیت فعلی: ${patch.status}).`);
  }
  patch.status = 'approved';
  patch.decided_by = 'manager';
  patch.decided_at = nowIso();
  patch.updated_at = nowIso();
  store.save(patch);
  return patch;
}

/** فراخوانی کمکی به GitHub API؛ در تست با mock جایگزین می‌شود. */
async function ghApi(path: string, token: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`فراخوانی GitHub API ناموفق بود (${res.status}).`);
  }
  return res.json();
}

async function githubTokenOrThrow(): Promise<string> {
  const { token } = await getGithubConfig();
  if (!token) throw new Error('توکن گیت‌هاب در دسترس نیست.');
  return token;
}

/**
 * ادغام شاخهٔ پل در dev ریپوی سایت. فقط از وضعیت approved.
 */
export async function mergePatch(
  store: PatchStore,
  patchId: string,
): Promise<BridgePatch> {
  const patch = store.get(patchId);
  if (!patch) throw new HttpError(404, 'پچ پیدا نشد.');
  if (patch.status !== 'approved') {
    throw new Error(`فقط پچ approved مرج می‌شود (وضعیت فعلی: ${patch.status}).`);
  }
  if (!patch.branch) throw new Error('شاخهٔ پل برای این پچ ثبت نشده است.');

  // بررسی تایپ پیش از مرج (گلوگاه ۵): پچ روی کلون تازه اعمال و tsc اجرا می‌شود.
  // اگر خطا داشت، پچ برمی‌گردد و به وضعیت rejected می‌رود.
  const siteRepoUrl = `https://github.com/${SITE_REPO}.git`;
  const preCheck = await preMergeTypeCheck(patch.files, siteRepoUrl, 'dev');
  if (!preCheck.passed) {
    patch.status = 'rejected';
    patch.rejection_reason = `تایپ‌چک پیش‌مرج رد شد: ${preCheck.message} ${preCheck.errors.slice(0, 3).join(' | ')}`;
    patch.updated_at = nowIso();
    store.save(patch);
    throw new Error(patch.rejection_reason);
  }

  const token = await githubTokenOrThrow();
  const body = (await ghApi(`/repos/${SITE_REPO}/merges`, token, {
    method: 'POST',
    body: JSON.stringify({
      base: 'dev',
      head: patch.branch,
      commit_message: `[bridge] merge ${patch.branch}`,
    }),
  })) as { sha?: string };
  if (!body?.sha) throw new Error('SHA مرج از گیت‌هاب برنگشت.');
  patch.merge_sha = body.sha.slice(0, 7);
  patch.status = 'merged';
  patch.updated_at = nowIso();
  store.save(patch);
  return patch;
}

interface GithubCommitInfo {
  sha?: string;
  tree?: { sha?: string };
  parents?: Array<{ sha?: string }>;
}

interface GithubRefInfo {
  object?: { sha?: string };
}

/**
 * بازگردانی: فقط روی پچ merged.
 * یک کامیت revert روی dev می‌سازد (درخت = درخت والد اول کامیت مرج،
 * یعنی devِ پیش از مرج) و وضعیت را rolledback می‌کند.
 * روی هر وضعیت دیگری (از جمله proposed) خطا می‌دهد و هیچ revertی ساخته نمی‌شود.
 */
export async function rollbackPatch(
  store: PatchStore,
  patchId: string,
): Promise<BridgePatch> {
  const patch = store.get(patchId);
  if (!patch) throw new HttpError(404, 'پچ پیدا نشد.');
  if (patch.status === 'rolledback') {
    throw new Error('این پچ قبلاً بازگردانی شده است.');
  }
  if (patch.status !== 'merged') {
    throw new Error(`بازگردانی فقط برای پچ merged ممکن است (وضعیت فعلی: ${patch.status}).`);
  }
  if (!patch.merge_sha) throw new Error('SHA مرج ثبت نشده؛ بازگردانی ممکن نیست.');

  const token = await githubTokenOrThrow();
  const api = `/repos/${SITE_REPO}`;

  const devRef = (await ghApi(`${api}/git/refs/heads/dev`, token)) as GithubRefInfo;
  const devHead = devRef.object?.sha;
  if (!devHead) throw new Error('رأس شاخهٔ dev پیدا نشد.');

  const mergeCommit = (await ghApi(
    `${api}/git/commits/${patch.merge_sha}`,
    token,
  )) as GithubCommitInfo;
  const parentSha = mergeCommit.parents?.[0]?.sha;
  if (!parentSha) throw new Error('والد کامیت مرج پیدا نشد.');

  const parentCommit = (await ghApi(
    `${api}/git/commits/${parentSha}`,
    token,
  )) as GithubCommitInfo;
  const parentTree = parentCommit.tree?.sha;
  if (!parentTree) throw new Error('درخت والد کامیت مرج پیدا نشد.');

  const revert = (await ghApi(`${api}/git/commits`, token, {
    method: 'POST',
    body: JSON.stringify({
      message: `Revert "merge ${patch.branch ?? patch.id}"`,
      tree: parentTree,
      parents: [devHead],
    }),
  })) as { sha?: string };
  if (!revert?.sha) throw new Error('SHA کامیت revert برنگشت.');

  await ghApi(`${api}/git/refs/heads/dev`, token, {
    method: 'PATCH',
    body: JSON.stringify({ sha: revert.sha }),
  });

  patch.revert_sha = revert.sha.slice(0, 7);
  patch.status = 'rolledback';
  patch.updated_at = nowIso();
  store.save(patch);
  return patch;
}
