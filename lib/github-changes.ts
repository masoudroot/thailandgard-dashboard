/**
 * lib/github-changes.ts - کلاینت سمت سرور برای «تاریخچهٔ تغییرات سایت».
 *
 * فقط در route handler ها استفاده شود؛ هرگز از کلاینت صدا زده نمی‌شود.
 * قانون مطلق مسعود: هیچ دادهٔ نمایشی. اگر توکن نباشد یا API خطا دهد،
 * خطای صادقانه برمی‌گردد تا صفحه «متصل نیست» یا پیام خطا نشان دهد.
 *
 * توکن از همان قرارداد موجود lib/github.ts می‌آید:
 * settings (کلید github_token) و بعد env GITHUB_TOKEN.
 * ریپوی سایت: masoudroot/thailandgard، شاخهٔ dev.
 */

import { getGithubConfig } from './github';
import { extractTeamSlug, titleWithoutPrefix } from './github-teams';

export const SITE_OWNER = 'masoudroot';
export const SITE_REPO = 'thailandgard';
/** شاخه‌ای که تیم‌ها روی آن کامیت می‌زنند. */
export const SITE_BRANCH = 'dev';

/** خطای صادقانهٔ لایهٔ گیت‌هاب. */
export class GithubError extends Error {
  /** true یعنی مشکل از اتصال/توکن است و باید راهنمای اتصال نشان داده شود. */
  readonly notConnected: boolean;
  readonly status: number;

  constructor(message: string, opts: { notConnected?: boolean; status?: number } = {}) {
    super(message);
    this.name = 'GithubError';
    this.notConnected = opts.notConnected ?? false;
    this.status = opts.status ?? 500;
  }
}

export interface CommitSummary {
  sha: string;
  shortSha: string;
  title: string;
  /** اسلاگ تیم از پیشوند [team]؛ null یعنی کامیت برچسب تیم ندارد. */
  team: string | null;
  authorName: string;
  authorLogin: string | null;
  date: string;
  url: string;
}

export interface CommitFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface CommitDetail extends CommitSummary {
  message: string;
  files: CommitFile[];
  additions: number;
  deletions: number;
  total: number;
}

export interface CommitListResult {
  commits: CommitSummary[];
  page: number;
  perPage: number;
  hasMore: boolean;
}

interface GhListItem {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name: string; date: string } | null;
  };
  author: { login: string } | null;
}

function toSummary(item: GhListItem): CommitSummary {
  const message = item.commit?.message ?? '';
  return {
    sha: item.sha,
    shortSha: item.sha.slice(0, 7),
    title: titleWithoutPrefix(message),
    team: extractTeamSlug(message),
    authorName: item.commit?.author?.name ?? 'نامشخص',
    authorLogin: item.author?.login ?? null,
    date: item.commit?.author?.date ?? '',
    url: item.html_url,
  };
}

async function githubFetch(path: string, token: string): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'thailandgard-dashboard',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(25_000),
  });
}

function mapHttpError(res: Response): GithubError {
  if (res.status === 401) {
    return new GithubError(
      'توکن گیت‌هاب معتبر نیست یا منقضی شده است. یک توکن تازه بسازید و جایگزین کنید.',
      { status: 401 },
    );
  }
  if (res.status === 403) {
    return new GithubError(
      'گیت‌هاب درخواست را رد کرد؛ معمولاً یعنی سقف نرخ API تمام شده یا توکن دسترسی کافی ندارد. کمی بعد دوباره تلاش کنید.',
      { status: 403 },
    );
  }
  if (res.status === 404) {
    return new GithubError(
      'ریپوی masoudroot/thailandgard پیدا نشد. یا توکن به آن دسترسی ندارد یا نام ریپو عوض شده است.',
      { status: 404 },
    );
  }
  return new GithubError(`گیت‌هاب خطا داد (کد ${res.status}). کمی بعد دوباره تلاش کنید.`, {
    status: res.status,
  });
}

async function requireToken(): Promise<string> {
  const { token } = await getGithubConfig();
  if (!token) {
    throw new GithubError(
      'توکن گیت‌هاب تنظیم نشده است؛ پس لیست تغییرات را نمی‌توان از گیت‌هاب خواند.',
      { notConnected: true, status: 503 },
    );
  }
  return token;
}

/**
 * فهرست کامیت‌های شاخهٔ dev از GitHub واقعی.
 * فیلتر تاریخ (since/until) سمت خود گیت‌هاب اعمال می‌شود؛ فیلتر تیم چون
 * قرارداد داخلی ماست، روی دادهٔ واقعی همین‌جا اعمال می‌شود.
 */
export async function listSiteCommits(opts: {
  page: number;
  perPage: number;
  team?: string;
  since?: string;
  until?: string;
}): Promise<CommitListResult> {
  const token = await requireToken();

  const page = Math.max(1, Math.floor(opts.page) || 1);
  const perPage = Math.min(50, Math.max(5, Math.floor(opts.perPage) || 15));
  const team = (opts.team ?? '').trim().toLowerCase();

  const qs = new URLSearchParams({ sha: SITE_BRANCH, per_page: '100' });
  if (opts.since) qs.set('since', opts.since);
  if (opts.until) qs.set('until', opts.until);

  const matched: CommitSummary[] = [];
  let ghPage = 1;
  let ghExhausted = false;
  const need = page * perPage;
  // حداکثر ۱۰ صفحهٔ ۱۰۰تایی گیت‌هاب (۱۰۰۰ کامیت) برای پر کردن یک صفحه اسکن می‌شود.
  while (matched.length < need && !ghExhausted && ghPage <= 10) {
    let res: Response;
    try {
      res = await githubFetch(
        `/repos/${SITE_OWNER}/${SITE_REPO}/commits?${qs.toString()}&page=${ghPage}`,
        token,
      );
    } catch {
      throw new GithubError('ارتباط با گیت‌هاب برقرار نشد. اتصال اینترنت سرور را بررسی کنید.', {
        status: 502,
      });
    }
    if (!res.ok) throw mapHttpError(res);
    const items = (await res.json()) as GhListItem[];
    if (items.length < 100) ghExhausted = true;
    for (const item of items) {
      const s = toSummary(item);
      if (!team || team === 'all' || (team === 'other' ? !s.team : s.team === team)) {
        matched.push(s);
      }
      if (matched.length >= need) break;
    }
    ghPage += 1;
  }

  const start = (page - 1) * perPage;
  return {
    commits: matched.slice(start, start + perPage),
    page,
    perPage,
    hasMore: matched.length > start + perPage || !ghExhausted,
  };
}

/** جزئیات یک کامیت واقعی: پیام کامل و فایل‌های تغییرکرده از API کامیت. */
export async function getSiteCommitDetail(sha: string): Promise<CommitDetail> {
  const token = await requireToken();
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new GithubError('شناسهٔ کامیت معتبر نیست.', { status: 400 });
  }

  let res: Response;
  try {
    res = await githubFetch(`/repos/${SITE_OWNER}/${SITE_REPO}/commits/${sha}`, token);
  } catch {
    throw new GithubError('ارتباط با گیت‌هاب برقرار نشد.', { status: 502 });
  }
  if (!res.ok) throw mapHttpError(res);

  const c = (await res.json()) as {
    sha: string;
    html_url: string;
    commit: { message: string; author: { name: string; date: string } | null };
    author: { login: string } | null;
    files?: Array<{ filename: string; status: string; additions: number; deletions: number }>;
    stats?: { additions: number; deletions: number; total: number };
  };

  const summary = toSummary({
    sha: c.sha,
    html_url: c.html_url,
    commit: c.commit,
    author: c.author,
  });

  return {
    ...summary,
    message: c.commit?.message ?? '',
    files: (c.files ?? []).map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
    })),
    additions: c.stats?.additions ?? 0,
    deletions: c.stats?.deletions ?? 0,
    total: c.stats?.total ?? 0,
  };
}

/** تست اتصال: ریپوی سایت با همین توکن دیده می‌شود یا نه. */
export async function testSiteConnection(): Promise<{ repo: string; isPrivate: boolean }> {
  const token = await requireToken();
  let res: Response;
  try {
    res = await githubFetch(`/repos/${SITE_OWNER}/${SITE_REPO}`, token);
  } catch {
    throw new GithubError('ارتباط با گیت‌هاب برقرار نشد.', { status: 502 });
  }
  if (!res.ok) throw mapHttpError(res);
  const repo = (await res.json()) as { full_name: string; private: boolean };
  return { repo: repo.full_name, isPrivate: !!repo.private };
}
