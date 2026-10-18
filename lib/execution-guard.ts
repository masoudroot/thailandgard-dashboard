/**
 * lib/execution-guard.ts : نگهبان امنیتی پل «تیم → سایت زنده».
 *
 * اصل معماری: تیم‌ها هیچ‌وقت مستقیم به گیت‌هاب دست نمی‌زنند. تنها مسیر
 * مجاز برای رساندن خروجی تیم به ریپوی سایت، همین فایل است:
 *
 *   team.patch (بعد از تأیید منتقد)
 *     → validateAll()            همه‌ی بررسی‌های امنیتی (هم‌زمان، بدون شبکه)
 *     → commitToSiteDev()        کامیت فقط روی شاخه‌ی dev ریپوی سایت
 *     → ثبت در site_applies      ردپای حسابرسی برای بازگشت
 *     → CI خودکار (prisma-deploy) بیلد + پیش‌نمایش
 *     → تأیید مدیر در داشبورد
 *     → executeMerge()           ادغام dev به main فقط وقتی بیلد dev سبز است
 *     → دیپلوی پروداکشن (خودکار)
 *     → اگر خراب شد: revertApply() / revertMainMerge()
 *
 * چرا این لایه حیاتی است: ریپوی سایت روی پلن رایگان گیت‌هاب است و
 * Branch Protection برای ریپوی خصوصی فعال نمی‌شود؛ پس تنها سد دفاعی
 * در برابر کامیت اشتباه یا مخرب، همین کد است. هیچ مسیر دیگری نباید
 * توکن سایت را ببیند.
 */

import { getSetting } from './settings';
import { getSupabase } from './api';

// ---------------------------------------------------------------------------
// پیکربندی
// ---------------------------------------------------------------------------

/** ریپوی سایت تایلندگرد. */
export const SITE_REPO_DEFAULT = 'masoudroot/thailandgard';
/** تنها شاخه‌ای که تیم‌ها حق نوشتن روی آن را دارند. */
export const SITE_DEV_BRANCH = 'dev';
/** شاخه‌ی پروداکشن؛ نوشتن مستقیم روی آن از هر مسیری ممنوع. */
export const SITE_PROD_BRANCH = 'main';

/** شاخه‌هایی که حتی باگ هم نباید به‌عنوان مقصد پذیرفته شوند. */
const FORBIDDEN_BRANCHES = new Set([
  'main',
  'master',
  'production',
  'prod',
  'release',
  'staging',
]);

/**
 * مسیرهای ممنوعه برای پچ تیم‌ها (الگوی regex روی مسیر نرمال‌شده).
 * منطق: هر چه به سکرت، بیلد، دیپلوی، دیتابیس یا احراز هویت مربوط است،
 * فقط با دست مدیر عوض می‌شود، نه با خروجی مدل زبانی.
 */
const BLOCKED_PATH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // سکرت و محیط
  { pattern: /(^|\/)\.env(\.|$)/, reason: 'فایل محیطی (.env)' },
  { pattern: /\.pem$/i, reason: 'کلید خصوصی' },
  { pattern: /\.key$/i, reason: 'فایل کلید' },
  { pattern: /credential/i, reason: 'فایل اعتبارنامه' },
  { pattern: /secret/i, reason: 'فایل حساس (secret)' },
  // متای گیت
  { pattern: /(^|\/)\.git(\/|$)/, reason: 'متای گیت' },
  // وابستگی و بیلد
  { pattern: /(^|\/)site\/package\.json$/, reason: 'وابستگی‌ها (package.json)' },
  { pattern: /(^|\/)site\/package-lock\.json$/, reason: 'قفل وابستگی‌ها' },
  { pattern: /(^|\/)site\/next\.config\.[jt]s$/, reason: 'پیکربندی بیلد نکست' },
  { pattern: /(^|\/)site\/tsconfig\.json$/, reason: 'پیکربندی تایپ‌اسکریپت' },
  { pattern: /(^|\/)site\/eslint\.config\.[jt]s$/, reason: 'پیکربندی لینت' },
  { pattern: /(^|\/)site\/postcss\.config\.[jt]s$/, reason: 'پیکربندی PostCSS' },
  { pattern: /(^|\/)vercel\.json$/, reason: 'پیکربندی دیپلوی ورسل' },
  // خط لوله‌ی CI/CD؛ تیم نباید بتواند نگهبان بیلد را دور بزند
  { pattern: /(^|\/)\.github\//, reason: 'ورک‌فلوهای گیت‌هاب اکشنز' },
  // دیتابیس و مهاجرت؛ برگشت‌ناپذیر و حساس
  { pattern: /(^|\/)supabase\/migrations\//, reason: 'مهاجرت دیتابیس' },
  { pattern: /(^|\/)site\/prisma\//, reason: 'اسکیمای پریزما' },
  { pattern: /(^|\/)prisma\.config\.ts$/, reason: 'پیکربندی پریزما' },
  // اسکریپت‌های اجرایی؛ ریسک زنجیره‌ی تأمین
  { pattern: /(^|\/)site\/scripts\//, reason: 'اسکریپت اجرایی سایت' },
  { pattern: /(^|\/)scripts\//, reason: 'اسکریپت اجرایی ریپو' },
  // تعریف ایجنت‌ها؛ خوداصلاحی مدل ممنوع
  { pattern: /(^|\/)agents\//, reason: 'تعریف ایجنت‌ها' },
  // میان‌افزار و احراز هویت
  { pattern: /(^|\/)site\/middleware\.ts$/, reason: 'میان‌افزار (امنیت مسیریابی)' },
  { pattern: /(^|\/)site\/lib\/auth/i, reason: 'کد احراز هویت' },
];

/**
 * مسیرهایی که ممنوع نیستند ولی «حساس»‌اند: اجازه داده می‌شوند اما در
 * نتیجه با پرچم needsReview مشخص می‌شوند تا مدیر پیش از ادغام ببیند.
 */
const SENSITIVE_PATH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|\/)site\/lib\//, reason: 'کتابخانه‌ی مشترک سایت' },
  { pattern: /(^|\/)site\/app\/api\//, reason: 'مسیر API سایت' },
];

/** سقف‌های حجمی پچ؛ دفاع در برابر بازنویسی‌های غول‌پیکر و تصادفی. */
export const MAX_PATCH_FILES = 10;
export const MAX_FILE_BYTES = 200 * 1024; // ۲۰۰ کیلوبایت برای هر فایل
export const MAX_TOTAL_BYTES = 1024 * 1024; // ۱ مگابایت برای کل پچ

/** الگوهای سکرت داخل محتوا؛ اگر پیدا شود پچ کاملاً رد می‌شود. */
const SECRET_CONTENT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, label: 'کلید خصوصی' },
  { pattern: /AKIA[0-9A-Z]{16}/, label: 'کلید دسترسی AWS' },
  { pattern: /sk-(live|test)-[A-Za-z0-9]{10,}/, label: 'کلید API (الگوی sk-)' },
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/, label: 'توکن اسلک' },
  { pattern: /gh[pousr]_[A-Za-z0-9]{20,}/, label: 'توکن گیت‌هاب' },
  { pattern: /(api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{8,}['"]/i, label: 'کلید API هاردکدشده' },
  { pattern: /(secret|password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/i, label: 'رمز هاردکدشده' },
];

// ---------------------------------------------------------------------------
// تایپ‌ها
// ---------------------------------------------------------------------------

export interface PatchFileInput {
  path: string;
  content: string;
}

export interface GuardIssue {
  file: string;
  reason: string;
}

export interface GuardCheckResult {
  ok: boolean;
  /** خطاهای مسدودکننده؛ اگر یکی هم باشد، پچ رد می‌شود. */
  errors: GuardIssue[];
  /** هشدارهای غیرمسدودکننده؛ برای بازبینی مدیر ثبت می‌شوند. */
  warnings: GuardIssue[];
}

export interface ValidatedPatch extends GuardCheckResult {
  branch: string;
  fileCount: number;
  totalBytes: number;
}

export interface SiteGithubConfig {
  token: string | null;
  repo: string;
}

export interface ApplyOptions {
  team: string;
  runId: string;
  files: PatchFileInput[];
  /** آیا منتقد پچ را تأیید کرده؟ بدون تأیید، هیچ‌چیز اعمال نمی‌شود. */
  criticApproved: boolean;
}

export interface ApplyResult {
  applyId: string;
  commitSha: string;
  shortSha: string;
  branch: string;
  previewHint: string;
  warnings: GuardIssue[];
}

// ---------------------------------------------------------------------------
// نرمال‌سازی مسیر
// ---------------------------------------------------------------------------

/** مسیر را نرمال می‌کند؛ اسلش اول را می‌برد و `..` را رد می‌کند. */
function normalizePath(raw: string): string | null {
  const p = raw.trim().replace(/^\/+/, '').replace(/\\/g, '/');
  if (!p) return null;
  // «..» فقط به‌عنوان سگمنت مسیر ممنوع است، نه به‌عنوان زیررشته؛
  // مثلاً [...next] (کتچ‌آل نکست) معتبر است ولی a/../b نیست.
  if (p.split('/').includes('..')) return null;
  if (p.startsWith('.git/') || p === '.git') return null;
  return p;
}

// ---------------------------------------------------------------------------
// بررسی‌های هم‌زمان (بدون شبکه)؛ واحدپذیر
// ---------------------------------------------------------------------------

/** ۱) شاخه‌ی مقصد فقط باید dev باشد. */
export function validateBranch(branch: string): GuardIssue[] {
  const b = branch.trim();
  const issues: GuardIssue[] = [];
  if (b !== SITE_DEV_BRANCH) {
    issues.push({
      file: '(branch)',
      reason: `شاخه‌ی مقصد «${b}» مجاز نیست؛ تیم‌ها فقط روی «${SITE_DEV_BRANCH}» می‌نویسند.`,
    });
  }
  if (FORBIDDEN_BRANCHES.has(b.toLowerCase())) {
    issues.push({
      file: '(branch)',
      reason: `نوشتن مستقیم روی شاخه‌ی «${b}» اکیداً ممنوع است.`,
    });
  }
  return issues;
}

/** ۲) مسیر فایل‌ها: ممنوعه‌ها رد، حساس‌ها هشدار. */
export function validatePaths(files: PatchFileInput[]): GuardCheckResult {
  const errors: GuardIssue[] = [];
  const warnings: GuardIssue[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const p = normalizePath(f.path);
    if (p === null) {
      errors.push({ file: f.path, reason: 'مسیر نامعتبر (خالی یا حاوی .. است).' });
      continue;
    }
    if (seen.has(p)) {
      errors.push({ file: p, reason: 'فایل تکراری در پچ.' });
      continue;
    }
    seen.add(p);
    const blocked = BLOCKED_PATH_PATTERNS.find((b) => b.pattern.test(p));
    if (blocked) {
      errors.push({ file: p, reason: `مسیر ممنوعه: ${blocked.reason}. این فایل فقط با دست مدیر عوض می‌شود.` });
      continue;
    }
    const sensitive = SENSITIVE_PATH_PATTERNS.find((s) => s.pattern.test(p));
    if (sensitive) {
      warnings.push({ file: p, reason: `مسیر حساس (${sensitive.reason})؛ پیش از ادغام به main بازبینی شود.` });
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** ۳) سقف حجمی و پوچ‌نبودن محتوا. حذف فایل پشتیبانی نمی‌شود. */
export function validateSizes(files: PatchFileInput[]): GuardIssue[] {
  const issues: GuardIssue[] = [];
  if (files.length === 0) {
    issues.push({ file: '(patch)', reason: 'پچ خالی است؛ چیزی برای اعمال نیست.' });
    return issues;
  }
  if (files.length > MAX_PATCH_FILES) {
    issues.push({
      file: '(patch)',
      reason: `تعداد فایل‌ها (${files.length}) از سقف ${MAX_PATCH_FILES} بیشتر است؛ پچ را کوچک‌تر کن.`,
    });
  }
  let total = 0;
  for (const f of files) {
    const bytes = Buffer.byteLength(f.content ?? '', 'utf8');
    total += bytes;
    if (!f.content || !f.content.trim()) {
      issues.push({ file: f.path, reason: 'محتوای خالی؛ حذف فایل از مسیر تیم پشتیبانی نمی‌شود.' });
    }
    if (bytes > MAX_FILE_BYTES) {
      issues.push({
        file: f.path,
        reason: `حجم فایل (${Math.round(bytes / 1024)}KB) از سقف ${MAX_FILE_BYTES / 1024}KB بیشتر است.`,
      });
    }
  }
  if (total > MAX_TOTAL_BYTES) {
    issues.push({
      file: '(patch)',
      reason: `حجم کل پچ (${Math.round(total / 1024)}KB) از سقف ${MAX_TOTAL_BYTES / 1024}KB بیشتر است.`,
    });
  }
  return issues;
}

/** ۴) اسکن سکرت داخل محتوا؛ هر موردی یعنی رد کامل پچ. */
export function scanSecrets(files: PatchFileInput[]): GuardIssue[] {
  const issues: GuardIssue[] = [];
  for (const f of files) {
    for (const s of SECRET_CONTENT_PATTERNS) {
      if (s.pattern.test(f.content)) {
        issues.push({
          file: f.path,
          reason: `سکرت احتمالی در محتوا (${s.label})؛ سکرت هرگز داخل ریپو نمی‌رود، از متغیر محیطی استفاده کن.`,
        });
        break;
      }
    }
  }
  return issues;
}

/** همه‌ی بررسی‌های هم‌زمان در یک فراخوانی. */
export function validateAll(branch: string, files: PatchFileInput[]): ValidatedPatch {
  const errors: GuardIssue[] = [...validateBranch(branch)];
  const warnings: GuardIssue[] = [];
  const pathRes = validatePaths(files);
  errors.push(...pathRes.errors);
  warnings.push(...pathRes.warnings);
  errors.push(...validateSizes(files));
  errors.push(...scanSecrets(files));
  const totalBytes = files.reduce((n, f) => n + Buffer.byteLength(f.content ?? '', 'utf8'), 0);
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    branch: branch.trim(),
    fileCount: files.length,
    totalBytes,
  };
}

// ---------------------------------------------------------------------------
// پیکربندی گیت‌هاب سایت (توکن جدا از توکن داشبورد)
// ---------------------------------------------------------------------------

/**
 * توکن سایت عامدانه از توکن داشبورد جداست (اصل کمترین دسترسی):
 * settings: site_github_token و site_github_repo
 * env: SITE_GITHUB_TOKEN و SITE_GITHUB_REPO
 * این توکن فقط روی ریپوی سایت دسترسی contents:write می‌خواهد.
 */
export async function getSiteGithubConfig(): Promise<SiteGithubConfig> {
  let token: string | null = null;
  let repo = SITE_REPO_DEFAULT;
  try {
    const stored = await getSetting<string | { token?: string } | null>('site_github_token', null);
    if (typeof stored === 'string' && stored.trim()) token = stored.trim();
    else if (stored && typeof stored === 'object' && stored.token) token = stored.token.trim();
    const storedRepo = await getSetting<string | null>('site_github_repo', null);
    if (storedRepo && storedRepo.trim()) repo = storedRepo.trim();
  } catch {
    // settings در دسترس نیست؛ به env تکیه می‌کنیم
  }
  if (process.env.SITE_GITHUB_TOKEN?.trim()) token = process.env.SITE_GITHUB_TOKEN.trim();
  if (process.env.SITE_GITHUB_REPO?.trim()) repo = process.env.SITE_GITHUB_REPO.trim();
  return { token, repo };
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export class GuardError extends Error {
  readonly issues: GuardIssue[];
  constructor(message: string, issues: GuardIssue[]) {
    super(message);
    this.name = 'GuardError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// اعمال پچ: تنها مسیر مجاز نوشتن تیم روی ریپوی سایت
// ---------------------------------------------------------------------------

/**
 * اعمال پچ تأییدشده‌ی تیم روی شاخه‌ی dev سایت.
 * ترتیب: تأیید منتقد → اعتبارسنجی نگهبان → جلوگیری از اعمال تکراری
 * → خواندن SHA فعلی فایل‌ها (برای بازگشت) → کامیت → ثبت حسابرسی.
 */
export async function applyTeamPatch(opts: ApplyOptions): Promise<ApplyResult> {
  if (!opts.criticApproved) {
    throw new GuardError('پچ بدون تأیید منتقد اعمال نمی‌شود.', [
      { file: '(guard)', reason: 'criticApproved=false' },
    ]);
  }

  const checked = validateAll(SITE_DEV_BRANCH, opts.files);
  if (!checked.ok) {
    throw new GuardError(
      `نگهبان پچ تیم «${opts.team}» را رد کرد (${checked.errors.length} خطا).`,
      checked.errors,
    );
  }

  // قیف یکپارچهٔ اعتبارسنجی (ممیزی مسیرهای دورزن C4): این مسیرِ اعمال
  // مستقیم روی dev باید دقیقاً از همان دروازهٔ کیفیتی رد شود که حلقهٔ
  // خودکار پل (processProposedPatch) پیش از هر کامیت اجرا می‌کند
  // (سینتکس TS، پسوند مجاز، خط تیرهٔ ممنوعه، الگوی مخرب، نگهبان امنیتی).
  // بدون این چک، پچی که این‌جا سیم‌کشی شود می‌تواند همهٔ آن چک‌ها را دور
  // بزند و مستقیم روی dev بنشیند. ایمپورت پویاست تا چرخهٔ ایمپورت با
  // lib/bridge/gate.ts (که از این فایل می‌خواند) ساخته نشود.
  const { validatePatch } = await import('./bridge/gate');
  const bridgeGate = validatePatch(
    opts.files.map((f) => ({ path: f.path, content: f.content })),
  );
  if (!bridgeGate.ok) {
    throw new GuardError(
      `دروازهٔ کیفیت پل پچ تیم «${opts.team}» را رد کرد (${bridgeGate.errors.length} خطا).`,
      bridgeGate.errors.map((e) => ({ file: '(gate)', reason: e })),
    );
  }

  const { token, repo } = await getSiteGithubConfig();
  if (!token) {
    throw new GuardError('توکن گیت‌هاب سایت متصل نیست (site_github_token).', [
      { file: '(config)', reason: 'اتصال گیت‌هاب سایت برقرار نیست.' },
    ]);
  }

  const sb = getSupabase();
  const dedupeKey = `${opts.runId}:${opts.team}`;

  // جلوگیری از اعمال تکراری (مثلاً با تلاش مجدد ورکر)
  const { data: existing } = await sb
    .from('site_applies')
    .select('id, commit_sha')
    .eq('dedupe_key', dedupeKey)
    .maybeSingle();
  if (existing) {
    const row = existing as { id: string; commit_sha: string };
    return {
      applyId: row.id,
      commitSha: row.commit_sha,
      shortSha: String(row.commit_sha).slice(0, 7),
      branch: SITE_DEV_BRANCH,
      previewHint: 'این پچ قبلاً اعمال شده بود؛ کامیت تکراری ساخته نشد.',
      warnings: checked.warnings,
    };
  }

  const api = `https://api.github.com/repos/${repo}`;
  const h = ghHeaders(token);

  // رأس فعلی dev
  const refRes = await fetch(`${api}/git/refs/heads/${SITE_DEV_BRANCH}`, {
    headers: h,
    signal: AbortSignal.timeout(15_000),
  });
  if (!refRes.ok) throw new GuardError(`خواندن رأس dev ناموفق بود (${refRes.status}).`, []);
  const refBody = (await refRes.json()) as { object?: { sha?: string } };
  const baseSha = refBody.object?.sha;
  if (!baseSha) throw new GuardError('SHA رأس dev پیدا نشد.', []);

  // SHA فعلی هر فایل؛ برای بازگشت احتمالی ذخیره می‌شود
  const previousShas: Record<string, string | null> = {};
  await Promise.all(
    opts.files.map(async (f) => {
      const p = normalizePath(f.path) as string;
      try {
        const r = await fetch(`${api}/contents/${p}?ref=${SITE_DEV_BRANCH}`, {
          headers: h,
          signal: AbortSignal.timeout(15_000),
        });
        if (r.ok) {
          const b = (await r.json()) as { sha?: string };
          previousShas[p] = b.sha ?? null;
        } else {
          previousShas[p] = null; // فایل تازه است
        }
      } catch {
        previousShas[p] = null;
      }
    }),
  );

  // بلاب‌ها
  const blobs: Array<{ path: string; sha: string }> = [];
  for (const f of opts.files) {
    const p = normalizePath(f.path) as string;
    const blobRes = await fetch(`${api}/git/blobs`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: f.content, encoding: 'utf-8' }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!blobRes.ok) throw new GuardError(`ساخت بلاب برای «${p}» ناموفق بود (${blobRes.status}).`, []);
    const blobBody = (await blobRes.json()) as { sha?: string };
    if (!blobBody.sha) throw new GuardError(`SHA بلاب برای «${p}» برنگشت.`, []);
    blobs.push({ path: p, sha: blobBody.sha });
  }

  // درخت و کامیت روی dev
  const treeRes = await fetch(`${api}/git/trees`, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_tree: baseSha,
      tree: blobs.map((b) => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha })),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!treeRes.ok) throw new GuardError(`ساخت درخت گیت ناموفق بود (${treeRes.status}).`, []);
  const treeBody = (await treeRes.json()) as { sha?: string };
  if (!treeBody.sha) throw new GuardError('SHA درخت برنگشت.', []);

  const message = `[team:${opts.team}] ${opts.runId}`;
  const commitRes = await fetch(`${api}/git/commits`, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      tree: treeBody.sha,
      parents: [baseSha],
      author: { name: 'ThailandGard Team', email: 'teams@thailandgard.local' },
      committer: { name: 'ThailandGard Guard', email: 'guard@thailandgard.local' },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!commitRes.ok) throw new GuardError(`ساخت کامیت ناموفق بود (${commitRes.status}).`, []);
  const commitBody = (await commitRes.json()) as { sha?: string };
  if (!commitBody.sha) throw new GuardError('SHA کامیت برنگشت.', []);

  // جلو بردن رأس dev (fast-forward)
  const updateRes = await fetch(`${api}/git/refs/heads/${SITE_DEV_BRANCH}`, {
    method: 'PATCH',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: commitBody.sha, force: false }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!updateRes.ok) {
    throw new GuardError(
      `به‌روزرسانی شاخه‌ی dev ناموفق بود (${updateRes.status})؛ شاید هم‌زمان کامیت دیگری آمده. پچ اعمال نشد.`,
      [],
    );
  }

  // ثبت حسابرسی
  const { data: inserted, error: insertErr } = await sb
    .from('site_applies')
    .insert({
      dedupe_key: dedupeKey,
      team: opts.team,
      run_id: opts.runId,
      branch: SITE_DEV_BRANCH,
      commit_sha: commitBody.sha,
      files: opts.files.map((f) => normalizePath(f.path)),
      previous_shas: previousShas,
      warnings: checked.warnings,
      status: 'applied',
    })
    .select('id')
    .single();
  if (insertErr || !inserted) {
    // کامیت انجام شده ولی ثبت حسابرسی نه؛ خطا را لاگ می‌کنیم ولی برنمی‌گردانیم
    // چون برگرداندن کامیت واقعی گیت‌هاب ممکن نیست.
    console.error('[execution-guard] audit insert failed:', insertErr?.message);
  }

  return {
    applyId: (inserted as { id: string } | null)?.id ?? '',
    commitSha: commitBody.sha,
    shortSha: commitBody.sha.slice(0, 7),
    branch: SITE_DEV_BRANCH,
    previewHint:
      'پوش روی dev انجام شد؛ ورک‌فلو prisma-deploy خودکار بیلد می‌گیرد و پیش‌نمایش جدا می‌سازد.',
    warnings: checked.warnings,
  };
}

// ---------------------------------------------------------------------------
// وضعیت بیلد dev؛ دروازه‌ی ادغام به main
// ---------------------------------------------------------------------------

export type BuildStatus = 'success' | 'failure' | 'pending' | 'unknown';

/**
 * وضعیت آخرین اجرای ورک‌فلو روی رأس dev را از گیت‌هاب می‌خواند.
 * ادغام به main فقط وقتی مجاز است که این 'success' باشد.
 */
export async function getDevBuildStatus(): Promise<{ status: BuildStatus; runUrl: string | null }> {
  const { token, repo } = await getSiteGithubConfig();
  if (!token) return { status: 'unknown', runUrl: null };
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/runs?branch=${SITE_DEV_BRANCH}&per_page=1`,
      { headers: ghHeaders(token), signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) return { status: 'unknown', runUrl: null };
    const body = (await res.json()) as {
      workflow_runs?: Array<{ status?: string; conclusion?: string | null; html_url?: string }>;
    };
    const run = body.workflow_runs?.[0];
    if (!run) return { status: 'unknown', runUrl: null };
    if (run.status !== 'completed') return { status: 'pending', runUrl: run.html_url ?? null };
    return {
      status: run.conclusion === 'success' ? 'success' : 'failure',
      runUrl: run.html_url ?? null,
    };
  } catch {
    return { status: 'unknown', runUrl: null };
  }
}

// ---------------------------------------------------------------------------
// ادغام dev به main؛ فقط با تأیید مدیر و بیلد سبز
// ---------------------------------------------------------------------------

export interface MergeRequest {
  id: string;
  from_branch: string;
  to_branch: string;
  status: 'pending' | 'approved' | 'merged' | 'rejected';
}

/** ثبت درخواست ادغام توسط سیستم (پس از سبز شدن بیلد dev). */
export async function createMergeRequest(requestedBy: string): Promise<MergeRequest> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('site_merges')
    .insert({
      from_branch: SITE_DEV_BRANCH,
      to_branch: SITE_PROD_BRANCH,
      status: 'pending',
      requested_by: requestedBy,
    })
    .select('id, from_branch, to_branch, status')
    .single();
  if (error || !data) throw new Error(`ثبت درخواست ادغام ناموفق بود: ${error?.message}`);
  return data as MergeRequest;
}

/**
 * اجرای ادغام dev به main. پیش‌شرط‌ها (همه اجباری):
 *  ۱. درخواست در وضعیت approved باشد (تأیید مدیر در داشبورد).
 *  ۲. آخرین بیلد dev سبز باشد.
 * توجه: احراز «مدیر بودن» تأییدکننده بر عهده‌ی صداکننده است
 * (requireManagerAuth در route)؛ این تابع فقط وضعیت ثبت‌شده را چک می‌کند.
 */
export async function executeMerge(mergeId: string): Promise<{ mergeSha: string }> {
  const sb = getSupabase();
  const { data: mr } = await sb.from('site_merges').select('*').eq('id', mergeId).single();
  const row = mr as MergeRequest & { approved_by?: string } | null;
  if (!row) throw new GuardError('درخواست ادغام پیدا نشد.', []);
  if (row.status !== 'approved') {
    throw new GuardError('ادغام فقط پس از تأیید مدیر مجاز است.', [
      { file: '(merge)', reason: `وضعیت فعلی: ${row.status}` },
    ]);
  }

  const build = await getDevBuildStatus();
  if (build.status !== 'success') {
    throw new GuardError('بیلد dev سبز نیست؛ ادغام به main ممنوع.', [
      { file: '(build)', reason: `وضعیت بیلد: ${build.status}` },
    ]);
  }

  const { token, repo } = await getSiteGithubConfig();
  if (!token) throw new GuardError('توکن گیت‌هاب سایت متصل نیست.', []);

  const res = await fetch(`https://api.github.com/repos/${repo}/merges`, {
    method: 'POST',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base: SITE_PROD_BRANCH,
      head: SITE_DEV_BRANCH,
      commit_message: `ادغام dev به main (تأیید مدیر) [merge:${mergeId.slice(0, 8)}]`,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 409) {
    throw new GuardError('تداخل ادغام (merge conflict)؛ مدیر باید دستی حل کند.', []);
  }
  if (!res.ok) throw new GuardError(`ادغام ناموفق بود (${res.status}).`, []);
  const body = (await res.json()) as { sha?: string };
  if (!body.sha) throw new GuardError('SHA ادغام برنگشت.', []);

  await sb
    .from('site_merges')
    .update({ status: 'merged', merged_at: new Date().toISOString(), merge_sha: body.sha })
    .eq('id', mergeId);

  return { mergeSha: body.sha };
}

// ---------------------------------------------------------------------------
// بازگشت (rollback)
// ---------------------------------------------------------------------------

/**
 * بازگرداندن یک اعمال روی dev: محتوای قبلی فایل‌ها (که هنگام اعمال
 * ذخیره شد) به‌صورت یک کامیت تازه‌ی `[revert]` روی dev برمی‌گردد.
 */
export async function revertApply(applyId: string, reason: string): Promise<{ revertSha: string }> {
  const sb = getSupabase();
  const { data: row } = await sb.from('site_applies').select('*').eq('id', applyId).single();
  const apply = row as {
    id: string;
    team: string;
    commit_sha: string;
    files: string[];
    previous_shas: Record<string, string | null>;
    status: string;
  } | null;
  if (!apply) throw new GuardError('رکورد اعمال پیدا نشد.', []);
  if (apply.status === 'reverted') throw new GuardError('این اعمال قبلاً برگردانده شده.', []);

  const { token, repo } = await getSiteGithubConfig();
  if (!token) throw new GuardError('توکن گیت‌هاب سایت متصل نیست.', []);
  const api = `https://api.github.com/repos/${repo}`;
  const h = ghHeaders(token);

  // محتوای قبلی هر فایل را از روی SHA ذخیره‌شده می‌خوانیم
  const restored: PatchFileInput[] = [];
  for (const p of apply.files) {
    const prevSha = apply.previous_shas?.[p];
    if (!prevSha) continue; // فایل در زمان اعمال تازه ساخته شده بود؛ حذفش نمی‌کنیم
    const r = await fetch(`${api}/git/blobs/${prevSha}`, {
      headers: h,
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new GuardError(`خواندن بلاب قبلی «${p}» ناموفق بود.`, []);
    const b = (await r.json()) as { content?: string; encoding?: string };
    if (!b.content) throw new GuardError(`محتوای قبلی «${p}» پیدا نشد.`, []);
    restored.push({
      path: p,
      content: Buffer.from(b.content, b.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8'),
    });
  }
  if (restored.length === 0) {
    throw new GuardError('چیزی برای بازگرداندن نیست (همه‌ی فایل‌ها تازه بودند).', []);
  }

  // کامیت بازگشت با همان خط لوله‌ی امن (اعتبارسنجی کامل دوباره اجرا می‌شود)
  const checked = validateAll(SITE_DEV_BRANCH, restored);
  if (!checked.ok) throw new GuardError('اعتبارسنجی پچ بازگشت رد شد.', checked.errors);

  const refRes = await fetch(`${api}/git/refs/heads/${SITE_DEV_BRANCH}`, {
    headers: h,
    signal: AbortSignal.timeout(15_000),
  });
  if (!refRes.ok) throw new GuardError('خواندن رأس dev ناموفق بود.', []);
  const baseSha = ((await refRes.json()) as { object?: { sha?: string } }).object?.sha;
  if (!baseSha) throw new GuardError('SHA رأس dev پیدا نشد.', []);

  const blobs: Array<{ path: string; sha: string }> = [];
  for (const f of restored) {
    const br = await fetch(`${api}/git/blobs`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: f.content, encoding: 'utf-8' }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!br.ok) throw new GuardError(`ساخت بلاب بازگشت برای «${f.path}» ناموفق بود.`, []);
    const bb = (await br.json()) as { sha?: string };
    blobs.push({ path: f.path, sha: bb.sha as string });
  }
  const treeRes = await fetch(`${api}/git/trees`, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_tree: baseSha,
      tree: blobs.map((b) => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha })),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const treeSha = ((await treeRes.json()) as { sha?: string }).sha;
  const commitRes = await fetch(`${api}/git/commits`, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `[revert] بازگشت اعمال ${apply.commit_sha.slice(0, 7)} (تیم ${apply.team})؛ ${reason}`,
      tree: treeSha,
      parents: [baseSha],
      author: { name: 'ThailandGard Guard', email: 'guard@thailandgard.local' },
      committer: { name: 'ThailandGard Guard', email: 'guard@thailandgard.local' },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const revertSha = ((await commitRes.json()) as { sha?: string }).sha as string;
  await fetch(`${api}/git/refs/heads/${SITE_DEV_BRANCH}`, {
    method: 'PATCH',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: revertSha, force: false }),
    signal: AbortSignal.timeout(15_000),
  });

  await sb
    .from('site_applies')
    .update({ status: 'reverted', reverted_at: new Date().toISOString(), revert_sha: revertSha })
    .eq('id', applyId);

  return { revertSha };
}

/**
 * بازگشت فوری پروداکشن: آخرین کامیت main (ادغام خراب) را با یک کامیت
 * revert روی main برمی‌گرداند. فقط برای مواقع اضطراری؛ در داشبورد
 * دکمه‌ی جداگانه با تأیید دوباره می‌خواهد.
 */
export async function revertMainMerge(mergeSha: string, reason: string): Promise<{ revertSha: string }> {
  const { token, repo } = await getSiteGithubConfig();
  if (!token) throw new GuardError('توکن گیت‌هاب سایت متصل نیست.', []);
  const api = `https://api.github.com/repos/${repo}`;
  const h = ghHeaders(token);

  // والدین کامیت ادغام را می‌خوانیم تا revert دقیق بسازیم
  const cRes = await fetch(`${api}/git/commits/${mergeSha}`, {
    headers: h,
    signal: AbortSignal.timeout(15_000),
  });
  if (!cRes.ok) throw new GuardError('کامیت ادغام پیدا نشد.', []);
  const cBody = (await cRes.json()) as { parents?: Array<{ sha?: string }>; tree?: { sha?: string } };
  const firstParent = cBody.parents?.[0]?.sha;
  if (!firstParent) throw new GuardError('والد اول کامیت ادغام پیدا نشد؛ بازگشت دستی لازم است.', []);

  // درخت والد اول = وضعیت سالم قبل از ادغام
  const parentTree = (
    (await (await fetch(`${api}/git/commits/${firstParent}`, { headers: h })).json()) as {
      tree?: { sha?: string };
    }
  ).tree?.sha;
  if (!parentTree) throw new GuardError('درخت وضعیت سالم پیدا نشد.', []);

  const refRes = await fetch(`${api}/git/refs/heads/${SITE_PROD_BRANCH}`, {
    headers: h,
    signal: AbortSignal.timeout(15_000),
  });
  const headSha = ((await refRes.json()) as { object?: { sha?: string } }).object?.sha;
  if (!headSha) throw new GuardError('رأس main خوانده نشد.', []);

  const commitRes = await fetch(`${api}/git/commits`, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `[revert-prod] بازگشت اضطراری ادغام ${mergeSha.slice(0, 7)}؛ ${reason}`,
      tree: parentTree,
      parents: [headSha],
      author: { name: 'ThailandGard Guard', email: 'guard@thailandgard.local' },
      committer: { name: 'ThailandGard Guard', email: 'guard@thailandgard.local' },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const revertSha = ((await commitRes.json()) as { sha?: string }).sha;
  if (!revertSha) throw new GuardError('ساخت کامیت بازگشت ناموفق بود.', []);

  const upd = await fetch(`${api}/git/refs/heads/${SITE_PROD_BRANCH}`, {
    method: 'PATCH',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: revertSha, force: false }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!upd.ok) throw new GuardError('به‌روزرسانی main ناموفق بود؛ احتمالاً هم‌زمان پوش شده.', []);

  return { revertSha };
}
