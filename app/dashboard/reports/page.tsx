'use client';

import { useEffect, useMemo, useState } from 'react';
import { FileText, FileX2 } from 'lucide-react';
import type { Cycle, TeamName } from '@/lib/types';
import { EmptyState } from '@/components/ui/empty-state';
import NotConnected from '@/components/NotConnected';
import PageHeader from '@/components/PageHeader';
import { SkeletonPanel, SkeletonStat } from '@/components/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { faDigits } from "@/lib/format";

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
    return '';
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

/** مدت چرخه به دقیقهٔ فارسی. */
function durationFa(cycle: Cycle): string {
  if (!cycle.finished_at) return '';
  const ms = new Date(cycle.finished_at).getTime() - new Date(cycle.started_at).getTime();
  if (Number.isNaN(ms) || ms < 0) return '';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${faDigits(min)} دقیقه`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${faDigits(h)} ساعت` : `${faDigits(h)} ساعت و ${faDigits(m)} دقیقه`;
}

/* ------------------------------------------------------------------ */
/* نوع داده‌ها                                                         */
/* ------------------------------------------------------------------ */

/** قالب پنج‌محوری گزارش چرخه. */
interface AxisReport {
  goal: string; // هدف چه بود
  problem: string; // چه مشکلی بود
  plan: string; // قرار است چه شود
  outcome: string; // چه شد
  actions: string; // چه کاری انجام شد
  summary: string; // در کل چه شد؟
}

interface CycleReport extends Cycle {
  report: AxisReport;
  teams: TeamName[];
}

const TEAM_LABELS: Record<TeamName, string> = {
  leader: 'رهبر',
  artdir: 'طراحی ارشد',
  branding: 'برند',
  content: 'محتوا',
  seo: 'سئو',
  analytics: 'تحلیل',
  intel: 'اطلاعات',
  lead: 'لید',
  design: 'دیزاین',
  seocontent: 'محتوای سئو',
  vibefarsi: 'وایب‌فارسی',
  farsiui: 'فارسی UI',
  'design-ir': 'دیزاین ایرانی',
  dev: 'توسعه',
  qa: 'کیفیت',
  inspector: 'بازرس',
  'tour-manager': 'مدیر تور',
};

const ALL_TEAMS: TeamName[] = [
  'artdir',
  'branding',
  'content',
  'seo',
  'analytics',
  'intel',
  'lead',
  'design',
  'seocontent',
  'vibefarsi',
  'farsiui',
  'design-ir',
  'dev',
  'qa',
  'inspector',
  'tour-manager',
];

const AXIS_TITLES = [
  { key: 'goal', title: 'هدف چه بود' },
  { key: 'problem', title: 'چه مشکلی بود' },
  { key: 'plan', title: 'قرار است چه شود' },
  { key: 'outcome', title: 'چه شد' },
  { key: 'actions', title: 'چه کاری انجام شد' },
] as const;

async function fetchCycles(): Promise<{ cycles: CycleReport[] }> {
  const res = await fetch('/api/cycles', { cache: 'no-store' });
  if (!res.ok) throw new Error('bad status');
  const body = await res.json().catch(() => null);
  const list: Cycle[] | undefined = body?.ok ? body.data : Array.isArray(body) ? body : undefined;
  if (!Array.isArray(list)) throw new Error('bad shape');
  // فعلاً API گزارش پنج‌محوری ندارد؛ محورها خالی می‌مانند تا API تکمیل شود.
  const mapped: CycleReport[] = list
    .filter((c) => c.status === 'success')
    .map((c) => ({
      ...c,
      teams: ALL_TEAMS,
      report: { goal: '', problem: '', plan: '', outcome: '', actions: '', summary: '' },
    }));
  return { cycles: mapped };
}

/* ------------------------------------------------------------------ */
/* صفحه                                                                 */
/* ------------------------------------------------------------------ */

export default function ReportsPage() {
  const [reports, setReports] = useState<CycleReport[]>([]);
  /* قانون مسعود: دادهٔ نمایشی ممنوع؛ اگر API در دسترس نباشد صادقانه می‌گوییم */
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /* تلاش مجدد: با هر افزایش، افکت بالا دوباره اجرا می‌شود */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchCycles()
      .then(({ cycles }) => {
        if (!alive) return;
        const sorted = [...cycles].sort(
          (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
        );
        setReports(sorted);
        setSelectedId((prev) => prev ?? sorted[0]?.id ?? null);
        setFailed(false);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setFailed(true);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  const selected = useMemo(
    () => reports.find((r) => r.id === selectedId) ?? null,
    [reports, selectedId],
  );

  const reportEmpty = selected && AXIS_TITLES.every((a) => !selected.report[a.key].trim());

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
      {/* سربرگ صفحه */}
      <PageHeader
        icon={FileText}
        title="گزارش چرخه‌ها"
        subtitle="گزارش پنج‌محوری چرخه‌های موفق تیم‌های هوش مصنوعی تایلندگرد. برای خواندن گزارش، یک چرخه را از فهرست انتخاب کنید."
      />

      {loading ? (
        <LoadingState />
      ) : failed ? (
        <NotConnected
          onRetry={() => setAttempt((n) => n + 1)}
          retrying={false}
        />
      ) : reports.length === 0 ? (
        <ReportsEmptyState />
      ) : (
        <div className="flex flex-col gap-4 md:gap-6 lg:flex-row">
          {/* فهرست چرخه‌ها */}
          <aside aria-label="فهرست چرخه‌ها" className="lg:w-72 lg:shrink-0">
            <ul className="flex gap-3 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0">
              {reports.map((r) => {
                const active = r.id === selectedId;
                return (
                  <li key={r.id} className="w-60 shrink-0 sm:w-64 lg:w-auto">
                    {/* کارتِ قابل انتخاب؛ معادل رجیستری ندارد (Button برای کنش است نه کارتِ انتخاب).
                        فقط با توکن‌های تم. */}
                    <button
                      type="button"
                      onClick={() => setSelectedId(r.id)}
                      aria-current={active ? 'true' : undefined}
                      className={`min-h-20 w-full rounded-lg border p-4 text-start transition-colors ${
                        active
                          ? 'border-brand bg-card shadow-surface'
                          : 'border-border bg-card hover:border-muted-foreground'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold">چرخهٔ {r.run_id}</span>
                        <Badge variant="success">موفق</Badge>
                      </div>
                      <dl className="mt-3 space-y-1.5 text-sm text-muted-foreground">
                        <div className="flex justify-between gap-2">
                          <dt>تاریخ</dt>
                          <dd className="text-foreground">{jalaliDate(r.started_at)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt>مدت</dt>
                          <dd className="text-foreground">{durationFa(r)}</dd>
                        </div>
                        {typeof r.stats?.commits === 'number' && (
                          <div className="flex justify-between gap-2">
                            <dt>کامیت‌ها</dt>
                            <dd className="text-foreground">{faDigits(r.stats.commits)}</dd>
                          </div>
                        )}
                      </dl>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          {/* گزارش پنج‌محوری */}
          {selected && (
            <article
              key={selected.id}
              className="min-w-0 flex-1 rounded-xl border border-border bg-card p-4 shadow-surface sm:p-6 md:p-8"
              aria-label={`گزارش چرخهٔ ${selected.run_id}`}
            >
              {/* سربرگ گزارش: تیم، تاریخ شمسی، ساعت تهران */}
              <header className="border-b border-border pb-6">
                <h2 className="text-xl font-bold">گزارش چرخهٔ {selected.run_id}</h2>
                <div className="mt-4 grid gap-4 sm:grid-cols-3">
                  <div>
                    <p className="text-xs text-muted-foreground">تیم‌ها</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {selected.teams.map((t) => (
                        <Badge key={t} variant="secondary">
                          {TEAM_LABELS[t]}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">تاریخ شمسی</p>
                    <p className="mt-1 font-bold">{jalaliDate(selected.started_at)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">ساعت تهران</p>
                    <p className="mt-1 font-bold" dir="rtl">
                      {tehranTime(selected.started_at)} تا {selected.finished_at ? tehranTime(selected.finished_at) : 'در حال اجرا'}
                    </p>
                  </div>
                </div>
              </header>

              {reportEmpty ? (
                <p className="mt-6 rounded-lg bg-muted p-4 text-sm text-muted-foreground">
                  گزارش پنج‌محوری این چرخه هنوز ثبت نشده است.
                </p>
              ) : (
                <>
                  {/* پنج محور */}
                  <ol className="mt-6 space-y-4 md:space-y-5">
                    {AXIS_TITLES.map((axis, i) => (
                      <li
                        key={axis.key}
                        className="rounded-lg border border-border bg-background p-4 sm:p-5"
                      >
                        <div className="flex items-center gap-3">
                          <span
                            aria-hidden="true"
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand text-base font-bold text-brand-foreground"
                          >
                            {faDigits(i + 1)}
                          </span>
                          <h3 className="text-base font-bold sm:text-lg">{axis.title}</h3>
                        </div>
                        <p className="mt-3 leading-8 text-foreground">{selected.report[axis.key]}</p>
                      </li>
                    ))}
                  </ol>

                  {/* پاراگراف جمع‌بندی */}
                  <section
                    aria-label="در کل چه شد"
                    className="mt-6 rounded-lg border border-brand/40 bg-brand/5 p-4 sm:p-5"
                  >
                    <h3 className="text-lg font-bold text-brand">در کل چه شد؟</h3>
                    <p className="mt-3 leading-8 text-foreground">{selected.report.summary}</p>
                  </section>
                </>
              )}
            </article>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* حالت‌های بارگذاری و خالی                                            */
/* ------------------------------------------------------------------ */

function LoadingState() {
  return (
    <div className="tg-stagger flex flex-col gap-4 md:gap-6 lg:flex-row" aria-busy="true">
      <div className="flex flex-col gap-3 lg:w-72 lg:shrink-0">
        {[0, 1, 2].map((i) => (
          <SkeletonStat key={i} />
        ))}
      </div>
      <SkeletonPanel className="min-h-96" />
      <span className="sr-only">در حال بارگذاری گزارش‌ها…</span>
    </div>
  );
}

function ReportsEmptyState() {
  return (
    <EmptyState
      icon={FileX2}
      title="هنوز چرخهٔ موفقی ثبت نشده است"
      description="وقتی اولین چرخه با موفقیت تمام شود، گزارش پنج‌محوری آن همین‌جا نمایش داده می‌شود."
    />
  );
}
