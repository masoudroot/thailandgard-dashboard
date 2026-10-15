/**
 * worker/code-collector.ts: سندباکس امن تولید کد توسط تیم‌ها.
 *
 * مسئله: تیم‌ها در GitHub Actions اجرا می‌شوند و فقط گزارش متنی تولید می‌کنند؛
 * هیچ پلی بین خروجی تیم و ریپوی سایت (masoudroot/thailandgard) نیست.
 *
 * این ماژول آن پل را امن می‌کند:
 *  ۱. تیم‌ها فایل‌های کد را فقط از طریق writeTeamCodeFile می‌نویسند
 *     (در code-output/<team>/ داخل workspace رانر؛ محدودیت حجم و پسوند همان‌جا اعمال می‌شود).
 *  ۲. بعد از اجرای تیم، collectAndCommitTeamCode فایل‌های واقعی روی دیسک را
 *     می‌خواند (نه ادعای متنی تیم را)، هش SHA-256 می‌گیرد، با مانیفست اعلام‌شده
 *     تیم تطبیق می‌دهد، سینتکس را چک می‌کند و متادیتا را در دیتابیس ثبت می‌کند.
 *  ۳. فقط وقتی منتقد تیم را تأیید کرده (approved=true) و همه‌ی گیت‌ها سبزند،
 *     فایل‌ها روی شاخه‌ی team/<team>/<run-id> در ریپوی سایت کامیت می‌شوند.
 *
 * قانون ضدتوهم: کالکتور هرگز به حرف تیم اعتماد نمی‌کند؛ فقط بایت‌های واقعی
 * روی دیسک مبناست و هش هر فایل در دیتابیس ثبت می‌شود تا قابل حسابرسی باشد.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import type { TeamName } from '../lib/types';

/** ریپوی سایت؛ جایی که کد تیم‌ها باید بنشیند. */
export const SITE_REPO = 'masoudroot/thailandgard';
/** شاخه‌ی پیش‌فرض ریپوی سایت که کامیت‌ها از روی آن ساخته می‌شوند. */
const SITE_BASE_BRANCH = 'master';

/** محدودیت‌های سندباکس. */
export const SANDBOX_LIMITS = {
  /** حداکثر تعداد فایل در هر اجرای یک تیم. */
  maxFiles: 10,
  /** حداکثر حجم هر فایل (بایت). */
  maxFileBytes: 100 * 1024,
  /** حداکثر حجم مجموع فایل‌ها (بایت). */
  maxTotalBytes: 512 * 1024,
  /** حداکثر خط هر فایل. */
  maxLinesPerFile: 2000,
  /** پسوندهای مجاز؛ باینری و اجرایی ممنوع. */
  allowedExtensions: ['.ts', '.tsx', '.js', '.jsx', '.css', '.scss', '.md', '.mdx', '.json', '.html'] as const,
} as const;

export interface CollectedFile {
  /** مسیر نسبی داخل ریپوی سایت، مثل site/components/Hero.tsx */
  path: string;
  sha256: string;
  bytes: number;
  lines: number;
  syntaxOk: boolean;
}

export interface CollectionResult {
  team: TeamName;
  runId: string;
  files: CollectedFile[];
  /** نام فایل‌هایی که تیم ادعا کرده ولی روی دیسک نیست یا هششان نمی‌خواند. */
  manifestMismatches: string[];
  /** فایل‌هایی که به‌خاطر نقض محدودیت رد شدند. */
  rejected: Array<{ path: string; reason: string }>;
  pushed: boolean;
  branch?: string;
  commitSha?: string;
  compareUrl?: string;
  skippedReason?: string;
}

export interface CollectOptions {
  team: TeamName;
  runId: string;
  /** شناسه‌ی ردیف team_runs برای ثبت متادیتا؛ اگر null باشد فقط لاگ می‌شود. */
  cycleId?: string | null;
  /** فقط وقتی منتقد تأیید کرده، push انجام می‌شود. */
  approved: boolean;
  /** مانیفست اعلام‌شده‌ی تیم: [{path, sha256}]؛ برای تطبیق ضدتوهم. */
  declaredFiles?: Array<{ path: string; sha256?: string }>;
  /** دایرکتوری خروجی؛ پیش‌فرض <cwd>/code-output/<team>. */
  outputDir?: string;
  targetRepo?: string;
  /** توکن؛ پیش‌فرض env ‏SITE_GITHUB_TOKEN‏ و بعد GITHUB_TOKEN. */
  token?: string;
  dryRun?: boolean;
}

/** ریشه‌ی خروجی کد برای یک تیم. */
export function teamOutputDir(team: TeamName, base?: string): string {
  return resolve(base ?? process.cwd(), 'code-output', team);
}

/** اعتبارسنجی مسیر نسبی: بدون ..، بدون مسیر مطلق، بدون دایرکتوری مخفی/سیستمی. */
function sanitizeRelPath(relPath: string): string {
  const clean = relPath.trim().replace(/^[/\\]+/, '');
  if (!clean) throw new Error('مسیر فایل خالی است.');
  const norm = normalize(clean);
  if (norm === '.' || norm.startsWith('..') || normalize(relative('.', norm)).startsWith('..')) {
    throw new Error(`مسیر غیرمجاز (فرار از سندباکس): ${relPath}`);
  }
  const parts = norm.split(sep);
  for (const p of parts) {
    if (!p || p === '.' || p === '..') throw new Error(`بخش نامعتبر در مسیر: ${relPath}`);
    if (p.startsWith('.')) throw new Error(`فایل/دایرکتوری مخفی ممنوع: ${relPath}`);
    if (p === 'node_modules' || p === '.git') throw new Error(`دایرکتوری سیستمی ممنوع: ${relPath}`);
  }
  if (clean.toLowerCase().includes('.env')) throw new Error(`فایل محیطی ممنوع: ${relPath}`);
  const lower = norm.toLowerCase();
  const ok = (SANDBOX_LIMITS.allowedExtensions as readonly string[]).some((e) => lower.endsWith(e));
  if (!ok) throw new Error(`پسوند غیرمجاز: ${relPath}`);
  return norm.split(sep).join('/');
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

/**
 * نوشتن امن فایل کد توسط تیم. محدودیت‌ها همین‌جا اعمال می‌شوند تا تیم
 * نتواند بیشتر از سقف سندباکس تولید کند.
 */
export function writeTeamCodeFile(team: TeamName, relPath: string, content: string, base?: string): string {
  const safe = sanitizeRelPath(relPath);
  const bytes = Buffer.byteLength(content, 'utf-8');
  if (bytes > SANDBOX_LIMITS.maxFileBytes) {
    throw new Error(`حجم فایل بیش از سقف (${SANDBOX_LIMITS.maxFileBytes} بایت): ${safe}`);
  }
  const lines = countLines(content);
  if (lines > SANDBOX_LIMITS.maxLinesPerFile) {
    throw new Error(`تعداد خط بیش از سقف (${SANDBOX_LIMITS.maxLinesPerFile}): ${safe}`);
  }
  const dir = teamOutputDir(team, base);
  const existing = listOutputFiles(dir);
  if (existing.length >= SANDBOX_LIMITS.maxFiles) {
    throw new Error(`سقف تعداد فایل (${SANDBOX_LIMITS.maxFiles}) برای تیم ${team} پر شده است.`);
  }
  const total = existing.reduce((n, f) => n + f.bytes, 0);
  if (total + bytes > SANDBOX_LIMITS.maxTotalBytes) {
    throw new Error(`حجم مجموع فایل‌ها بیش از سقف (${SANDBOX_LIMITS.maxTotalBytes} بایت).`);
  }
  const full = join(dir, safe);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf-8');
  return safe;
}

interface RawFile {
  relPath: string;
  fullPath: string;
  bytes: number;
}

/** فهرست فایل‌های خروجی یک تیم روی دیسک (فقط خواندن، بدون اعتماد به ادعا). */
function listOutputFiles(dir: string): RawFile[] {
  const out: RawFile[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (e.startsWith('.') || e === 'node_modules') continue;
        walk(full);
      } else if (st.isFile()) {
        out.push({ relPath: relative(dir, full).split(sep).join('/'), fullPath: full, bytes: st.size });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * گیت سینتکس برای فایل‌های TS/JS با transpileModule (بدون type-check؛ فقط
 * خطای نحوی). اگر typescript در دسترس نبود، چک رد می‌شود ولی فایل بلاک نمی‌شود؛
 * در نتیجه syntaxOk=false ثبت می‌شود تا قابل حسابرسی باشد.
 */
async function syntaxCheck(relPath: string, content: string): Promise<boolean> {
  const lower = relPath.toLowerCase();
  const isCode = ['.ts', '.tsx', '.js', '.jsx'].some((e) => lower.endsWith(e));
  if (!isCode) return true;
  try {
    const ts = (await import('typescript')) as typeof import('typescript');
    const out = ts.transpileModule(content, {
      compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext },
      reportDiagnostics: true,
    });
    const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    return errors.length === 0;
  } catch {
    return false;
  }
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

/**
 * پوش فایل‌ها به ریپوی سایت با GitHub git-database API:
 * blob ← tree ← commit ← به‌روزرسانی ref شاخه.
 * همیشه روی شاخه‌ی تازه‌ی team/<team>/<run-id> از روی master.
 */
async function pushToSiteRepo(opts: {
  token: string;
  repo: string;
  team: TeamName;
  runId: string;
  files: Array<{ path: string; content: string }>;
}): Promise<{ branch: string; commitSha: string; compareUrl: string }> {
  const { token, repo, team, runId, files } = opts;
  const h = ghHeaders(token);
  const api = `https://api.github.com/repos/${repo}`;
  const branch = `team/${team}/${runId}`;

  const refRes = await fetch(`${api}/git/refs/heads/${SITE_BASE_BRANCH}`, {
    headers: h,
    signal: AbortSignal.timeout(15_000),
  });
  if (!refRes.ok) throw new Error(`خواندن رأس ${SITE_BASE_BRANCH} ناموفق بود (${refRes.status}).`);
  const refBody = (await refRes.json()) as { object?: { sha?: string } };
  const baseSha = refBody.object?.sha;
  if (!baseSha) throw new Error('SHA رأس شاخه‌ی پایه پیدا نشد.');

  // اگر شاخه از اجرای قبلی مانده، همان را به‌روز می‌کنیم؛ وگرنه می‌سازیم.
  const existing = await fetch(`${api}/git/refs/heads/${branch}`, {
    headers: h,
    signal: AbortSignal.timeout(15_000),
  });
  if (existing.status === 404) {
    const mk = await fetch(`${api}/git/refs`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!mk.ok) throw new Error(`ساخت شاخه ناموفق بود (${mk.status}).`);
  } else if (!existing.ok) {
    throw new Error(`بررسی شاخه ناموفق بود (${existing.status}).`);
  }

  const blobs: Array<{ path: string; sha: string }> = [];
  for (const f of files) {
    const bRes = await fetch(`${api}/git/blobs`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ content: f.content, encoding: 'utf-8' }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!bRes.ok) throw new Error(`ساخت بلاب برای «${f.path}» ناموفق بود (${bRes.status}).`);
    const bBody = (await bRes.json()) as { sha?: string };
    if (!bBody.sha) throw new Error(`SHA بلاب برای «${f.path}» برنگشت.`);
    blobs.push({ path: f.path, sha: bBody.sha });
  }

  const tRes = await fetch(`${api}/git/trees`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      base_tree: baseSha,
      tree: blobs.map((b) => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha })),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!tRes.ok) throw new Error(`ساخت درخت گیت ناموفق بود (${tRes.status}).`);
  const tBody = (await tRes.json()) as { sha?: string };
  if (!tBody.sha) throw new Error('SHA درخت برنگشت.');

  const cRes = await fetch(`${api}/git/commits`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      message: `team(${team}): خروجی کد چرخه ${runId}`,
      tree: tBody.sha,
      parents: [baseSha],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!cRes.ok) throw new Error(`ساخت کامیت ناموفق بود (${cRes.status}).`);
  const cBody = (await cRes.json()) as { sha?: string };
  if (!cBody.sha) throw new Error('SHA کامیت برنگشت.');

  const uRes = await fetch(`${api}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    headers: h,
    body: JSON.stringify({ sha: cBody.sha, force: false }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!uRes.ok) throw new Error(`به‌روزرسانی شاخه ناموفق بود (${uRes.status}).`);

  return {
    branch,
    commitSha: cBody.sha.slice(0, 7),
    compareUrl: `https://github.com/${repo}/compare/${SITE_BASE_BRANCH}...${branch}`,
  };
}

/** ثبت متادیتای فایل‌ها در دیتابیس برای حسابرسی. */
async function recordFiles(
  cycleId: string | null | undefined,
  team: TeamName,
  runId: string,
  files: CollectedFile[],
  repo: string,
  push?: { branch: string; commitSha: string },
): Promise<void> {
  if (!cycleId) return;
  try {
    const { getSupabase } = await import('../lib/api');
    const sb = getSupabase();
    const rows = files.map((f) => ({
      cycle_id: cycleId,
      team,
      run_id: runId,
      path: f.path,
      sha256: f.sha256,
      bytes: f.bytes,
      lines: f.lines,
      target_repo: repo,
      branch: push?.branch ?? null,
      commit_sha: push?.commitSha ?? null,
      pushed_at: push ? new Date().toISOString() : null,
    }));
    const { error } = await sb.from('team_code_files').insert(rows);
    if (error) console.error('[code-collector] ثبت متادیتا ناموفق بود:', error.message);
  } catch (err) {
    console.error('[code-collector] خطا در ثبت متادیتا:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * نقطه‌ی ورود اصلی: جمع‌آوری، راستی‌آزمایی و (در صورت تأیید) پوش کد تیم.
 *
 * ترتیب گیت‌ها:
 *  ۱. فایل روی دیسک هست؟ (نه ادعای تیم)
 *  ۲. محدودیت‌های سندباکس (تعداد، حجم، خط، پسوند، مسیر)
 *  ۳. تطبیق با مانیفست اعلام‌شده‌ی تیم (اگر داده شده)
 *  ۴. سینتکس فایل‌های کد
 *  ۵. تأیید منتقد (approved) ← فقط در این صورت push
 */
export async function collectAndCommitTeamCode(options: CollectOptions): Promise<CollectionResult> {
  const {
    team,
    runId,
    cycleId,
    approved,
    declaredFiles,
    outputDir,
    targetRepo = SITE_REPO,
    dryRun = false,
  } = options;
  const token = options.token ?? process.env.SITE_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? null;

  const result: CollectionResult = {
    team,
    runId,
    files: [],
    manifestMismatches: [],
    rejected: [],
    pushed: false,
  };

  const dir = outputDir ?? teamOutputDir(team);
  const raw = listOutputFiles(dir);
  if (raw.length === 0) {
    result.skippedReason = 'تیم هیچ فایل کدی تولید نکرد (دایرکتوری خروجی خالی است).';
    return result;
  }

  if (raw.length > SANDBOX_LIMITS.maxFiles) {
    result.skippedReason = `تعداد فایل (${raw.length}) بیش از سقف مجاز (${SANDBOX_LIMITS.maxFiles}).`;
    return result;
  }

  let totalBytes = 0;
  const contents = new Map<string, string>();
  for (const f of raw) {
    totalBytes += f.bytes;
    try {
      const safe = sanitizeRelPath(f.relPath);
      if (f.bytes > SANDBOX_LIMITS.maxFileBytes) {
        result.rejected.push({ path: f.relPath, reason: `حجم بیش از سقف (${f.bytes} بایت)` });
        continue;
      }
      const content = readFileSync(f.fullPath, 'utf-8');
      const lines = countLines(content);
      if (lines > SANDBOX_LIMITS.maxLinesPerFile) {
        result.rejected.push({ path: f.relPath, reason: `خط بیش از سقف (${lines})` });
        continue;
      }
      contents.set(safe, content);
    } catch (err) {
      result.rejected.push({ path: f.relPath, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  if (totalBytes > SANDBOX_LIMITS.maxTotalBytes) {
    result.skippedReason = `حجم مجموع فایل‌ها (${totalBytes} بایت) بیش از سقف مجاز.`;
    return result;
  }

  // گیت ضدتوهم: هش واقعی بایت‌های دیسک + تطبیق با مانیفست تیم
  const declared = new Map<string, string | undefined>();
  for (const d of declaredFiles ?? []) {
    try {
      declared.set(sanitizeRelPath(d.path), d.sha256);
    } catch {
      result.manifestMismatches.push(d.path);
    }
  }
  for (const [safe, content] of Array.from(contents.entries())) {
    const hash = sha256Hex(content);
    const ok = await syntaxCheck(safe, content);
    result.files.push({
      path: safe,
      sha256: hash,
      bytes: Buffer.byteLength(content, 'utf-8'),
      lines: countLines(content),
      syntaxOk: ok,
    });
    if (!ok) {
      result.rejected.push({ path: safe, reason: 'خطای نحوی در فایل کد' });
      continue;
    }
    if (declared.size > 0) {
      if (!declared.has(safe)) {
        result.manifestMismatches.push(safe);
      } else {
        const claimed = declared.get(safe);
        if (claimed && claimed.toLowerCase() !== hash.toLowerCase()) {
          result.manifestMismatches.push(safe);
        }
      }
    }
  }
  for (const d of Array.from(declared.keys())) {
    if (!contents.has(d)) result.manifestMismatches.push(d);
  }

  // فایل‌های سالم برای ثبت
  const healthy = result.files.filter(
    (f) => !result.rejected.some((r) => r.path === f.path) && !result.manifestMismatches.includes(f.path),
  );

  if (!approved) {
    result.skippedReason = 'منتقد تیم را تأیید نکرد؛ کد پوش نمی‌شود (فایل‌ها در دیتابیس ثبت می‌شوند).';
    await recordFiles(cycleId, team, runId, healthy, targetRepo);
    return result;
  }
  if (result.manifestMismatches.length > 0) {
    result.skippedReason = `عدم تطبیق مانیفست (${result.manifestMismatches.length} مورد)؛ برای امنیت پوش انجام نشد.`;
    await recordFiles(cycleId, team, runId, healthy, targetRepo);
    return result;
  }
  if (healthy.length === 0) {
    result.skippedReason = 'هیچ فایل سالمی برای پوش باقی نماند.';
    await recordFiles(cycleId, team, runId, healthy, targetRepo);
    return result;
  }
  if (dryRun) {
    result.skippedReason = 'حالت dry-run؛ پوش انجام نشد.';
    await recordFiles(cycleId, team, runId, healthy, targetRepo);
    return result;
  }
  if (!token) {
    result.skippedReason = 'توکن گیت‌هاب برای ریپوی سایت در دسترس نیست (SITE_GITHUB_TOKEN).';
    await recordFiles(cycleId, team, runId, healthy, targetRepo);
    return result;
  }

  const payload = healthy.map((f) => ({ path: f.path, content: contents.get(f.path) ?? '' }));

  const push = await pushToSiteRepo({ token, repo: targetRepo, team, runId, files: payload });
  result.pushed = true;
  result.branch = push.branch;
  result.commitSha = push.commitSha;
  result.compareUrl = push.compareUrl;
  await recordFiles(cycleId, team, runId, healthy, targetRepo, {
    branch: push.branch,
    commitSha: push.commitSha,
  });
  return result;
}

/** اجرای مستقل از خط فرمان برای تست: npx tsx worker/code-collector.ts <team> <run-id> */
async function cli(): Promise<void> {
  const team = process.argv[2] as TeamName | undefined;
  const runId = process.argv[3] ?? `manual-${Date.now()}`;
  if (!team) {
    console.error('استفاده: npx tsx worker/code-collector.ts <team> <run-id> [--dry-run]');
    process.exit(1);
  }
  const res = await collectAndCommitTeamCode({
    team,
    runId,
    approved: true,
    dryRun: process.argv.includes('--dry-run'),
  });
  console.log(JSON.stringify(res, null, 2));
}

const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /code-collector(\.ts)?$/.test(process.argv[1]);
if (invokedDirectly) {
  cli().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
