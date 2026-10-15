'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Inbox, KeyRound, Repeat2 } from 'lucide-react';
import type { Cycle } from '@/lib/types';
import { normalizeCycleStatus } from '@/lib/types';
import { EmptyState } from '@/components/ui/empty-state';
import NotConnected from '@/components/NotConnected';
import PageHeader from '@/components/PageHeader';
import LoadMore, { useVisibleCount } from '@/components/LoadMore';
import StatusBadge from '@/components/dataviz/StatusBadge';
import TrendChart, { type TrendPoint } from '@/components/dataviz/TrendChart';
import { SkeletonTable } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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

type LoadState = 'loading' | 'ready' | 'not-connected' | 'unauthorized' | 'error';

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
      // بررسی اتصال با همان منطق صفحه تنظیمات (متغیرهای محیطی)
      try {
        const cfgRes = await fetch('/api/settings/supabase/test', { cache: 'no-store' });
        const cfgBody = await cfgRes.json().catch(() => ({}));
        const configured = cfgBody?.data?.configured ?? cfgBody?.configured ?? false;
        if (!configured) {
          setCycles([]);
          setLoadState('not-connected');
          return;
        }
      } catch {
        // اگر بررسی اتصال خودش خطا داد، ادامه بده و بگذار خطای اصلی مشخص شود
      }
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
      // پایگاه داده وصل است ولی خواندن چرخه‌ها خطا داد؛ «متصل نیست» گمراه‌کننده است
      setCycles([]);
      setLoadState('error');
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
        throw new Error(payload.error?.message ?? `خطا با کد ${faNum(res.status)}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'چرخهٔ جدید ساخته نشد؛ دوباره تلاش کنید.');
    } finally {
      setCreating(false);
    }
  }

  const newCycleDisabled = creating || loadState !== 'ready' || !!activeCycle;

  return (
    <div className="mx-auto max-w-6xl">
        <PageHeader
          icon={Repeat2}
          title="چرخه‌ها"
          subtitle="چرخه‌های اجرایی تیم‌های هوش مصنوعی تایلندگرد"
          actions={
            <div className="flex flex-col items-stretch gap-1.5">
              <Button
                variant="default"
                onClick={createCycle}
                disabled={newCycleDisabled || creating}
                aria-busy={creating || undefined}
                title={
                  activeCycle
                    ? 'تا چرخهٔ فعال تمام یا لغو نشود، چرخهٔ جدیدی شروع نمی‌شود'
                    : 'شروع چرخهٔ جدید'
                }
              >
                {creating ? 'در حال ساخت…' : 'شروع چرخهٔ جدید'}
              </Button>
              {activeCycle && (
                <span className="text-center text-xs text-muted-foreground">
                  یک چرخه در حال اجراست؛ برای شروع چرخهٔ جدید اول آن را ببندید یا لغو کنید
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
            ساخت چرخه انجام نشد: {error}
          </p>
        )}

        {loadState === 'loading' ? (
          <SkeletonTable rows={4} columns={7} />
        ) : loadState === 'not-connected' ? (
          <NotConnected onRetry={load} retrying={false} />
        ) : loadState === 'error' ? (
          <EmptyState
            icon={Inbox}
            title="خواندن چرخه‌ها ناموفق بود"
            description="پایگاه داده متصل است ولی دریافت فهرست چرخه‌ها خطا داد. دوباره تلاش کنید."
            action={
              <Button variant="outline" onClick={load}>
                تلاش دوباره
              </Button>
            }
          />
        ) : loadState === 'unauthorized' ? (
          <EmptyState
            icon={KeyRound}
            title="ورود شما منقضی شده است"
            description="برای دیدن چرخه‌ها دوباره وارد شوید."
            action={
              <Link
                href="/login"
                className="inline-flex min-h-11 items-center justify-center rounded-xl bg-primary px-6 py-2 text-sm font-bold text-primary-foreground shadow-control hover:opacity-90"
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
            action={
              <Button
                variant="default"
                onClick={createCycle}
                disabled={creating}
                aria-busy={creating || undefined}
              >
                {creating ? 'در حال ساخت…' : 'شروع اولین چرخه'}
              </Button>
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
                    className="mt-4 flex min-h-11 items-center justify-center rounded-xl border border-border px-3 py-2 text-sm font-medium text-card-foreground transition-colors active:bg-muted"
                  >
                    جزئیات
                  </Link>
                </article>
              ))}
            </div>

            {/* جدول در دسکتاپ */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>شناسه اجرا</TableHead>
                    <TableHead>وضعیت</TableHead>
                    <TableHead>شروع</TableHead>
                    <TableHead>پایان</TableHead>
                    <TableHead>تعداد تیم‌ها</TableHead>
                    <TableHead>فراخوانی LLM</TableHead>
                    <TableHead>جزئیات</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shownCycles.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell dir="ltr" className="font-mono text-xs">
                        {c.run_id}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={cycleStatus(c)} />
                      </TableCell>
                      <TableCell>{faDate(c.started_at)}</TableCell>
                      <TableCell>{faDate(c.finished_at)}</TableCell>
                      <TableCell numeric>{faNum(readCount(c))}</TableCell>
                      <TableCell numeric>{faNum(readLlmCalls(c))}</TableCell>
                      <TableCell>
                        <Link
                          href={`/dashboard/cycles/${c.id}`}
                          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-card-foreground transition-colors hover:border-ring hover:text-brand"
                        >
                          جزئیات
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {hasMore && (
              <LoadMore visible={visible} total={cycles.length} onShowMore={showMore} />
            )}
          </>
        )}
    </div>
  );
}
