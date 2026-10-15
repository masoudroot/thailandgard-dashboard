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
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonPanel } from '@/components/Skeleton';
import { DatePicker } from '@/components/ui/date-picker';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Pagination } from '@/components/ui/pagination';

type RegistryBadgeVariant =
  | 'default'
  | 'secondary'
  | 'outline'
  | 'success'
  | 'warning'
  | 'brand'
  | 'destructive';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { Field } from '@/components/ui/Input';
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

const FILE_STATUS_FA: Record<string, { label: string; variant: RegistryBadgeVariant }> = {
  added: { label: 'افزوده', variant: 'success' },
  modified: { label: 'ویرایش‌شده', variant: 'secondary' },
  removed: { label: 'حذف‌شده', variant: 'destructive' },
  renamed: { label: 'تغییرنام', variant: 'secondary' },
  copied: { label: 'کپی', variant: 'secondary' },
};

const PER_PAGE = 15;

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
      <Card
        aria-label="فیلتر تغییرات"
        className="mb-8 grid gap-3 p-4 shadow-surface sm:p-6 md:grid-cols-4"
      >
        <Field label="تیم">
          <Select
            id="changes-team"
            value={team}
            onChange={(e) => applyFilter({ team: e.target.value })}
            options={[
              { value: "all", label: "همهٔ تیم‌ها" },
              ...ALL_TEAM_SLUGS.map((slug) => ({
                value: slug,
                label: teamFa(slug),
              })),
              { value: "other", label: "سایر (بدون برچسب تیم)" },
            ]}
          />
        </Field>
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
          <Button
            variant="outline"
            onClick={() => applyFilter({ team: 'all', since: '', until: '' })}
            disabled={team === 'all' && !since && !until}
            className="w-full md:w-auto"
          >
            پاک کردن فیلترها
          </Button>
        </div>
      </Card>

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
          <Button
            variant="default"
            onClick={() => fetchCommits(page, team, since, until)}
            className="mt-4"
          >
            <RotateCcw size={16} aria-hidden="true" />
            تلاش دوباره
          </Button>
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
                        <Badge variant="secondary">
                          {c.team ? teamFa(c.team) : 'سایر'}
                        </Badge>
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
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => toggleFiles(c.sha)}
                        aria-expanded={open}
                      >
                        <FileDiff size={15} aria-hidden="true" />
                        فایل‌ها
                        <ChevronDown
                          size={15}
                          aria-hidden="true"
                          className={`transition-transform ${open ? 'rotate-180' : ''}`}
                        />
                      </Button>
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
                                  variant: 'secondary' as RegistryBadgeVariant,
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
                                      <Badge variant={st.variant}>
                                        {st.label}
                                      </Badge>
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

          {/* صفحه‌بندی واقعی روی دادهٔ گیت‌هاب؛ total معلوم نیست پس صفحهٔ آخرِ شناخته‌شده: صفحهٔ بعد فقط وقتی هست که hasMore باشد */}
          <div className="mt-6 flex justify-center">
            <Pagination
              page={page}
              total={hasMore ? page + 1 : page}
              onChange={setPage}
            />
          </div>
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
    <EmptyState
      icon={Unplug}
      title="گیت‌هاب متصل نیست"
      description="تاریخچهٔ تغییرات فقط از GitHub واقعی خوانده می‌شود. برای دیدن کامیت‌ها، اتصال گیت‌هاب را در تنظیمات برقرار کنید."
      action={
        <Link
          href="/dashboard/settings"
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-primary px-6 py-2 text-sm font-bold text-primary-foreground shadow-control hover:opacity-90"
        >
          رفتن به تنظیمات
        </Link>
      }
    />
  );
}
