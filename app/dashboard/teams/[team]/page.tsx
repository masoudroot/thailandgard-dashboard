'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowRight, FileText, LayoutGrid, ScrollText, Send, WifiOff } from 'lucide-react';
import PageHeader from '../../../../components/PageHeader';
import { EmptyState } from '../../../../components/ui/empty-state';
import StatusBadge from '../../../../components/dataviz/StatusBadge';
import { SkeletonPanel } from '../../../../components/Skeleton';
import { Button } from '../../../../components/ui/Button';
import { Card } from '../../../../components/ui/Card';
import { SegmentedControl } from '../../../../components/ui/segmented-control';
import { TEAMS, type TeamName, type TeamRun } from '../../../../lib/types';
import { TEAM_META, WAVE_TITLES } from '../../../../lib/team-meta';

import { faNum } from '../../../../lib/format';

const jalaliDate = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

interface TeamNotice {
  id: string;
  cycle_id: string | null;
  team: string;
  message: string;
  channel: string;
  sent_at: string;
  telegram_message_id: string | null;
  status: string;
}

interface TeamDetail {
  team: TeamName;
  faName: string;
  mission: string;
  wave: number | null;
  runs: TeamRun[];
  notifications: TeamNotice[];
}

type Tab = 'overview' | 'reports';

/** تب «گزارش‌های تیم»: هر اجرا + اطلاع‌رسانی‌های دوگانه‌ی ثبت‌شده در پنل. */
function ReportsTab({ detail }: { detail: TeamDetail }) {
  if (detail.runs.length === 0) {
    return (
      <EmptyState
        icon={ScrollText}
        title="هنوز گزارشی برای این تیم ثبت نشده است"
        description="بعد از اولین اجرای تیم در چرخه، گزارش هر اجرا (خلاصهٔ خروجی، وضعیت و زمان) همین‌جا می‌آید."
      />
    );
  }
  return (
    <div className="space-y-3">
      {detail.runs.map((run) => (
        <article
          key={run.id}
          className="rounded-xl border border-border bg-card p-4 shadow-surface sm:p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <StatusBadge status={run.status} />
            <span className="text-xs text-muted-foreground">
              {run.started_at ? jalaliDate.format(new Date(run.started_at)) : '…'}
              {run.finished_at && run.started_at
                ? ` تا ${jalaliDate.format(new Date(run.finished_at))}`
                : ''}
            </span>
          </div>
          {run.output_summary ? (
            <p className="mt-3 text-sm leading-8 text-card-foreground">{run.output_summary}</p>
          ) : (
            <p className="mt-3 text-sm leading-8 text-muted-foreground">خلاصه‌ای ثبت نشده است.</p>
          )}
          {run.error && (
            <p className="mt-2 text-xs leading-6 text-destructive">{run.error}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
            <span>
              موج: <strong className="text-card-foreground">{WAVE_TITLES[run.wave] ?? faNum(run.wave)}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              فراخوانی LLM: <strong className="text-card-foreground">{faNum(run.llm_calls ?? 0)}</strong>
            </span>
            {typeof run.progress === 'number' && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  پیشرفت: <strong className="text-card-foreground">{faNum(run.progress)}٪</strong>
                </span>
              </>
            )}
          </div>
        </article>
      ))}

      {detail.notifications.length > 0 && (
        <section className="pt-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-card-foreground">
            <Send size={16} strokeWidth={2} aria-hidden="true" />
            اطلاع‌رسانی‌های ثبت‌شده در داشبورد
            <span className="font-normal text-muted-foreground">({faNum(detail.notifications.length)})</span>
          </h2>
          <ul className="space-y-2">
            {detail.notifications.map((n) => (
              <li
                key={n.id}
                className="rounded-xl border border-border bg-muted/40 p-4"
              >
                <p className="whitespace-pre-wrap text-sm leading-8 text-card-foreground">{n.message}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {jalaliDate.format(new Date(n.sent_at))}
                  {n.telegram_message_id && ' · به تلگرام هم ارسال شد'}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export default function TeamDetailPage() {
  const params = useParams<{ team: string }>();
  const team = params.team as TeamName;
  const valid = TEAMS.includes(team);

  const [tab, setTab] = useState<Tab>('overview');
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'offline'>('loading');

  useEffect(() => {
    if (!valid) return;
    let alive = true;
    fetch(`/api/teams/${team}`, { cache: 'no-store' })
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!alive) return;
        if (!res.ok || json?.ok === false) {
          setState('offline');
          return;
        }
        setDetail(json.data as TeamDetail);
        setState('ready');
      })
      .catch(() => {
        if (alive) setState('offline');
      });
    return () => {
      alive = false;
    };
  }, [team, valid]);

  if (!valid) {
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState
          icon={FileText}
          title="تیم نامعتبر است"
          description="چنین تیمی در داشبورد تعریف نشده است."
          action={
            <Link href="/dashboard/teams">
              <Button variant="outline">بازگشت به تیم‌ها</Button>
            </Link>
          }
        />
      </div>
    );
  }

  const meta = TEAM_META[team];
  const lastRun = detail?.runs[0];

  return (
    <div className="mx-auto max-w-3xl">
        <Link
          href="/dashboard/teams"
          className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowRight size={16} strokeWidth={2} aria-hidden="true" className="rotate-180" />
          همهٔ تیم‌ها
        </Link>

        <PageHeader
          icon={LayoutGrid}
          title={meta.faName}
          subtitle={meta.mission}
        />

        {/* تب‌ها */}
        <SegmentedControl
          fullWidth
          aria-label="بخش‌های صفحهٔ تیم"
          value={tab}
          onChange={(v) => setTab(v as Tab)}
          options={[
            { value: 'overview', label: 'نمای کلی' },
            {
              value: 'reports',
              label: (
                <>
                  گزارش‌های تیم
                  {detail && (
                    <span className="ms-1.5 text-xs font-normal">({faNum(detail.runs.length)})</span>
                  )}
                </>
              ),
            },
          ]}
        />

        {state === 'loading' && (
          <div className="space-y-3">
            {[0, 1].map((i) => (
              <SkeletonPanel key={i} />
            ))}
          </div>
        )}

        {state === 'offline' && (
          <EmptyState
            icon={WifiOff}
            title="به پایگاه داده متصل نیست"
            description="اطلاعات تیم بارگذاری نشد. اتصال را بررسی کنید و دوباره تلاش کنید."
            action={
              <Button variant="outline" onClick={() => window.location.reload()}>
                تلاش دوباره
              </Button>
            }
          />
        )}

        {state === 'ready' && detail && tab === 'overview' && (
          <div className="space-y-3">
            <Card className="p-4 shadow-surface sm:p-5">
              <h2 className="text-sm font-bold text-card-foreground">مشخصات تیم</h2>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">شناسه</dt>
                  <dd className="font-mono text-card-foreground" dir="ltr">{detail.team}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">موج اجرا</dt>
                  <dd className="text-card-foreground">
                    {detail.wave ? (WAVE_TITLES[detail.wave] ?? faNum(detail.wave)) : '…'}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">تعداد اجراهای ثبت‌شده</dt>
                  <dd className="text-card-foreground">{faNum(detail.runs.length)}</dd>
                </div>
              </dl>
            </Card>

            <Card className="p-4 shadow-surface sm:p-5">
              <h2 className="text-sm font-bold text-card-foreground">آخرین اجرا</h2>
              {lastRun ? (
                <div className="mt-3 space-y-2">
                  <StatusBadge status={lastRun.status} />
                  {lastRun.output_summary && (
                    <p className="text-sm leading-8 text-card-foreground">{lastRun.output_summary}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {lastRun.started_at ? jalaliDate.format(new Date(lastRun.started_at)) : '…'}
                  </p>
                </div>
              ) : (
                <p className="mt-3 text-sm leading-8 text-muted-foreground">
                  این تیم هنوز در هیچ چرخه‌ای اجرا نشده است.
                </p>
              )}
            </Card>
          </div>
        )}

        {state === 'ready' && detail && tab === 'reports' && <ReportsTab detail={detail} />}
    </div>
  );
}
