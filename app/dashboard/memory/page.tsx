'use client';

import { useEffect, useMemo, useState } from 'react';
import { TEAMS, type TeamName } from '@/lib/types';

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

interface MemoryRow {
  team: TeamName;
  key: string;
  value: unknown;
  updated_at: string;
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

/** داده نمایشی؛ وقتی /api/memory در دسترس نیست استفاده می‌شود */
function mockRows(team: TeamName): MemoryRow[] {
  const now = new Date();
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();
  return [
    {
      team,
      key: 'last_cycle_summary',
      value: { status: 'success', cycles_done: 3, last_run: 'امروز صبح', notes: 'همه موج‌ها سبز شدند' },
      updated_at: hoursAgo(2),
    },
    {
      team,
      key: 'blockers',
      value: ['دسترسی API تایلندگرد', 'تأیید متن لندینگ توسط مدیر'],
      updated_at: hoursAgo(7),
    },
    {
      team,
      key: 'preferences',
      value: { tone: 'محاوره‌ای', digits: 'fa', rtl: true, max_items: 12 },
      updated_at: hoursAgo(26),
    },
    {
      team,
      key: 'notes',
      value: 'در چرخه بعدی اولویت با صفحات تور پرفروش است؛ آمار کلیک تماس چک شود.',
      updated_at: hoursAgo(49),
    },
  ];
}

export default function MemoryPage() {
  const [team, setTeam] = useState<TeamName>('content');
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [usingMock, setUsingMock] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setOpenKey(null);
    fetch(`/api/memory?team=${team}`)
      .then((res) => {
        if (!res.ok) throw new Error('api-missing');
        return res.json();
      })
      .then((data) => {
        if (!alive) return;
        const list = (data.ok ? data.data : data) as Array<{ team: TeamName; key: string; value: unknown; updated_at?: string }>;
        setRows(
          (Array.isArray(list) ? list : []).map((r) => ({
            team: r.team,
            key: r.key,
            value: r.value,
            updated_at: r.updated_at ?? new Date().toISOString(),
          })),
        );
        setUsingMock(false);
      })
      .catch(() => {
        if (!alive) return;
        setRows(mockRows(team));
        setUsingMock(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [team]);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return rows;
    return rows.filter((r) => r.key.toLowerCase().includes(q.toLowerCase()));
  }, [rows, query]);

  return (
    <main dir="rtl" className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-bold">نمایشگر حافظه</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            حافظه بلندمدت تیم‌ها؛ کلیدها و مقدارهای ذخیره‌شده در جدول team_memory
          </p>
        </header>

        <div className="mb-4 flex flex-col gap-3 sm:flex-row">
          <label className="flex flex-1 flex-col gap-1.5">
            <span className="text-sm font-medium text-muted-foreground">تیم</span>
            <select
              value={team}
              onChange={(e) => setTeam(e.target.value as TeamName)}
              className="rounded-xl border border-input bg-card px-3 py-2.5 text-foreground outline-none focus:border-ring"
            >
              {TEAMS.map((t) => (
                <option key={t} value={t}>
                  {TEAM_LABELS[t]} ({t})
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-1 flex-col gap-1.5">
            <span className="text-sm font-medium text-muted-foreground">جست‌وجو در کلیدها</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="مثلاً last_cycle"
              dir="ltr"
              className="rounded-xl border border-input bg-card px-3 py-2.5 text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
            />
          </label>
        </div>

        {usingMock && !loading && (
          <p className="mb-4 rounded-xl border border-warning bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
            اتصال به API برقرار نشد؛ داده نمایشی نشان داده می‌شود.
          </p>
        )}

        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="animate-pulse rounded-2xl border border-border bg-card p-4">
                <div className="mb-2 h-4 w-40 rounded bg-muted" />
                <div className="h-20 rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-border bg-card p-10 text-center text-muted-foreground">
            {query ? 'کلیدی با این عبارت پیدا نشد.' : 'برای این تیم حافظه‌ای ثبت نشده است.'}
          </div>
        ) : (
          <>
            <p className="mb-3 text-sm text-muted-foreground">{faDigits(filtered.length)} کلید در حافظه {TEAM_LABELS[team]}</p>
            <ul className="space-y-3">
              {filtered.map((row) => {
                const open = openKey === row.key;
                return (
                  <li key={row.key} className="overflow-hidden rounded-2xl border border-border bg-card shadow-surface">
                    <button
                      type="button"
                      onClick={() => setOpenKey(open ? null : row.key)}
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-start"
                    >
                      <span className="font-mono text-sm font-semibold text-foreground" dir="ltr">
                        {row.key}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {jalaliFormatter.format(new Date(row.updated_at))}
                      </span>
                    </button>
                    <div className={(open ? 'block' : 'hidden') + ' border-t border-border bg-muted/40'}>
                      <pre
                        dir="rtl"
                        className="overflow-x-auto whitespace-pre-wrap px-4 py-3 font-mono text-[13px] leading-7 text-foreground"
                      >
                        {prettyJson(row.value)}
                      </pre>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </main>
  );
}
