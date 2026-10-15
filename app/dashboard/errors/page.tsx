'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  CircleAlert,
  History,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react';
import PageHeader from '../../../components/PageHeader';
import EmptyState from '../../../components/EmptyState';
import StatusBadge from '../../../components/dataviz/StatusBadge';
import { Button } from '../../../components/ui/Button';
import { Select } from '../../../components/ui/Select';
import { Skeleton } from '../../../components/Skeleton';
import { faNum } from '../../../lib/format';
import { TEAMS, type TeamName } from '../../../lib/types';
import { TEAM_META, teamFaName } from '../../../lib/teams-meta';

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

interface ErrorItem {
  id: string;
  cycle_id: string;
  team: TeamName;
  wave: number;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  run_id: string | null;
  retry_of?: string | null;
}

interface ErrorAlert {
  kind: 'consecutive_failures' | 'stuck';
  team: TeamName;
  detail: string;
  count: number;
  run_id: string;
  started_at: string | null;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean;
      data?: T;
    } | null;
    if (!json || json.ok === false) return null;
    return (json.data ?? null) as T | null;
  } catch {
    return null;
  }
}

const POLL_MS = 30000;

function SectionTitle({ icon: Icon, title, count }: { icon: typeof TriangleAlert; title: string; count?: number }) {
  return (
    <div className="mb-4 flex items-center gap-2.5">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
        <Icon size={18} strokeWidth={2} aria-hidden="true" />
      </span>
      <h2 className="text-base font-bold text-foreground sm:text-lg">{title}</h2>
      {typeof count === 'number' && count > 0 && (
        <span className="rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-bold text-destructive">
          {faNum(count)}
        </span>
      )}
    </div>
  );
}

export default function ErrorsPage() {
  const [current, setCurrent] = useState<ErrorItem[] | null>(null);
  const [alerts, setAlerts] = useState<ErrorAlert[] | null>(null);
  const [history, setHistory] = useState<ErrorItem[] | null>(null);
  const [teamFilter, setTeamFilter] = useState<'all' | TeamName>('all');
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryNote, setRetryNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const load = useCallback(async () => {
    const [c, a, h] = await Promise.all([
      getJson<ErrorItem[]>('/api/errors/current'),
      getJson<ErrorAlert[]>('/api/errors/alerts'),
      getJson<ErrorItem[]>(
        `/api/errors/history${teamFilter === 'all' ? '' : `?team=${teamFilter}`}`,
      ),
    ]);
    setCurrent(c ?? []);
    setAlerts(a ?? []);
    setHistory(h ?? []);
    setLastRefresh(new Date());
  }, [teamFilter]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await load();
      if (!alive) return;
    })();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [load]);

  async function handleRetry(runId: string) {
    setRetryingId(runId);
    setRetryNote(null);
    try {
      const res = await fetch('/api/errors/retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ run_id: runId }),
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (res.ok && json?.ok) {
        setRetryNote({ ok: true, text: 'تلاش مجدد شروع شد؛ نتیجه در همین صفحه به‌روز می‌شود.' });
      } else {
        setRetryNote({
          ok: false,
          text: json?.error?.message ?? 'تلاش مجدد ناموفق بود؛ دوباره امتحان کنید.',
        });
      }
    } catch {
      setRetryNote({ ok: false, text: 'خطای شبکه؛ دوباره امتحان کنید.' });
    } finally {
      setRetryingId(null);
      setTimeout(() => void load(), 1500);
    }
  }

  const loading = current === null || alerts === null || history === null;

  return (
    <div className="mx-auto max-w-7xl">
        <PageHeader
          icon={TriangleAlert}
          title="خطاهای زنده"
          subtitle="خطاهای واقعی ثبت‌شده در team_runs؛ بدون داده‌ی نمایشی"
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              aria-label="به‌روزرسانی"
            >
              <RefreshCw size={15} strokeWidth={2} aria-hidden="true" />
              به‌روزرسانی
            </Button>
          }
        />

        {retryNote && (
          <div
            role="status"
            className={`mb-6 flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm leading-7 ${
              retryNote.ok
                ? 'border-success/30 bg-success/10 text-success'
                : 'border-destructive/30 bg-destructive/10 text-destructive'
            }`}
          >
            {retryNote.ok ? (
              <CheckCircle2 size={18} strokeWidth={2} aria-hidden="true" className="mt-1 shrink-0" />
            ) : (
              <CircleAlert size={18} strokeWidth={2} aria-hidden="true" className="mt-1 shrink-0" />
            )}
            <span>{retryNote.text}</span>
          </div>
        )}

        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-44 rounded-xl" />
            ))}
          </div>
        ) : (
          <>
            {/* خطاهای جاری */}
            <section className="mb-10" aria-label="خطاهای جاری">
              <SectionTitle icon={TriangleAlert} title="خطاهای جاری" count={current!.length} />
              {current!.length === 0 ? (
                <EmptyState
                  icon={CheckCircle2}
                  title="خطایی ثبت نشده"
                  description="در حال حاضر هیچ تیمی ران ناموفق یا گیرکرده ندارد. این لیست فقط از داده‌ی واقعی team_runs ساخته می‌شود."
                  tint="bg-success/10 text-success"
                />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 md:gap-4 lg:grid-cols-3">
                  {current!.map((item) => {
                    const stuck = item.status === 'running';
                    return (
                      <article
                        key={item.id}
                        className="flex h-full min-w-0 flex-col rounded-xl border border-destructive/25 bg-card p-4 shadow-surface sm:p-5"
                      >
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h3 className="text-base font-bold text-card-foreground">
                              {teamFaName(item.team)}
                            </h3>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              موج {faNum(item.wave)}
                            </p>
                          </div>
                          <StatusBadge status={stuck ? 'running' : 'failed'} className="shrink-0" />
                        </div>

                        <div className="mt-3 flex-1">
                          {stuck ? (
                            <p className="text-sm leading-7 text-card-foreground/90">
                              بیش از دو ساعت در وضعیت «در حال اجرا» مانده و خروجی ثبت نشده؛
                              احتمالاً timeout یا گیرکردن فرایند.
                            </p>
                          ) : (
                            <p className="text-sm leading-7 text-card-foreground/90">
                              {item.error ?? 'پیام خطا ثبت نشده است.'}
                            </p>
                          )}
                          <p className="mt-2 text-xs leading-6 text-muted-foreground">
                            زمان شروع: {faDate(item.started_at)}
                          </p>
                        </div>

                        {!stuck && (
                          <div className="mt-4 border-t border-border pt-3">
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-full"
                              disabled={retryingId === item.id}
                              loading={retryingId === item.id}
                              onClick={() => void handleRetry(item.id)}
                            >
                              <RotateCcw size={15} strokeWidth={2} aria-hidden="true" />
                              تلاش مجدد
                            </Button>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>

            {/* هشدارها */}
            <section className="mb-10" aria-label="هشدارها">
              <SectionTitle icon={ShieldAlert} title="هشدارها" count={alerts!.length} />
              {alerts!.length === 0 ? (
                <EmptyState
                  icon={ShieldAlert}
                  title="هشداری نیست"
                  description="نه شکست پشت سر همی دیده می‌شود، نه رانی گیر کرده است."
                />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 md:gap-4">
                  {alerts!.map((alert) => (
                    <article
                      key={`${alert.kind}-${alert.team}`}
                      className="rounded-xl border border-warning/30 bg-card p-4 shadow-surface sm:p-5"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-bold text-card-foreground">
                            {alert.kind === 'consecutive_failures'
                              ? 'تلاش‌های ناموفق پشت سر هم'
                              : 'احتمال timeout'}
                            {'؛ '}
                            {teamFaName(alert.team)}
                          </h3>
                          <p className="mt-1.5 text-sm leading-7 text-muted-foreground">
                            {alert.detail}
                          </p>
                          <p className="mt-1 text-xs leading-6 text-muted-foreground">
                            آخرین رخداد: {faDate(alert.started_at)}
                          </p>
                        </div>
                        {alert.kind === 'consecutive_failures' && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            disabled={retryingId === alert.run_id}
                            loading={retryingId === alert.run_id}
                            onClick={() => void handleRetry(alert.run_id)}
                          >
                            <RotateCcw size={15} strokeWidth={2} aria-hidden="true" />
                            تلاش مجدد
                          </Button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            {/* تاریخچه خطاهای امروز */}
            <section aria-label="تاریخچه خطاهای امروز">
              <SectionTitle icon={History} title="تاریخچه خطاهای امروز" count={history!.length} />
              <div className="mb-4 max-w-xs">
                <Select
                  label="فیلتر تیم"
                  value={teamFilter}
                  onChange={(e) => setTeamFilter(e.target.value as 'all' | TeamName)}
                >
                  <option value="all">همه تیم‌ها</option>
                  {TEAMS.map((team) => (
                    <option key={team} value={team}>
                      {TEAM_META[team].faName}
                    </option>
                  ))}
                </Select>
              </div>
              {history!.length === 0 ? (
                <EmptyState
                  icon={History}
                  title="امروز خطایی ثبت نشده است"
                  description={
                    teamFilter === 'all'
                      ? 'از ابتدای امروز (به وقت تهران) هیچ ران ناموفقی در team_runs ثبت نشده.'
                      : `از ابتدای امروز هیچ ران ناموفقی برای تیم «${teamFaName(teamFilter as TeamName)}» ثبت نشده.`
                  }
                />
              ) : (
                <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-surface">
                  {history!.map((item) => (
                    <li key={item.id} className="flex items-start justify-between gap-3 p-4 sm:px-5">
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-card-foreground">
                          {teamFaName(item.team)}
                          <span className="ms-2 text-xs font-normal text-muted-foreground">
                            موج {faNum(item.wave)}
                          </span>
                        </p>
                        <p className="mt-1 line-clamp-2 text-sm leading-7 text-muted-foreground">
                          {item.error ?? 'پیام خطا ثبت نشده است.'}
                        </p>
                        <p className="mt-1 text-xs leading-6 text-muted-foreground">
                          {faDate(item.started_at)}
                          {item.retry_of ? '؛ تلاش مجدد یک خطای قبلی' : ''}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        disabled={retryingId === item.id}
                        loading={retryingId === item.id}
                        onClick={() => void handleRetry(item.id)}
                        aria-label={`تلاش مجدد تیم ${teamFaName(item.team)}`}
                      >
                        <RotateCcw size={15} strokeWidth={2} aria-hidden="true" />
                        <span className="hidden sm:inline">تلاش مجدد</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {lastRefresh && (
              <p className="mt-8 text-center text-xs text-muted-foreground">
                آخرین به‌روزرسانی: {faDate(lastRefresh.toISOString())}؛ هر ۳۰ ثانیه خودکار به‌روز می‌شود.
              </p>
            )}
          </>
        )}
    </div>
  );
}
