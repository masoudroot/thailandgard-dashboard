'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  GitCommitHorizontal,
  Unplug,
  ExternalLink,
  ChevronDown,
  RotateCcw,
  CircleAlert,
  FileDiff,
  SearchX,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import EmptyState from '@/components/EmptyState';
import { SkeletonPanel } from '@/components/Skeleton';
import { DatePicker } from '@/components/ui/date-picker';
import { faNum } from '@/lib/format';
import { ALL_TEAM_SLUGS, teamFa } from '@/lib/github-teams';

/** «YYYY-MM-DD» به Date محلی؛ خالی → null. */
function ymdToDate(ymd: string): Date | null {
  if (!ymd) return null;
  const d = new Date(`${ymd}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date به «YYYY-MM-DD» محلی؛ null → رشته خالی. */
function dateToYmd(d: Date | null): string {
  if (!d) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ------------------------------------------------------------------ */
/* کمک‌کننده‌های فارسی‌سازی                                          */
/* ------------------------------------------------------------------ */

/** تاریخ شمسی به وقت تهران. */
function jalaliDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(new Date(iso));
  } catch {
    return 'نامشخص';
  }
}

/** ساعت به وقت تهران. */
function tehranTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      timeZone: 'Asia/Tehran',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* نوع داده‌ها (همان خروجی واقعی /api/github/commits)                 */
/* ------------------------------------------------------------------ */

interface CommitSummary {
  sha: string;
  shortSha: string;
  title: string;
  team: string | null;
  authorName: string;
  authorLogin: string | null;
  date: string;
  url: string;
}

interface CommitFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

interface CommitDetail extends CommitSummary {
  message: string;
  files: CommitFile[];
  additions: number;
  deletions: number;
  total: number;
}

interface ApiError {
  message: string;
  notConnected: boolean;
}

const FILE_STATUS_FA: Record<string, { label: string; tint: string }> = {
  added: { label: 'افزوده', tint: 'bg-success/10 text-success' },
  modified: { label: 'ویرایش‌شده', tint: 'bg-secondary text-secondary-foreground' },
  removed: { label: 'حذف‌شده', tint: 'bg-destructive/10 text-destructive' },
  renamed: { label: 'تغییرنام', tint: 'bg-secondary text-secondary-foreground' },
  copied: { label: 'کپی', tint: 'bg-secondary text-secondary-foreground' },
};

const PER_PAGE = 15;

const inputClass =
  'min-h-11 rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground shadow-control placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30';

/* ------------------------------------------------------------------ */
/* صفحه                                                                 */
/* ------------------------------------------------------------------ */

export default function ChangesPage() {
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [page, setPage] = useState(1);
  const [team, setTeam] = useState('all');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [details, setDetails] = useState<
    Record<string, CommitDetail | 'loading' | 'error'>
  >({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const fetchCommits = useCallback(
    async (p: number, t: string, s: string, u: string) => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({
          page: String(p),
          per_page: String(PER_PAGE),
          team: t,
        });
        if (s) qs.set('since', `${s}T00:00:00+03:30`);
        if (u) qs.set('until', `${u}T23:59:59+03:30`);
        const res = await fetch(`/api/github/commits?${qs.toString()}`, {
          cache: 'no-store',
        });
        const body = await res.json();
        if (!res.ok || body?.ok === false) {
          throw {
            message: String(body?.error?.message ?? 'خواندن تغییرات انجام نشد؛ دوباره تلاش کنید.'),
            notConnected: !!body?.error?.not_connected,
          } satisfies ApiError;
        }
        setCommits(Array.isArray(body?.data?.commits) ? body.data.commits : []);
        setHasMore(!!body?.data?.has_more);
      } catch (err) {
        if (err && typeof err === 'object' && 'message' in err) {
          setError(err as ApiError);
        } else {
          setError({
            message: 'ارتباط با سرور داشبورد برقرار نشد. اتصال اینترنت را بررسی کنید.',
            notConnected: false,
          });
        }
        setCommits([]);
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    fetchCommits(page, team, since, until);
  }, [fetchCommits, page, team, since, until]);

  function applyFilter(next: { team?: string; since?: string; until?: string }) {
    if (next.team !== undefined) setTeam(next.team);
    if (next.since !== undefined) setSince(next.since);
    if (next.until !== undefined) setUntil(next.until);
    setPage(1);
    setExpanded({});
  }

  async function toggleFiles(sha: string) {
    const isOpen = !!expanded[sha];
    setExpanded((prev) => ({ ...prev, [sha]: !isOpen }));
    if (isOpen || details[sha]) return;
    setDetails((prev) => ({ ...prev, [sha]: 'loading' }));
    try {
      const res = await fetch(`/api/github/commits/${sha}`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok || body?.ok === false || !body?.data?.commit) {
        throw new Error(String(body?.error?.message ?? 'خواندن فایل‌ها انجام نشد؛ دوباره تلاش کنید.'));
      }
      setDetails((prev) => ({ ...prev, [sha]: body.data.commit as CommitDetail }));
    } catch {
      setDetails((prev) => ({ ...prev, [sha]: 'error' }));
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl">
      <PageHeader
        icon={GitCommitHorizontal}
        title="تاریخچه تغییرات سایت"
        subtitle="کامیت‌های واقعی ریپوی masoudroot/thailandgard (شاخهٔ dev) مستقیم از GitHub خوانده می‌شود؛ هیچ دادهٔ نمایشی این‌جا نیست."
      />

      {/* فیلترها: موبایل روی هم، دسکتاپ در یک ردیف */}
      <section
        aria-label="فیلتر تغییرات"
        className="mb-8 grid gap-3 rounded-xl border border-border bg-card p-4 shadow-surface sm:p-6 md:grid-cols-4"
      >
        <div>
          <label htmlFor="changes-team" className="mb-1.5 block text-sm font-medium text-foreground">
            تیم
          </label>
          <select
            id="changes-team"
            value={team}
            onChange={(e) => applyFilter({ team: e.target.value })}
            className={`${inputClass} w-full`}
          >
            <option value="all">همهٔ تیم‌ها</option>
            {ALL_TEAM_SLUGS.map((slug) => (
              <option key={slug} value={slug}>
                {teamFa(slug)}
              </option>
            ))}
            <option value="other">سایر (بدون برچسب تیم)</option>
          </select>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">
            از تاریخ
          </label>
          <DatePicker
            value={ymdToDate(since)}
            max={ymdToDate(until) ?? undefined}
            onChange={(d) => applyFilter({ since: dateToYmd(d) })}
            placeholder="از تاریخ"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">
            تا تاریخ
          </label>
          <DatePicker
            value={ymdToDate(until)}
            min={ymdToDate(since) ?? undefined}
            onChange={(d) => applyFilter({ until: dateToYmd(d) })}
            placeholder="تا تاریخ"
          />
        </div>
        <div className="flex items-end">
          <button
            type="button"
            onClick={() => applyFilter({ team: 'all', since: '', until: '' })}
            disabled={team === 'all' && !since && !until}
            className="min-h-11 w-full rounded-lg border border-input bg-background px-4 py-2 text-sm font-medium text-foreground shadow-control transition-opacity hover:opacity-80 disabled:opacity-40 md:w-auto"
          >
            پاک کردن فیلترها
          </button>
        </div>
      </section>

      {loading ? (
        <div aria-busy="true">
          <SkeletonPanel className="min-h-96" />
          <span className="sr-only">در حال خواندن کامیت‌ها از گیت‌هاب…</span>
        </div>
      ) : error?.notConnected ? (
        <NotConnectedGuide />
      ) : error ? (
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center"
        >
          <CircleAlert className="mx-auto h-10 w-10 text-destructive" aria-hidden="true" />
          <h2 className="mt-3 text-lg font-bold text-foreground">خواندن تغییرات انجام نشد</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-7 text-muted-foreground">
            {error.message}
          </p>
          <button
            type="button"
            onClick={() => fetchCommits(page, team, since, until)}
            className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm font-bold text-primary-foreground shadow-control transition-opacity hover:opacity-90"
          >
            <RotateCcw size={16} aria-hidden="true" />
            تلاش دوباره
          </button>
        </div>
      ) : commits.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="کامتی پیدا نشد"
          description="با این فیلترها هیچ کامتی در شاخهٔ dev نیست. فیلترها را بازتر کنید یا بازهٔ تاریخ را عوض کنید."
        />
      ) : (
        <>
          {/* فهرست کامیت‌ها */}
          <ol className="space-y-3">
            {commits.map((c) => {
              const open = !!expanded[c.sha];
              const detail = details[c.sha];
              return (
                <li
                  key={c.sha}
                  className="rounded-xl border border-border bg-card p-4 shadow-surface sm:p-5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <h2 className="text-base font-bold leading-7 text-foreground">
                        {c.title || '(بدون عنوان)'}
                      </h2>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                        <span
                          className="rounded-full bg-secondary px-2.5 py-0.5 font-medium text-secondary-foreground"
                        >
                          {c.team ? teamFa(c.team) : 'سایر'}
                        </span>
                        <span>
                          {jalaliDate(c.date)}
                          {tehranTime(c.date) ? `، ساعت ${tehranTime(c.date)}` : ''}
                        </span>
                        <span>{c.authorName}</span>
                        <code dir="ltr" className="rounded bg-muted px-1.5 py-0.5 font-mono">
                          {c.shortSha}
                        </code>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => toggleFiles(c.sha)}
                        aria-expanded={open}
                        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-control transition-opacity hover:opacity-80"
                      >
                        <FileDiff size={15} aria-hidden="true" />
                        فایل‌ها
                        <ChevronDown
                          size={15}
                          aria-hidden="true"
                          className={`transition-transform ${open ? 'rotate-180' : ''}`}
                        />
                      </button>
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground shadow-control transition-opacity hover:opacity-90"
                      >
                        <ExternalLink size={15} aria-hidden="true" />
                        گیت‌هاب
                      </a>
                    </div>
                  </div>

                  {/* فایل‌های تغییرکرده: واقعی، از API کامیت */}
                  {open && (
                    <div className="mt-4 border-t border-border pt-4">
                      {detail === 'loading' && (
                        <p className="py-2 text-sm text-muted-foreground">
                          در حال خواندن فایل‌ها از گیت‌هاب…
                        </p>
                      )}
                      {detail === 'error' && (
                        <p role="alert" className="py-2 text-sm text-destructive">
                          خواندن فایل‌های این کامیت ناموفق بود. دوباره تلاش کنید.
                        </p>
                      )}
                      {detail && detail !== 'loading' && detail !== 'error' && (
                        <>
                          <p className="mb-3 text-sm text-muted-foreground">
                            {faNum(detail.files.length)} فایل تغییر کرده
                            {detail.total > 0 && (
                              <>
                                {' '}(
                                <span className="text-success">+{faNum(detail.additions)}</span>
                                {' / '}
                                <span className="text-destructive">-{faNum(detail.deletions)}</span>
                                )
                              </>
                            )}
                          </p>
                          {detail.files.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                              گیت‌هاب برای این کامیت فایلی ثبت نکرده است.
                            </p>
                          ) : (
                            <ul className="space-y-1.5">
                              {detail.files.map((f) => {
                                const st = FILE_STATUS_FA[f.status] ?? {
                                  label: f.status,
                                  tint: 'bg-secondary text-secondary-foreground',
                                };
                                return (
                                  <li
                                    key={f.filename}
                                    className="flex items-center justify-between gap-3 rounded-lg bg-background px-3 py-2"
                                  >
                                    <span
                                      dir="ltr"
                                      className="min-w-0 flex-1 truncate font-mono text-xs text-foreground"
                                      title={f.filename}
                                    >
                                      {f.filename}
                                    </span>
                                    <span className="flex shrink-0 items-center gap-2">
                                      <span className="font-mono text-xs" dir="ltr">
                                        <span className="text-success">+{faNum(f.additions)}</span>
                                        {' '}
                                        <span className="text-destructive">-{faNum(f.deletions)}</span>
                                      </span>
                                      <span
                                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${st.tint}`}
                                      >
                                        {st.label}
                                      </span>
                                    </span>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>

          {/* صفحه‌بندی واقعی روی دادهٔ گیت‌هاب */}
          <nav
            aria-label="صفحه‌بندی تغییرات"
            className="mt-6 flex items-center justify-between gap-3"
          >
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="min-h-11 rounded-lg border border-input bg-card px-5 py-2 text-sm font-medium text-foreground shadow-control transition-opacity hover:opacity-80 disabled:opacity-40"
            >
              قبلی
            </button>
            <p className="text-sm text-muted-foreground">
              صفحهٔ {faNum(page)}
            </p>
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasMore}
              className="min-h-11 rounded-lg border border-input bg-card px-5 py-2 text-sm font-medium text-foreground shadow-control transition-opacity hover:opacity-80 disabled:opacity-40"
            >
              بعدی
            </button>
          </nav>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* راهنمای صادقانهٔ «متصل نیست»                                      */
/* ------------------------------------------------------------------ */

function NotConnectedGuide() {
  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-surface sm:p-8">
      <div className="mx-auto max-w-2xl text-center">
        <span
          aria-hidden="true"
          className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-muted text-muted-foreground"
        >
          <Unplug size={26} strokeWidth={1.75} />
        </span>
        <h2 className="mt-4 text-xl font-bold text-foreground">گیت‌هاب متصل نیست</h2>
        <p className="mt-2 text-sm leading-8 text-muted-foreground">
          تاریخچهٔ تغییرات فقط از GitHub واقعی خوانده می‌شود و این‌جا هیچ لیست نمایشی
          نمی‌سازیم. برای دیدن کامیت‌ها، یک توکن گیت‌هاب وصل کنید:
        </p>
      </div>
      <ol className="mx-auto mt-6 max-w-2xl space-y-4 text-sm leading-8 text-foreground">
        <li className="flex gap-3">
          <span
            aria-hidden="true"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-bold text-brand-foreground"
          >
            {faNum(1)}
          </span>
          <p>
            در گیت‌هاب یک توکن شخصی بسازید:{' '}
            <span dir="ltr" className="font-mono text-sm">github.com/settings/tokens</span>
            {' '}← گزینهٔ «Generate new token (classic)» با دسترسی{' '}
            <code dir="ltr" className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">repo</code>
            {' '}(ریپوی سایت خصوصی است و بدون این دسترسی دیده نمی‌شود).
          </p>
        </li>
        <li className="flex gap-3">
          <span
            aria-hidden="true"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-bold text-brand-foreground"
          >
            {faNum(2)}
          </span>
          <p>
            توکن را در صفحهٔ تنظیمات داشبورد، در کارت «اتصال گیت‌هاب» وارد و ذخیره کنید؛
            یا اگر روی ورسل دیپلوی کرده‌اید، متغیر محیطی{' '}
            <code dir="ltr" className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">GITHUB_TOKEN</code>
            {' '}را در تنظیمات پروژه بگذارید.
          </p>
        </li>
        <li className="flex gap-3">
          <span
            aria-hidden="true"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-bold text-brand-foreground"
          >
            {faNum(3)}
          </span>
          <p>به همین صفحه برگردید؛ لیست واقعی کامیت‌ها خودکار خوانده می‌شود.</p>
        </li>
      </ol>
      <div className="mt-6 text-center">
        <Link
          href="/dashboard/settings"
          className="inline-flex min-h-12 items-center rounded-lg bg-primary px-6 py-2.5 text-sm font-bold text-primary-foreground shadow-control transition-opacity hover:opacity-90"
        >
          رفتن به تنظیمات
        </Link>
      </div>
    </div>
  );
}
