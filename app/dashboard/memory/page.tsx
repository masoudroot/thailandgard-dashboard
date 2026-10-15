'use client';

import { useEffect, useMemo, useState } from 'react';
import { Brain, History, Search, SearchX, WifiOff, X } from 'lucide-react';
import { TEAMS, type TeamName } from '@/lib/types';
import EmptyState from '@/components/EmptyState';
import PageHeader from '@/components/PageHeader';
import { SkeletonPanel } from '@/components/Skeleton';

/** نام‌های فارسی خوانا برای ۱۵ تیم */
const TEAM_LABELS: Record<TeamName, string> = {
  artdir: 'آرت‌دایرکتور',
  branding: 'برندینگ',
  content: 'محتوا',
  seo: 'سئو',
  analytics: 'تحلیل داده',
  intel: 'اطلاعات بازار',
  lead: 'لید و فروش',
  design: 'طراحی',
  seocontent: 'محتوای سئو',
  vibefarsi: 'وایب‌فارسی',
  farsiui: 'رابط فارسی',
  'design-ir': 'طراحی ایران',
  dev: 'توسعه',
  qa: 'کنترل کیفیت',
  inspector: 'بازرس',
};

type TeamFilter = TeamName | 'all';

interface MemoryRow {
  team: TeamName;
  key: string;
  value: unknown;
  updated_at: string;
}

interface HistoryEntry {
  value: unknown;
  superseded_at: string;
}

const faDigits = (n: number | string) => String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]);

const jalaliFormatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function prettyJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** کارت یک رکورد حافظه با تاریخچه‌ی تاشو. */
function MemoryCard({ row }: { row: MemoryRow }) {
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  async function loadHistory() {
    if (history !== null || historyLoading) return;
    setHistoryLoading(true);
    try {
      const res = await fetch(
        `/api/memory/history?team=${encodeURIComponent(row.team)}&key=${encodeURIComponent(row.key)}`,
        { cache: 'no-store' },
      );
      const json = await res.json().catch(() => null);
      setHistory(res.ok && json?.ok !== false ? (json.data as HistoryEntry[]) : []);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  return (
    <li className="overflow-hidden rounded-xl border border-border bg-card shadow-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-[52px] w-full items-center justify-between gap-3 px-4 py-3 text-start"
      >
        <span className="min-w-0">
          <span className="block truncate font-mono text-sm font-semibold text-foreground" dir="ltr">
            {row.key}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {TEAM_LABELS[row.team]} · {jalaliFormatter.format(new Date(row.updated_at))}
          </span>
        </span>
        <span className={`shrink-0 text-xs text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="border-t border-border bg-muted/40">
          <pre
            dir="rtl"
            className="overflow-x-auto whitespace-pre-wrap px-4 py-3 font-mono text-[13px] leading-7 text-foreground"
          >
            {prettyJson(row.value)}
          </pre>
          <div className="border-t border-border px-4 py-3">
            <button
              type="button"
              onClick={() => {
                const next = !historyOpen;
                setHistoryOpen(next);
                if (next) void loadHistory();
              }}
              aria-expanded={historyOpen}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-brand hover:underline"
            >
              <History size={14} strokeWidth={2} aria-hidden="true" />
              {historyOpen ? 'بستن تاریخچه' : 'دیدن تاریخچه‌ی این رکورد'}
            </button>

            {historyOpen && (
              <div className="mt-3 space-y-2">
                {historyLoading && <p className="text-xs text-muted-foreground">در حال بارگذاری…</p>}
                {!historyLoading && history !== null && history.length === 0 && (
                  <p className="text-xs leading-6 text-muted-foreground">
                    برای این رکورد نسخه‌ی قبلی ثبت نشده است.
                  </p>
                )}
                {!historyLoading &&
                  history !== null &&
                  history.map((h, i) => (
                    <div key={i} className="rounded-lg border border-border bg-card p-3">
                      <p className="mb-1 text-[11px] text-muted-foreground">
                        نسخه‌ی {faDigits(history.length - i)} · {jalaliFormatter.format(new Date(h.superseded_at))}
                      </p>
                      <pre
                        dir="rtl"
                        className="overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-6 text-foreground"
                      >
                        {prettyJson(h.value)}
                      </pre>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export default function MemoryPage() {
  const [team, setTeam] = useState<TeamFilter>('all');
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'offline'>('loading');

  useEffect(() => {
    let alive = true;
    setState('loading');
    fetch(`/api/memory?team=${team}`, { cache: 'no-store' })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!alive) return;
        if (!res.ok || data?.ok === false) {
          setState('offline');
          return;
        }
        const list = (data.data ?? []) as Array<{
          team: TeamName;
          key: string;
          value: unknown;
          updated_at?: string;
        }>;
        setRows(
          (Array.isArray(list) ? list : []).map((r) => ({
            team: r.team,
            key: r.key,
            value: r.value,
            updated_at: r.updated_at ?? new Date().toISOString(),
          })),
        );
        setState('ready');
      })
      .catch(() => {
        if (alive) setState('offline');
      });
    return () => {
      alive = false;
    };
  }, [team]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.key.toLowerCase().includes(q) ||
        prettyJson(r.value).toLowerCase().includes(q),
    );
  }, [rows, query]);

  return (
    <div className="mx-auto max-w-3xl">
        <PageHeader
          icon={Brain}
          title="نمایشگر حافظه"
          subtitle="حافظه بلندمدت تیم‌ها؛ جست‌وجو در متن، فیلتر تیم و تاریخچه‌ی هر رکورد"
        />

        <div className="mb-6 flex flex-col gap-3 sm:flex-row">
          <label className="flex flex-1 flex-col gap-1.5">
            <span className="text-sm font-medium text-muted-foreground">تیم</span>
            <select
              value={team}
              onChange={(e) => setTeam(e.target.value as TeamFilter)}
              className="rounded-xl border border-input bg-card px-3 py-2.5 text-foreground outline-none focus:border-ring"
            >
              <option value="all">همه‌ی تیم‌ها</option>
              {TEAMS.map((t) => (
                <option key={t} value={t}>
                  {TEAM_LABELS[t]} ({t})
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-1 flex-col gap-1.5">
            <span className="text-sm font-medium text-muted-foreground">جست‌وجو در متن</span>
            <span className="relative block">
              <Search
                size={16}
                strokeWidth={2}
                aria-hidden="true"
                className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="کلید یا محتوای مقدار…"
                className={`w-full rounded-xl border border-input bg-card py-2.5 ps-9 text-start text-foreground outline-none placeholder:text-muted-foreground focus:border-ring ${query ? 'pe-10' : 'pe-3'}`}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="پاک کردن جست‌وجو"
                  className="absolute end-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X size={16} strokeWidth={2} aria-hidden="true" />
                </button>
              )}
            </span>
          </label>
        </div>

        {state === 'loading' && (
          <div className="tg-stagger space-y-4">
            {[0, 1, 2].map((i) => (
              <SkeletonPanel key={i} />
            ))}
          </div>
        )}

        {state === 'offline' && (
          <EmptyState
            icon={WifiOff}
            title="به دیتابیس متصل نیست"
            description="حافظه بارگذاری نشد. اتصال را بررسی کنید و دوباره تلاش کنید. هیچ داده‌ی نمایشی نشان داده نمی‌شود."
            action={
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-brand px-5 py-2 text-sm font-medium text-brand-foreground shadow-control transition-colors hover:opacity-90"
              >
                تلاش دوباره
              </button>
            }
          />
        )}

        {state === 'ready' &&
          (filtered.length === 0 ? (
            query ? (
              <EmptyState
                icon={SearchX}
                title="چیزی با این عبارت پیدا نشد"
                description="در کلیدها و متن مقدارها جست‌وجو شد. عبارت دیگری را امتحان کنید یا جست‌وجو را پاک کنید."
                action={
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-border bg-card px-5 py-2 text-sm font-medium text-card-foreground shadow-control transition-colors hover:bg-accent"
                  >
                    پاک کردن جست‌وجو
                  </button>
                }
              />
            ) : (
              <EmptyState
                icon={Brain}
                title="رکوردی ثبت نشده است"
                description="بعد از اولین اجرای تیم‌ها در چرخه، حافظه‌ی بلندمدت همین‌جا نمایش داده می‌شود."
                tint="bg-brand/10 text-brand"
              />
            )
          ) : (
            <>
              <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
                {faDigits(filtered.length)} رکورد
                {team !== 'all' && ` در حافظه ${TEAM_LABELS[team as TeamName]}`}
              </p>
              <ul className="space-y-4">
                {filtered.map((row) => (
                  <MemoryCard key={`${row.team}:${row.key}`} row={row} />
                ))}
              </ul>
            </>
          ))}
    </div>
  );
}
