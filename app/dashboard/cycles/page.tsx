'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Inbox, KeyRound, Repeat2 } from 'lucide-react';
import type { Cycle } from '@/lib/types';
import { normalizeCycleStatus } from '@/lib/types';
import EmptyState from '@/components/EmptyState';
import NotConnected from '@/components/NotConnected';
import PageHeader from '@/components/PageHeader';
import LoadMore, { useVisibleCount } from '@/components/LoadMore';
import StatusBadge from '@/components/dataviz/StatusBadge';
import TrendChart, { type TrendPoint } from '@/components/dataviz/TrendChart';
import { SkeletonTable } from '@/components/Skeleton';
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

type CycleRow = Cycle & {
  team_count?: number;
  llm_calls?: number;
};

function readCount(c: CycleRow): number {
  if (typeof c.team_count === 'number') return c.team_count;
  const s = c.stats?.team_count;
  return typeof s === 'number' ? s : 0;
}

function readLlmCalls(c: CycleRow): number {
  if (typeof c.llm_calls === 'number') return c.llm_calls;
  const s = c.stats?.llm_calls;
  return typeof s === 'number' ? s : 0;
}

function cycleStatus(c: CycleRow) {
  return normalizeCycleStatus(c.status);
}

/** باز کردن پوشش API: { ok, data } یا دادهٔ خام */
function unwrapPayload(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    return (body as { data: unknown }).data;
  }
  return body;
}

type LoadState = 'loading' | 'ready' | 'not-connected' | 'unauthorized';

export default function CyclesPage() {
  const [cycles, setCycles] = useState<CycleRow[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const PAGE_SIZE = 8;
  const { visible, hasMore, showMore } = useVisibleCount(cycles.length, PAGE_SIZE);
  const shownCycles = cycles.slice(0, visible);

  /* نقاط نمودار روند: از قدیمی‌ترین به جدیدترین، راست‌به‌چپ */
  const trendPoints: TrendPoint[] = [...cycles]
    .sort(
      (a, b) =>
        new Date(a.started_at ?? 0).getTime() -
        new Date(b.started_at ?? 0).getTime(),
    )
    .map((c, i) => ({ label: `چرخهٔ ${faNum(i + 1)}`, value: readLlmCalls(c) }));

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const res = await fetch('/api/cycles', { cache: 'no-store' });
      if (res.status === 401) {
        setLoadState('unauthorized');
        return;
      }
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = await res.json();
      const payload = unwrapPayload(body);
      const list: CycleRow[] = Array.isArray(payload)
        ? payload
        : ((payload as { cycles?: CycleRow[] }).cycles ?? []);
      setCycles(list);
      setLoadState('ready');
      setError('');
    } catch {
      // قانون مسعود: به‌جای دادهٔ نمونه، صادقانه «متصل نیست» نمایش بده.
      setCycles([]);
      setLoadState('not-connected');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** چرخهٔ فعال: تا وقتی هست، دکمهٔ «چرخه جدید» غیرفعال است. */
  const activeCycle = cycles.find((c) =>
    ['running', 'pausing', 'paused'].includes(cycleStatus(c)),
  );

  async function createCycle() {
    if (activeCycle) return;
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/cycles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      const payload = unwrapPayload(body) as { error?: { message?: string } };
      if (!res.ok) {
        throw new Error(payload.error?.message ?? `خطا با کد ${res.status}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ساخت چرخه جدید انجام نشد.');
    } finally {
      setCreating(false);
    }
  }

  const newCycleDisabled = creating || loadState !== 'ready' || !!activeCycle;

  return (
    <div className="mx-auto max-w-6xl">
        <PageHeader
          icon={Repeat2}
          title="مانیتور چرخه‌ها"
          subtitle="چرخه‌های اجرایی تیم‌های هوش مصنوعی تایلندگرد"
          actions={
            <div className="flex flex-col items-stretch gap-1.5">
              <button
                onClick={createCycle}
                disabled={newCycleDisabled}
                title={
                  activeCycle
                    ? 'تا چرخهٔ فعال تمام یا لغو نشود، چرخهٔ جدید ساخته نمی‌شود'
                    : 'شروع چرخهٔ جدید'
                }
                className="tg-btn inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-brand-foreground shadow-control hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creating ? 'در حال ساخت…' : 'چرخه جدید'}
              </button>
              {activeCycle && (
                <span className="text-center text-xs text-muted-foreground">
                  چرخه‌ای فعال است؛ اول آن را ببندید
                </span>
              )}
            </div>
          }
        />

        {error && (
          <p
            role="alert"
            className="tg-shake mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive"
          >
            خطا در ساخت چرخه: {error}
          </p>
        )}

        {loadState === 'loading' ? (
          <SkeletonTable rows={4} columns={7} />
        ) : loadState === 'not-connected' ? (
          <NotConnected onRetry={load} retrying={false} />
        ) : loadState === 'unauthorized' ? (
          <EmptyState
            icon={KeyRound}
            title="نشست شما منقضی شده است"
            description="برای دیدن چرخه‌ها دوباره وارد شوید."
            action={
              <Link
                href="/login"
                className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-brand px-6 py-2 text-sm font-bold text-brand-foreground shadow-control hover:opacity-90"
              >
                ورود دوباره
              </Link>
            }
          />
        ) : cycles.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="هنوز چرخه‌ای ثبت نشده است"
            description="اولین چرخه را بسازید تا پانزده تیم هوش مصنوعی در شش موج وارد صف اجرا شوند."
            tint="bg-brand/10 text-brand"
            action={
              <button
                onClick={createCycle}
                disabled={creating}
                className="tg-btn inline-flex min-h-[48px] items-center justify-center rounded-xl bg-brand px-6 py-2.5 text-sm font-bold text-brand-foreground shadow-control hover:opacity-90 disabled:opacity-50"
              >
                {creating ? 'در حال ساخت…' : 'ساخت اولین چرخه'}
              </button>
            }
          />
        ) : (
          <>
            {trendPoints.length >= 2 && (
              <TrendChart
                title="روند فراخوانی LLM در چرخه‌های اخیر"
                unit="فراخوانی"
                points={trendPoints}
                className="mb-6 md:mb-8"
              />
            )}
            {/* کارت‌های عمودی در موبایل */}
            <div className="space-y-4 md:hidden">
              {shownCycles.map((c) => (
                <article
                  key={c.id}
                  className="tg-card rounded-xl border border-border bg-card p-4 shadow-surface"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className="truncate font-mono text-xs font-bold text-card-foreground"
                      dir="ltr"
                    >
                      {c.run_id}
                    </span>
                    <StatusBadge status={cycleStatus(c)} />
                  </div>
                  <dl className="mt-4 space-y-2.5 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-xs text-muted-foreground">شروع</dt>
                      <dd className="text-card-foreground">{faDate(c.started_at)}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-xs text-muted-foreground">پایان</dt>
                      <dd className="text-card-foreground">{faDate(c.finished_at)}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-xs text-muted-foreground">تعداد تیم‌ها</dt>
                      <dd className="font-medium text-card-foreground">
                        {faNum(readCount(c))}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-xs text-muted-foreground">فراخوانی LLM</dt>
                      <dd className="font-medium text-card-foreground">
                        {faNum(readLlmCalls(c))}
                      </dd>
                    </div>
                  </dl>
                  <Link
                    href={`/dashboard/cycles/${c.id}`}
                    className="mt-4 flex min-h-[44px] items-center justify-center rounded-xl border border-border px-3 py-2 text-sm font-medium text-card-foreground transition-colors active:bg-muted"
                  >
                    مشاهده جزئیات
                  </Link>
                </article>
              ))}
            </div>

            {/* جدول در دسکتاپ */}
            <div className="hidden overflow-hidden rounded-xl border border-border bg-card shadow-surface md:block">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-muted-foreground">
                    <th className="px-4 py-3 text-start font-medium">شناسه اجرا</th>
                    <th className="px-4 py-3 text-start font-medium">وضعیت</th>
                    <th className="px-4 py-3 text-start font-medium">شروع</th>
                    <th className="px-4 py-3 text-start font-medium">پایان</th>
                    <th className="px-4 py-3 text-start font-medium">تعداد تیم‌ها</th>
                    <th className="px-4 py-3 text-start font-medium">فراخوانی LLM</th>
                    <th className="px-4 py-3 text-start font-medium">جزئیات</th>
                  </tr>
                </thead>
                <tbody>
                  {shownCycles.map((c) => (
                    <tr
                      key={c.id}
                      className="tg-row border-b border-border last:border-0 hover:bg-muted/40"
                    >
                      <td className="px-4 py-3 font-mono text-xs text-card-foreground" dir="ltr">
                        {c.run_id}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={cycleStatus(c)} />
                      </td>
                      <td className="px-4 py-3 text-card-foreground">{faDate(c.started_at)}</td>
                      <td className="px-4 py-3 text-card-foreground">{faDate(c.finished_at)}</td>
                      <td className="px-4 py-3 text-card-foreground">{faNum(readCount(c))}</td>
                      <td className="px-4 py-3 text-card-foreground">{faNum(readLlmCalls(c))}</td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/dashboard/cycles/${c.id}`}
                          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-card-foreground transition-colors hover:border-ring hover:text-brand"
                        >
                          مشاهده
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
            {hasMore && (
              <LoadMore visible={visible} total={cycles.length} onShowMore={showMore} />
            )}
          </>
        )}
    </div>
  );
}
