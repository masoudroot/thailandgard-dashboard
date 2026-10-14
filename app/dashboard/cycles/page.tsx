'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Cycle, CycleStatus } from '@/lib/types';

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

type CycleRow = Cycle & {
  team_count?: number;
  llm_calls?: number;
};

const STATUS_LABEL: Record<CycleStatus, string> = {
  running: 'در حال اجرا',
  success: 'موفق',
  failed: 'ناموفق',
  canceled: 'لغوشده',
};

function StatusBadge({ status }: { status: CycleStatus }) {
  const tone =
    status === 'running'
      ? 'bg-warning/10 text-warning border-warning/30'
      : status === 'success'
        ? 'bg-success/10 text-success border-success/30'
        : status === 'failed'
          ? 'bg-destructive/10 text-destructive border-destructive/30'
          : 'bg-muted text-muted-foreground border-border';
  const dot =
    status === 'running'
      ? 'bg-warning'
      : status === 'success'
        ? 'bg-success'
        : status === 'failed'
          ? 'bg-destructive'
          : 'bg-muted-foreground';
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${tone}`}
    >
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {STATUS_LABEL[status]}
    </span>
  );
}

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

const MOCK_CYCLES: CycleRow[] = [
  {
    id: 'cyc-2026-10-14-01',
    run_id: 'run_9f31ab',
    status: 'running',
    started_at: '2026-10-14T14:02:11+03:30',
    finished_at: null,
    stats: null,
    team_count: 15,
    llm_calls: 47,
  },
  {
    id: 'cyc-2026-10-13-03',
    run_id: 'run_7d20ce',
    status: 'success',
    started_at: '2026-10-13T22:15:00+03:30',
    finished_at: '2026-10-13T23:48:32+03:30',
    stats: null,
    team_count: 15,
    llm_calls: 132,
  },
  {
    id: 'cyc-2026-10-13-02',
    run_id: 'run_5b18d4',
    status: 'failed',
    started_at: '2026-10-13T18:05:44+03:30',
    finished_at: '2026-10-13T18:31:09+03:30',
    stats: null,
    team_count: 15,
    llm_calls: 28,
  },
];

export default function CyclesPage() {
  const [cycles, setCycles] = useState<CycleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [usingMock, setUsingMock] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/cycles', { cache: 'no-store' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      const list: CycleRow[] = Array.isArray(data) ? data : data.cycles ?? [];
      setCycles(list);
      setUsingMock(false);
      setError('');
    } catch {
      setCycles(MOCK_CYCLES);
      setUsingMock(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createCycle() {
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/cycles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `status ${res.status}`);
      await load();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'ساخت چرخه جدید انجام نشد.',
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <main dir="rtl" className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">مانیتور چرخه‌ها</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              چرخه‌های اجرایی تیم‌های هوش مصنوعی تایلندگرد
            </p>
          </div>
          <button
            onClick={createCycle}
            disabled={creating}
            className="rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-brand-foreground shadow-control transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creating ? 'در حال ساخت…' : 'چرخه جدید'}
          </button>
        </header>

        {usingMock && (
          <p className="mb-4 rounded-lg border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm text-warning">
            اتصال به API برقرار نشد؛ داده نمونه نمایش داده می‌شود.
          </p>
        )}

        {error && (
          <p
            role="alert"
            className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive"
          >
            خطا در ساخت چرخه: {error}
          </p>
        )}

        {loading ? (
          <div className="rounded-2xl border border-border bg-card p-10 text-center text-sm text-muted-foreground shadow-surface">
            در حال بارگذاری چرخه‌ها…
          </div>
        ) : cycles.length === 0 ? (
          <div className="rounded-2xl border border-border bg-card p-10 text-center shadow-surface">
            <p className="text-sm text-muted-foreground">
              هنوز چرخه‌ای ثبت نشده است.
            </p>
            <button
              onClick={createCycle}
              disabled={creating}
              className="mt-4 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-brand-foreground disabled:opacity-50"
            >
              {creating ? 'در حال ساخت…' : 'ساخت اولین چرخه'}
            </button>
          </div>
        ) : (
          <>
            {/* کارت‌های عمودی در موبایل */}
            <div className="space-y-3 md:hidden">
              {cycles.map((c) => (
                <article
                  key={c.id}
                  className="rounded-2xl border border-border bg-card p-4 shadow-surface"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className="truncate font-mono text-xs font-bold text-card-foreground"
                      dir="ltr"
                    >
                      {c.run_id}
                    </span>
                    <StatusBadge status={c.status} />
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
            <div className="hidden overflow-hidden rounded-2xl border border-border bg-card shadow-surface md:block">
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
                  {cycles.map((c) => (
                    <tr
                      key={c.id}
                      className="border-b border-border last:border-0 transition-colors hover:bg-muted/40"
                    >
                      <td className="px-4 py-3 font-mono text-xs text-card-foreground" dir="ltr">
                        {c.run_id}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={c.status} />
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
          </>
        )}
      </div>
    </main>
  );
}
