'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowRight,
  CalendarDays,
  Clock3,
  Cpu,
  SearchX,
  Users,
} from 'lucide-react';
import type { Cycle, TeamName, TeamRun } from '@/lib/types';
import EmptyState from '@/components/EmptyState';
import StatusBadge from '@/components/dataviz/StatusBadge';
import ProgressBar from '@/components/dataviz/ProgressBar';

/** تبدیل ارقام لاتین به فارسی */
function faNum(v: string | number): string {
  return String(v).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
}

/** تاریخ و ساعت شمسی با ارقام فارسی */
function faDate(iso: string | null): string {
  if (!iso) return 'نامشخص';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'نامشخص';
  return new Intl.DateTimeFormat('fa-IR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d);
}

/** مدت‌زمان اجرا به شکل «۲۳ دقیقه و ۱۰ ثانیه» */
function faDuration(start: string | null, end: string | null): string {
  if (!start) return 'نامشخص';
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return 'نامشخص';
  const total = Math.floor((e - s) / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  if (m === 0) return `${faNum(sec)} ثانیه`;
  return `${faNum(m)} دقیقه و ${faNum(sec)} ثانیه`;
}

const TEAM_LABEL: Record<TeamName, string> = {
  artdir: 'کارگردانی هنری',
  branding: 'برندینگ',
  content: 'محتوا',
  seo: 'سئو',
  analytics: 'تحلیل',
  intel: 'اطلاعات بازار',
  lead: 'سرپرست',
  design: 'دیزاین',
  seocontent: 'محتوای سئو',
  vibefarsi: 'وایب‌فارسی',
  farsiui: 'رابط فارسی',
  'design-ir': 'دیزاین ایران',
  dev: 'توسعه',
  qa: 'تضمین کیفیت',
  inspector: 'بازرس',
};

const MOCK_CYCLE: Cycle = {
  id: 'cyc-2026-10-14-01',
  run_id: 'run_9f31ab',
  status: 'running',
  started_at: '2026-10-14T14:02:11+03:30',
  finished_at: null,
  stats: null,
};

const MOCK_TEAM_RUNS: TeamRun[] = [
  { id: 'tr-1', cycle_id: 'cyc-2026-10-14-01', team: 'artdir', wave: 1, status: 'success', started_at: '2026-10-14T14:02:12+03:30', finished_at: '2026-10-14T14:20:45+03:30', output_summary: 'ری‌برند بصری هیرو تأیید شد؛ ۳ نسخه موکاپ تحویل داده شد.', llm_calls: 12, error: null },
  { id: 'tr-2', cycle_id: 'cyc-2026-10-14-01', team: 'branding', wave: 1, status: 'success', started_at: '2026-10-14T14:02:12+03:30', finished_at: '2026-10-14T14:18:03+03:30', output_summary: 'پیام اصلی برند یکدست شد؛ شعار نهایی «ریشه را می‌جویم».', llm_calls: 9, error: null },
  { id: 'tr-3', cycle_id: 'cyc-2026-10-14-01', team: 'content', wave: 1, status: 'success', started_at: '2026-10-14T14:02:13+03:30', finished_at: '2026-10-14T14:31:57+03:30', output_summary: '۵ پیش‌نویس مقاله آماده بازبینی؛ ۲ مورد نیاز به اصلاح لحن دارند.', llm_calls: 21, error: null },
  { id: 'tr-4', cycle_id: 'cyc-2026-10-14-01', team: 'analytics', wave: 2, status: 'success', started_at: '2026-10-14T14:32:10+03:30', finished_at: '2026-10-14T14:55:41+03:30', output_summary: 'نرخ تبدیل هفته ۲.۴٪؛ ریزش اصلی در صفحه پرداخت شناسایی شد.', llm_calls: 7, error: null },
  { id: 'tr-5', cycle_id: 'cyc-2026-10-14-01', team: 'intel', wave: 2, status: 'failed', started_at: '2026-10-14T14:32:10+03:30', finished_at: '2026-10-14T14:36:02+03:30', output_summary: null, llm_calls: 3, error: 'اتصال به منبع داده بیرونی قطع شد (timeout پس از ۳۰ ثانیه).' },
  { id: 'tr-6', cycle_id: 'cyc-2026-10-14-01', team: 'lead', wave: 2, status: 'running', started_at: '2026-10-14T14:56:00+03:30', finished_at: null, output_summary: null, llm_calls: 5, error: null },
  { id: 'tr-7', cycle_id: 'cyc-2026-10-14-01', team: 'design', wave: 3, status: 'pending', started_at: null, finished_at: null, output_summary: null, llm_calls: 0, error: null },
  { id: 'tr-8', cycle_id: 'cyc-2026-10-14-01', team: 'seo', wave: 3, status: 'pending', started_at: null, finished_at: null, output_summary: null, llm_calls: 0, error: null },
  { id: 'tr-9', cycle_id: 'cyc-2026-10-14-01', team: 'seocontent', wave: 3, status: 'pending', started_at: null, finished_at: null, output_summary: null, llm_calls: 0, error: null },
];

export default function CycleDetailPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id as string);

  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [teamRuns, setTeamRuns] = useState<TeamRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [usingMock, setUsingMock] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/cycles/${id}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      setCycle(data.cycle ?? data);
      setTeamRuns(data.team_runs ?? data.teamRuns ?? []);
      setUsingMock(false);
    } catch {
      setCycle(MOCK_CYCLE);
      setTeamRuns(MOCK_TEAM_RUNS);
      setUsingMock(true);
    } finally {
      setLoading(false);
      setLastRefresh(new Date());
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const running = cycle?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [running, load]);

  const waves = Array.from(new Set(teamRuns.map((r) => r.wave))).sort(
    (a, b) => a - b,
  );
  const totalLlmCalls = teamRuns.reduce((sum, r) => sum + (r.llm_calls ?? 0), 0);
  const failedRuns = teamRuns.filter((r) => r.status === 'failed');

  return (
    <main dir="rtl" className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-4 py-6 md:py-8">
        <Link
          href="/dashboard/cycles"
          className="mb-6 inline-flex min-h-[44px] items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-brand"
        >
          <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
          بازگشت به لیست چرخه‌ها
        </Link>

        {loading ? (
          <div className="rounded-2xl border border-border bg-card p-10 text-center text-sm text-muted-foreground shadow-surface">
            در حال بارگذاری جزئیات چرخه…
          </div>
        ) : !cycle ? (
          <EmptyState
            icon={SearchX}
            title="چرخه‌ای با این شناسه پیدا نشد"
            description="شاید شناسه اشتباه است یا چرخه حذف شده است؛ به لیست چرخه‌ها برگردید."
            action={
              <Link
                href="/dashboard/cycles"
                className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-border bg-card px-5 py-2 text-sm font-medium text-card-foreground shadow-control transition-colors hover:bg-accent"
              >
                بازگشت به لیست چرخه‌ها
              </Link>
            }
          />
        ) : (
          <>
            {usingMock && (
              <p className="mb-4 rounded-lg border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm text-warning">
                اتصال به API برقرار نشد؛ داده نمونه نمایش داده می‌شود.
              </p>
            )}

            <section className="mb-6 rounded-2xl border border-border bg-card p-4 shadow-surface sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-xs text-muted-foreground">شناسه اجرا</p>
                  <h1 className="mt-1 font-mono text-lg font-bold" dir="ltr">
                    {cycle.run_id}
                  </h1>
                  <p className="mt-1 text-xs text-muted-foreground">{cycle.id}</p>
                </div>
                <StatusBadge status={cycle.status} />
              </div>

              <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4 md:gap-4">
                <div className="rounded-xl bg-muted/50 p-4">
                  <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CalendarDays size={14} strokeWidth={1.75} aria-hidden="true" />
                    شروع
                  </dt>
                  <dd className="mt-1.5 text-sm font-medium">{faDate(cycle.started_at)}</dd>
                </div>
                <div className="rounded-xl bg-muted/50 p-4">
                  <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock3 size={14} strokeWidth={1.75} aria-hidden="true" />
                    پایان
                  </dt>
                  <dd className="mt-1.5 text-sm font-medium">{faDate(cycle.finished_at)}</dd>
                </div>
                <div className="rounded-xl bg-muted/50 p-4">
                  <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Users size={14} strokeWidth={1.75} aria-hidden="true" />
                    تعداد تیم‌ها
                  </dt>
                  <dd className="mt-1.5 text-sm font-medium">{faNum(teamRuns.length)}</dd>
                </div>
                <div className="rounded-xl bg-muted/50 p-4">
                  <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Cpu size={14} strokeWidth={1.75} aria-hidden="true" />
                    فراخوانی LLM
                  </dt>
                  <dd className="mt-1.5 text-sm font-medium">{faNum(totalLlmCalls)}</dd>
                </div>
              </dl>

              <p className="mt-4 text-xs text-muted-foreground">
                {running
                  ? 'این چرخه در حال اجراست؛ هر ۱۰ ثانیه خودکار به‌روزرسانی می‌شود.'
                  : 'این چرخه به پایان رسیده است.'}
                {lastRefresh &&
                  ` آخرین به‌روزرسانی: ${new Intl.DateTimeFormat('fa-IR', { timeStyle: 'medium' }).format(lastRefresh)}`}
              </p>
            </section>

            {failedRuns.length > 0 && (
              <section className="mb-6 rounded-2xl border border-destructive/30 bg-destructive/5 p-4 sm:p-6">
                <h2 className="mb-3 text-sm font-bold text-destructive">
                  خطاها ({faNum(failedRuns.length)})
                </h2>
                <ul className="space-y-2">
                  {failedRuns.map((r) => (
                    <li key={r.id} className="text-sm">
                      <span className="font-medium text-card-foreground">
                        {TEAM_LABEL[r.team] ?? r.team}:
                      </span>{' '}
                      <span className="text-destructive">{r.error ?? 'خطای نامشخص'}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="space-y-4 md:space-y-6">
              {waves.map((wave) => {
                const waveRuns = teamRuns.filter((r) => r.wave === wave);
                const doneRuns = waveRuns.filter(
                  (r) => r.status === 'success' || r.status === 'failed',
                );
                const wavePct =
                  waveRuns.length > 0
                    ? (doneRuns.length / waveRuns.length) * 100
                    : 0;
                return (
                  <section
                    key={wave}
                    className="overflow-hidden rounded-2xl border border-border bg-card shadow-surface"
                  >
                    <header className="border-b border-border bg-muted/40 px-4 py-3 sm:px-5">
                      <h2 className="text-sm font-bold">موج {faNum(wave)}</h2>
                      <ProgressBar value={wavePct} className="mt-2" />
                    </header>
                    <ul className="divide-y divide-border">
                      {waveRuns.map((r) => (
                        <li key={r.id} className="px-4 py-4 sm:px-5">
                          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3">
                            <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
                              <span className="text-sm font-bold text-card-foreground">
                                {TEAM_LABEL[r.team] ?? r.team}
                              </span>
                              <StatusBadge status={r.status} />
                            </div>
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                              <span>فراخوانی LLM: {faNum(r.llm_calls ?? 0)}</span>
                              <span>مدت: {faDuration(r.started_at, r.finished_at)}</span>
                            </div>
                          </div>
                          {r.output_summary && (
                            <p className="mt-2 line-clamp-4 text-sm leading-7 text-card-foreground/80 sm:line-clamp-none">
                              {r.output_summary}
                            </p>
                          )}
                          {r.error && (
                            <p className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                              {r.error}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
