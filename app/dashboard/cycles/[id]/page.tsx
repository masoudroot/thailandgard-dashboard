'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowRight,
  CalendarDays,
  Clock3,
  Cpu,
  KeyRound,
  Pause,
  Play,
  SearchX,
  Users,
  XCircle,
} from 'lucide-react';
import type { Cycle, TeamName, TeamRun } from '@/lib/types';
import { normalizeCycleStatus } from '@/lib/types';
import EmptyState from '@/components/EmptyState';
import NotConnected from '@/components/NotConnected';
import StatusBadge from '@/components/dataviz/StatusBadge';
import ProgressBar from '@/components/dataviz/ProgressBar';
import { SkeletonPanel } from '@/components/Skeleton';
import { faNum } from '@/lib/format';

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

/** باز کردن پوشش API: { ok, data } یا دادهٔ خام */
function unwrapPayload(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    return (body as { data: unknown }).data;
  }
  return body;
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

type LoadState = 'loading' | 'ready' | 'not-connected' | 'unauthorized';
type CycleAction = 'pause' | 'resume' | 'cancel';

export default function CycleDetailPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id as string);

  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [teamRuns, setTeamRuns] = useState<TeamRun[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [acting, setActing] = useState<CycleAction | null>(null);
  const [actionError, setActionError] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/cycles/${id}`, { cache: 'no-store' });
      if (res.status === 401) {
        setLoadState('unauthorized');
        return;
      }
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = await res.json();
      const payload = unwrapPayload(body) as {
        cycle?: Cycle;
        team_runs?: TeamRun[];
      };
      setCycle(payload.cycle ?? null);
      setTeamRuns(payload.team_runs ?? []);
      setLoadState('ready');
    } catch {
      // قانون مسعود: به‌جای دادهٔ نمونه، صادقانه «متصل نیست» نمایش بده.
      setCycle(null);
      setTeamRuns([]);
      setLoadState('not-connected');
    } finally {
      setLastRefresh(new Date());
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const status = cycle ? normalizeCycleStatus(cycle.status) : null;
  const isRunning = status === 'running';
  const isPausing = status === 'pausing';
  const isPaused = status === 'paused';
  const isActive = isRunning || isPausing || isPaused;

  useEffect(() => {
    if (!(isRunning || isPausing)) return;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [isRunning, isPausing, load]);

  async function sendAction(action: CycleAction) {
    setActing(action);
    setActionError('');
    setConfirmCancel(false);
    try {
      const res = await fetch(`/api/cycles/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const payload = unwrapPayload(body) as { error?: { message?: string } };
        throw new Error(payload.error?.message ?? `خطا با کد ${res.status}`);
      }
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'انجام عمل ناموفق بود.');
    } finally {
      setActing(null);
    }
  }

  const waves = Array.from(new Set(teamRuns.map((r) => r.wave))).sort(
    (a, b) => a - b,
  );
  const totalLlmCalls = teamRuns.reduce((sum, r) => sum + (r.llm_calls ?? 0), 0);
  const failedRuns = teamRuns.filter((r) => r.status === 'failed');

  const pauseHint = isRunning
    ? 'توقف نرم: موج جاری تا انتها اجرا می‌شود و موج بعدی شروع نمی‌شود'
    : undefined;

  return (
    <div className="mx-auto max-w-6xl">
        <Link
          href="/dashboard/cycles"
          className="tg-link mb-6 inline-flex min-h-[44px] items-center gap-2 text-sm text-muted-foreground hover:text-brand"
        >
          <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
          بازگشت به لیست چرخه‌ها
        </Link>

        {loadState === 'loading' ? (
          <SkeletonPanel />
        ) : loadState === 'not-connected' ? (
          <NotConnected onRetry={load} retrying={false} />
        ) : loadState === 'unauthorized' ? (
          <EmptyState
            icon={KeyRound}
            title="نشست شما منقضی شده است"
            description="برای دیدن جزئیات چرخه دوباره وارد شوید."
            action={
              <Link
                href="/login"
                className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-primary px-6 py-2 text-sm font-bold text-primary-foreground shadow-control hover:opacity-90"
              >
                ورود دوباره
              </Link>
            }
          />
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
            <section className="mb-6 rounded-xl border border-border bg-card p-4 shadow-surface sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-xs text-muted-foreground">شناسه اجرا</p>
                  <h1 className="mt-1 font-mono text-lg font-bold" dir="ltr">
                    {cycle.run_id}
                  </h1>
                  <p className="mt-1 text-xs text-muted-foreground">{cycle.id}</p>
                </div>
                <StatusBadge status={status ?? 'pending'} />
              </div>

              {/* دکمه‌های کنترل واقعی چرخه */}
              {isActive && (
                <div className="mt-5 flex flex-wrap items-center gap-2.5 border-t border-border pt-5">
                  <button
                    onClick={() => sendAction('pause')}
                    disabled={!isRunning || acting !== null}
                    title={pauseHint}
                    className="tg-btn inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-5 py-2 text-sm font-medium text-warning transition-colors hover:bg-warning/20 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Pause size={16} strokeWidth={2} aria-hidden="true" />
                    {acting === 'pause' ? 'در حال توقف…' : 'توقف چرخه'}
                  </button>
                  <button
                    onClick={() => sendAction('resume')}
                    disabled={!isPaused || acting !== null}
                    title="ادامه از همان موجی که متوقف شده است"
                    className="tg-btn inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2 text-sm font-medium text-primary-foreground shadow-control hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Play size={16} strokeWidth={2} aria-hidden="true" />
                    {acting === 'resume' ? 'در حال ادامه…' : 'ادامه'}
                  </button>
                  {confirmCancel ? (
                    <>
                      <button
                        onClick={() => sendAction('cancel')}
                        disabled={acting !== null}
                        className="tg-btn inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-destructive px-5 py-2 text-sm font-bold text-destructive-foreground shadow-control hover:opacity-90 disabled:opacity-40"
                      >
                        <XCircle size={16} strokeWidth={2} aria-hidden="true" />
                        {acting === 'cancel' ? 'در حال لغو…' : 'بله، لغو شود'}
                      </button>
                      <button
                        onClick={() => setConfirmCancel(false)}
                        disabled={acting !== null}
                        className="tg-btn inline-flex min-h-[44px] items-center justify-center rounded-xl border border-border px-5 py-2 text-sm font-medium text-card-foreground hover:bg-muted disabled:opacity-40"
                      >
                        انصراف
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmCancel(true)}
                      disabled={!isActive || acting !== null}
                      title="لغو چرخه؛ دیگر ادامه نمی‌یابد"
                      className="tg-btn inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-5 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <XCircle size={16} strokeWidth={2} aria-hidden="true" />
                      لغو چرخه
                    </button>
                  )}
                </div>
              )}

              {actionError && (
                <p
                  role="alert"
                  className="tg-shake mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive"
                >
                  {actionError}
                </p>
              )}

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
                {isRunning
                  ? 'این چرخه در حال اجراست؛ هر ۱۰ ثانیه خودکار به‌روزرسانی می‌شود.'
                  : isPausing
                    ? 'درخواست توقف ثبت شد؛ موج جاری تا انتها اجرا می‌شود و بعد چرخه متوقف می‌ماند.'
                    : isPaused
                      ? 'این چرخه متوقف شده است؛ با «ادامه» از همان نقطه ادامه می‌یابد.'
                      : 'این چرخه به پایان رسیده است.'}
                {lastRefresh &&
                  ` آخرین به‌روزرسانی: ${new Intl.DateTimeFormat('fa-IR', { timeStyle: 'medium' }).format(lastRefresh)}`}
              </p>
            </section>

            {failedRuns.length > 0 && (
              <section className="mb-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4 sm:p-6">
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
                    className="overflow-hidden rounded-xl border border-border bg-card shadow-surface"
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
  );
}
