'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Activity, Pause, Play, Square, WifiOff, MoonStar } from 'lucide-react';
import PageHeader from '../../../components/PageHeader';
import { EmptyState } from '../../../components/ui/empty-state';
import StatusBadge from '../../../components/dataviz/StatusBadge';
import { SkeletonTeamCard } from '../../../components/Skeleton';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Card } from '../../../components/ui/Card';
import { Collapsible } from '../../../components/ui/collapsible';
import { TEAMS, type Cycle, type Subagent, type TeamName, type TeamRun } from '../../../lib/types';
import { faNum } from '../../../lib/format';
import { TEAM_META, WAVE_TITLES } from '../../../lib/team-meta';

const jalaliDate = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** «X ثانیه/دقیقه/ساعت پیش» از روی ISO. */
function relativeFa(iso: string | null | undefined): string {
  if (!iso) return 'نامشخص';
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${faNum(sec)} ثانیه پیش`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${faNum(min)} دقیقه پیش`;
  return `${faNum(Math.round(min / 60))} ساعت پیش`;
}

interface LiveData {
  cycle: Cycle | null;
  runs: TeamRun[];
  subagents: Subagent[];
  /** ستون‌های زنده‌ی team_runs واقعاً خوانده شدند؟ (مایگریشن اجرا شده؟) */
  liveColumns: boolean;
  /** جدول subagents وجود دارد؟ */
  subagentsReady: boolean;
}

type ConnState = 'loading' | 'live' | 'offline' | 'idle';

const SUBAGENT_STATUS_LABEL: Record<Subagent['status'], string> = {
  pending: 'در انتظار',
  running: 'در حال اجرا',
  paused: 'متوقف‌شده',
  stopped: 'متوقف شد',
  success: 'موفق',
  failed: 'ناموفق',
};

/** دکمه‌ی کنترل ساب‌ایجنت. */
function ControlButton({
  subagentId,
  action,
  label,
  icon: Icon,
  onDone,
}: {
  subagentId: string;
  action: 'pause' | 'resume' | 'stop';
  label: string;
  icon: typeof Pause;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    if (action === 'stop' && !window.confirm('ساب‌ایجنت کاملاً متوقف شود؟ مرحله‌ی جاری تمام می‌شود و بقیه اجرا نمی‌شوند.')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/subagents/${subagentId}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.ok === false) {
        setError(json?.error?.message ?? 'انجام نشد؛ دوباره تلاش کنید.');
      } else {
        onDone();
      }
    } catch {
      setError('اتصال برقرار نشد.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant={action === 'stop' ? 'destructive' : 'outline'}
        size="sm"
        onClick={run}
        disabled={busy}
        aria-busy={busy || undefined}
      >
        <Icon size={14} strokeWidth={2} aria-hidden="true" />
        {busy ? '…' : label}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}

/** کارت یک تیم: وضعیت، کار جاری، پیشرفت، آخرین به‌روزرسانی + ساب‌ایجنت‌ها. */
function LiveTeamCard({
  team,
  run,
  subagents,
  subagentsReady,
  liveColumns,
  refresh,
}: {
  team: TeamName;
  run: TeamRun | undefined;
  subagents: Subagent[];
  subagentsReady: boolean;
  liveColumns: boolean;
  refresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const meta = TEAM_META[team];

  const working = run?.status === 'running';
  const pill = !run ? (
    <Badge variant="secondary">منتظر نوبت</Badge>
  ) : working ? (
    <StatusBadge status="running" label="در حال کار" />
  ) : (
    <Badge variant="secondary">بیکار</Badge>
  );

  const outcome =
    run && !working && run.status === 'success'
      ? 'آخرین اجرا موفق بود.'
      : run && !working && run.status === 'failed'
        ? 'آخرین اجرا ناموفق بود.'
        : run && !working && run.status === 'stopped'
          ? 'آخرین اجرا توسط کاربر متوقف شد.'
          : null;

  const pct = Math.max(0, Math.min(100, Math.round(run?.progress ?? 0)));

  return (
    <article className="flex h-full min-w-0 flex-col rounded-xl border border-border bg-card p-4 shadow-surface sm:p-5">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-bold text-card-foreground">{meta.faName}</h3>
            <Link
              href={`/dashboard/teams/${team}`}
              className="text-xs font-medium text-brand hover:underline"
            >
              گزارش‌ها
            </Link>
          </div>
          <p className="mt-1 text-xs leading-6 text-muted-foreground">{meta.mission}</p>
        </div>
        <div className="shrink-0">{pill}</div>
      </div>

      <div className="mt-4 flex-1 space-y-3">
        <div>
          <p className="text-xs text-muted-foreground">کار جاری</p>
          <p className="mt-0.5 line-clamp-2 text-sm font-medium leading-7 text-card-foreground">
            {!liveColumns && run
              ? 'اطلاعات زنده هنوز فعال نیست.'
              : (run?.current_task ?? (run ? '…' : 'هنوز نوبتش نرسیده است.'))}
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>پیشرفت</span>
            {liveColumns ? (
              <span className="font-bold text-card-foreground">{faNum(pct)}٪</span>
            ) : (
              <span className="text-muted-foreground">هنوز فعال نیست</span>
            )}
          </div>
          {liveColumns ? (
            <div
              className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`پیشرفت تیم ${meta.faName}`}
            >
              <div
                className={`h-full rounded-full transition-all duration-500 ${working ? 'bg-warning' : 'bg-brand'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          ) : (
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
              ستون‌های زنده هنوز به پایگاه داده اضافه نشده‌اند.
            </p>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          آخرین به‌روزرسانی: <span className="font-medium text-card-foreground">{relativeFa(run?.updated_at)}</span>
          {outcome && <span> · {outcome}</span>}
        </p>
      </div>

      <div className="mt-4 border-t border-border pt-3">
        <Collapsible
          open={open}
          onOpenChange={setOpen}
          trigger={
            <span>
              ساب‌ایجنت‌ها{' '}
              <span className="text-xs font-normal text-muted-foreground">({faNum(subagents.length)})</span>
            </span>
          }
        >
          <div className="space-y-2">
            {!subagentsReady ? (
              <p className="text-xs leading-6 text-muted-foreground">
                جدول ساب‌ایجنت‌ها هنوز در پایگاه داده ساخته نشده است؛ کنترل زنده بعد
                از اجرای مایگریشن فعال می‌شود.
              </p>
            ) : subagents.length === 0 ? (
              <p className="text-xs leading-6 text-muted-foreground">
                {working
                  ? 'هنوز مرحله‌ای گزارش نشده است.'
                  : 'برای این اجرا ساب‌ایجنتی ثبت نشده است.'}
              </p>
            ) : (
              subagents.map((s) => {
                const canPause = s.status === 'running' && s.control === 'run';
                const canResume = s.control === 'pause' || s.status === 'paused';
                const canStop = ['running', 'paused', 'pending'].includes(s.status);
                return (
                  <div
                    key={s.id}
                    className="rounded-lg border border-border bg-muted/40 p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 text-sm font-medium leading-6 text-card-foreground">
                        {s.label}
                      </p>
                      <Badge variant="secondary" className="shrink-0">
                        {SUBAGENT_STATUS_LABEL[s.status]}
                      </Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {canPause && (
                        <ControlButton
                          subagentId={s.id}
                          action="pause"
                          label="توقف موقت"
                          icon={Pause}
                          onDone={refresh}
                        />
                      )}
                      {canResume && (
                        <ControlButton
                          subagentId={s.id}
                          action="resume"
                          label="ادامه"
                          icon={Play}
                          onDone={refresh}
                        />
                      )}
                      {canStop && (
                        <ControlButton
                          subagentId={s.id}
                          action="stop"
                          label="توقف کامل"
                          icon={Square}
                          onDone={refresh}
                        />
                      )}
                      {!canPause && !canResume && !canStop && (
                        <span className="text-xs text-muted-foreground">قابل کنترل نیست (تمام شده).</span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            <p className="text-xs leading-5 text-muted-foreground">
              کنترل از مرز مرحله‌ی بعدی اعمال می‌شود؛ روی مرحله‌ای که هم‌اکنون در حال اجراست اثر فوری ندارد.
            </p>
          </div>
        </Collapsible>
      </div>
    </article>
  );
}

export default function LivePage() {
  const [state, setState] = useState<ConnState>('loading');
  const [data, setData] = useState<LiveData>({
    cycle: null,
    runs: [],
    subagents: [],
    liveColumns: true,
    subagentsReady: true,
  });
  const [errorMsg, setErrorMsg] = useState<string>('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLive = useCallback(async () => {
    try {
      const res = await fetch('/api/live', { cache: 'no-store' });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.ok === false) {
        const msg = json?.error?.message ?? 'خواندن وضعیت زنده انجام نشد؛ دوباره تلاش کنید.';
        setErrorMsg(typeof msg === 'string' ? msg : 'خواندن وضعیت زنده انجام نشد؛ دوباره تلاش کنید.');
        // خطای ۵۰۳ یعنی دیتابیس در دسترس نیست؛ بقیه‌ی خطاها فقط همین دور را از دست می‌دهند.
        if (res.status === 503) setState('offline');
        return;
      }
      const payload = (json?.data ?? {}) as Partial<LiveData>;
      const cycle = payload.cycle ?? null;
      setData({
        cycle,
        runs: Array.isArray(payload.runs) ? payload.runs : [],
        subagents: Array.isArray(payload.subagents) ? payload.subagents : [],
        liveColumns: payload.liveColumns !== false,
        subagentsReady: payload.subagentsReady !== false,
      });
      setState(cycle ? 'live' : 'idle');
    } catch {
      setErrorMsg('اتصال به سرور برقرار نشد.');
      setState('offline');
    }
  }, []);

  useEffect(() => {
    void fetchLive();
    timer.current = setInterval(() => void fetchLive(), 5000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [fetchLive]);

  const byTeam = new Map<TeamName, TeamRun>(data.runs.map((r) => [r.team as TeamName, r]));
  const subsByRun = new Map<string, Subagent[]>();
  for (const s of data.subagents) {
    const list = subsByRun.get(s.team_run_id) ?? [];
    list.push(s);
    subsByRun.set(s.team_run_id, list);
  }

  const running = data.runs.filter((r) => r.status === 'running').length;
  const idle = data.runs.filter((r) => r.status !== 'running').length;
  const waiting = TEAMS.length - data.runs.length;

  return (
    <div className="mx-auto max-w-7xl">
        <PageHeader
          icon={Activity}
          title="فعالیت زنده"
          subtitle="وضعیت لحظه‌ای ۱۵ تیم و ساب‌ایجنت‌ها؛ هر ۵ ثانیه به‌روز می‌شود"
        />

        {state === 'loading' && (
          <div className="tg-stagger grid gap-4 sm:grid-cols-2 md:gap-5 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonTeamCard key={i} />
            ))}
          </div>
        )}

        {state === 'offline' && (
          <EmptyState
            icon={WifiOff}
            title="به پایگاه داده متصل نیست"
            description={
              errorMsg ||
              'صفحه نتوانست به پایگاه داده وصل شود. اتصال را در بخش تنظیمات بررسی کنید، بعد صفحه را تازه کنید.'
            }
            action={
              <Button
                variant="default"
                onClick={() => {
                  setState('loading');
                  void fetchLive();
                }}
              >
                تلاش دوباره
              </Button>
            }
          />
        )}

        {state === 'idle' && (
          <EmptyState
            icon={MoonStar}
            title="در حال حاضر چرخه‌ای در حال اجرا نیست"
            description="وقتی چرخه‌ای شروع شود، وضعیت زنده‌ی هر ۱۵ تیم و ساب‌ایجنت‌هایشان همین‌جا دیده می‌شود. هیچ دادهٔ نمایشی نشان داده نمی‌شود."
            action={
              <Link
                href="/dashboard/cycles"
                className="inline-flex min-h-11 items-center justify-center rounded-xl bg-primary px-5 py-2 text-sm font-medium text-primary-foreground shadow-control transition-colors hover:opacity-90"
              >
                رفتن به چرخه‌ها
              </Link>
            }
          />
        )}

        {state === 'live' && data.cycle && (
          <>
            {!data.liveColumns && (
              <section className="mb-6 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm leading-7 text-card-foreground">
                پیشرفت و کار جاری زنده هنوز فعال نیست؛ فایل{' '}
                <code className="break-all font-mono text-xs" dir="ltr">
                  supabase/migrations/20261015074440_team_runs_live.sql
                </code>{' '}
                را در SQL Editor سوپابیس اجرا کنید. تا آن موقع، وضعیت تیم‌ها از
                ستون‌های پایه خوانده می‌شود.
              </section>
            )}
            <Card className="mb-8 p-4 shadow-surface sm:p-6">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <span className="inline-flex items-center gap-2 text-sm font-bold text-card-foreground">
                  <span className="relative flex h-2.5 w-2.5" aria-hidden="true">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-success" />
                  </span>
                  چرخهٔ فعال
                </span>
                <span className="font-mono text-xs text-muted-foreground" dir="ltr">
                  {data.cycle.run_id}
                </span>
                <span className="text-xs text-muted-foreground">
                  شروع: {jalaliDate.format(new Date(data.cycle.started_at))}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Badge variant="secondary">
                  در حال کار: <strong>{faNum(running)}</strong>
                </Badge>
                <Badge variant="secondary">
                  بیکار: <strong>{faNum(idle)}</strong>
                </Badge>
                <Badge variant="secondary">
                  منتظر نوبت: <strong>{faNum(waiting)}</strong>
                </Badge>
              </div>
            </Card>

            <div className="tg-stagger grid gap-4 sm:grid-cols-2 md:gap-5 lg:grid-cols-3">
              {TEAMS.map((team) => {
                const run = byTeam.get(team);
                return (
                  <LiveTeamCard
                    key={team}
                    team={team}
                    run={run}
                    subagents={run ? (subsByRun.get(run.id) ?? []) : []}
                    subagentsReady={data.subagentsReady}
                    liveColumns={data.liveColumns}
                    refresh={fetchLive}
                  />
                );
              })}
            </div>

            <p className="mt-6 text-center text-xs leading-6 text-muted-foreground">
              {WAVE_TITLES[1]} تا {WAVE_TITLES[6]} · همهٔ اعداد از پایگاه دادهٔ زنده می‌آیند.
            </p>
          </>
        )}
    </div>
  );
}
