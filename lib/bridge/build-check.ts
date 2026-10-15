/**
 * lib/bridge/build-check.ts — بررسی سلامت بیلد بعد از کامیت پل.
 *
 * بعد از هر کامیت خودکار «پل» روی ریپوی سایت، این ماژول وضعیت آخرین کامیت
 * شاخه را از GitHub API می‌خواند (commit status ترکیبی + check runs) و حکم
 * می‌دهد.
 *
 * قانون صداقت (دستور مسعود): هیچ‌وقت «سبز جعلی» گزارش نمی‌شود.
 * - اگر توکن گیت‌هاب تنظیم نشده باشد → checked: false با دلیل فارسی.
 * - اگر ریپو هیچ ورک‌فلوی CI نداشته باشد → checked: false با دلیل
 *   «CI پیکربندی نشده»؛ این حالت بلاک‌کنندهٔ مرج نیست، فقط اطلاع‌رسانی است.
 * - passed فقط وقتی true است که حداقل یک چک واقعی اجرا شده و همه موفق‌اند.
 *
 * توکن از همان مسیر استاندارد پروژه خوانده می‌شود: settings (کلید
 * github_token) ← env GITHUB_TOKEN (نگاه کنید به lib/github.ts).
 */

import { getGithubConfig } from '../github';

/** خروجی استاندارد بررسی بیلد؛ همهٔ متن‌ها فارسی‌اند. */
export interface BuildCheckResult {
  /** آیا بررسی معناداری انجام شد؟ false یعنی «نمی‌دانیم»، نه «سبز». */
  checked: boolean;
  /** فقط وقتی true که حداقل یک چک واقعی اجرا شده و همه موفق‌اند. */
  passed: boolean;
  /** توضیح فارسی برای نمایش به مسعود یا ثبت در لاگ. */
  details: string;
  /** لینک صفحهٔ چک‌های کامیت (یا صفحهٔ اکشن‌ها وقتی CI نیست). */
  url?: string;
}

interface ApiStatus {
  state: 'pending' | 'success' | 'failure' | 'error';
  context: string;
  target_url: string;
}

interface CombinedStatusBody {
  state: 'pending' | 'success' | 'failure' | 'error';
  statuses: ApiStatus[];
  total_count: number;
}

interface ApiCheckRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  html_url: string;
}

interface CheckRunsBody {
  total_count: number;
  check_runs: ApiCheckRun[];
}

interface WorkflowsBody {
  total_count: number;
  workflows: Array<{ id: number; name: string; path: string; state: string }>;
}

const GH_API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 20_000;
const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

/** ارقام لاتین ← فارسی برای متن‌های نمایشی. */
function fa(n: number): string {
  return String(n).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]);
}

function validateRef(value: string, label: string): void {
  if (!/^[A-Za-z0-9_.\/-]{1,200}$/.test(value)) {
    throw new Error(`مقدار «${label}» نامعتبر است: ${value}`);
  }
  if (value.includes('..')) throw new Error(`مقدار «${label}» نامعتبر است.`);
}

async function apiGet<T>(token: string, path: string): Promise<{ status: number; body: T | null }> {
  const res = await fetch(`${GH_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 404) return { status: 404, body: null };
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`فراخوانی GitHub API ناموفق بود (وضعیت ${res.status}): ${detail.slice(0, 200)}`);
  }
  return { status: res.status, body: (await res.json()) as T };
}

/** SHA رأس شاخه؛ null یعنی شاخه پیدا نشد. */
async function getBranchSha(token: string, owner: string, repo: string, branch: string): Promise<string | null> {
  const { body } = await apiGet<{ object?: { sha?: string } }>(
    token,
    `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
  );
  return body?.object?.sha ?? null;
}

interface CheckItem {
  name: string;
  /** fail: ناموفق/خطا/لغو | pending: در صف/در حال اجرا | ok: موفق */
  verdict: 'fail' | 'pending' | 'ok';
  note: string;
}

function classifyStatus(s: ApiStatus): CheckItem {
  if (s.state === 'success') return { name: s.context, verdict: 'ok', note: '' };
  if (s.state === 'pending') return { name: s.context, verdict: 'pending', note: '' };
  return { name: s.context, verdict: 'fail', note: s.state === 'error' ? 'خطا' : 'ناموفق' };
}

function classifyCheckRun(r: ApiCheckRun): CheckItem {
  if (r.status !== 'completed' || r.conclusion === null) {
    return { name: r.name, verdict: 'pending', note: '' };
  }
  switch (r.conclusion) {
    case 'success':
    case 'neutral':
    case 'skipped':
      return { name: r.name, verdict: 'ok', note: '' };
    case 'cancelled':
      return { name: r.name, verdict: 'fail', note: 'لغو شد' };
    case 'stale':
      return { name: r.name, verdict: 'pending', note: 'قدیمی شد' };
    default:
      return { name: r.name, verdict: 'fail', note: 'ناموفق' };
  }
}

/**
 * وضعیت سلامت بیلد آخرین کامیت شاخه را بررسی می‌کند.
 *
 * این تابع بلاک‌کنندهٔ مرج نیست: وقتی CI پیکربندی نشده یا وضعیت قابل
 * خواندن نیست، checked: false برمی‌گرداند تا صداکننده فقط اطلاع‌رسانی کند.
 */
export async function checkBridgeBuild(
  owner: string,
  repo: string,
  branch: string,
): Promise<BuildCheckResult> {
  validateRef(owner, 'owner');
  validateRef(repo, 'repo');
  validateRef(branch, 'branch');

  const { token } = await getGithubConfig();
  if (!token) {
    return {
      checked: false,
      passed: false,
      details: 'توکن گیت‌هاب تنظیم نشده است؛ نمی‌توانم وضعیت بیلد را بخوانم. نتیجه‌ای گزارش نمی‌شود.',
    };
  }

  const sha = await getBranchSha(token, owner, repo, branch);
  if (!sha) {
    return {
      checked: false,
      passed: false,
      details: `شاخهٔ «${branch}» در ریپوی ${owner}/${repo} پیدا نشد؛ وضعیت بیلدی برای بررسی نیست.`,
      url: `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(branch)}`,
    };
  }
  const shortSha = sha.slice(0, 7);
  const checksUrl = `https://github.com/${owner}/${repo}/commit/${sha}/checks`;

  // ۱) آیا ریپو اصلاً ورک‌فلوی CI دارد؟ مبنا همان است، نه حدس ما.
  const wf = await apiGet<WorkflowsBody>(token, `/repos/${owner}/${repo}/actions/workflows?per_page=1`);
  if (wf.status !== 200 || !wf.body) {
    return {
      checked: false,
      passed: false,
      details: `نمی‌توانم فهرست ورک‌فلوهای ریپوی ${owner}/${repo} را بخوانم (دسترسی کافی نیست)؛ پس وجود CI را نه تأیید می‌کنم نه رد.`,
      url: `https://github.com/${owner}/${repo}/actions`,
    };
  }
  if (wf.body.total_count === 0) {
    return {
      checked: false,
      passed: false,
      details:
        'CI پیکربندی نشده است؛ ریپو هیچ ورک‌فلوی GitHub Actions ندارد، پس چیزی برای «سبز بودن» نیست. این چک فقط اطلاع‌رسانی است و مرج را بلاک نمی‌کند.',
      url: `https://github.com/${owner}/${repo}/actions`,
    };
  }

  // ۲) وضعیت ترکیبی + check runs آخرین کامیت
  const combined = await apiGet<CombinedStatusBody>(
    token,
    `/repos/${owner}/${repo}/commits/${sha}/status`,
  );
  let runs: CheckRunsBody | null = null;
  try {
    const r = await apiGet<CheckRunsBody>(token, `/repos/${owner}/${repo}/commits/${sha}/check-runs`);
    runs = r.body;
  } catch {
    // دسترسی check runs ممکن است محدود باشد؛ با همان commit status ادامه می‌دهیم.
    runs = null;
  }

  const items: CheckItem[] = [];
  if (combined.body) {
    for (const s of combined.body.statuses ?? []) items.push(classifyStatus(s));
  }
  if (runs) {
    for (const r of runs.check_runs ?? []) items.push(classifyCheckRun(r));
  }

  if (items.length === 0) {
    return {
      checked: true,
      passed: false,
      details: `روی کامیت ${shortSha} هنوز هیچ نتیجهٔ چکی ثبت نشده است؛ احتمالاً چک‌ها در صف‌اند یا تازه شروع شده‌اند.`,
      url: checksUrl,
    };
  }

  const fails = items.filter((i) => i.verdict === 'fail');
  const pendings = items.filter((i) => i.verdict === 'pending');
  const oks = items.filter((i) => i.verdict === 'ok');

  if (fails.length > 0) {
    const names = fails
      .slice(0, 5)
      .map((i) => `«${i.name}»${i.note ? ` (${i.note})` : ''}`)
      .join('، ');
    const more = fails.length > 5 ? ` و ${fa(fails.length - 5)} مورد دیگر` : '';
    return {
      checked: true,
      passed: false,
      details: `بیلد قرمز است؛ روی کامیت ${shortSha} تعداد ${fa(fails.length)} چک ناموفق شد: ${names}${more}.`,
      url: checksUrl,
    };
  }

  if (pendings.length > 0) {
    return {
      checked: true,
      passed: false,
      details: `چک‌های کامیت ${shortSha} هنوز تمام نشده‌اند؛ ${fa(pendings.length)} در انتظار یا در حال اجرا و ${fa(oks.length)} موفق.`,
      url: checksUrl,
    };
  }

  return {
    checked: true,
    passed: true,
    details: `بیلد سبز است؛ هر ${fa(oks.length)} چک روی کامیت ${shortSha} موفق شدند.`,
    url: checksUrl,
  };
}
