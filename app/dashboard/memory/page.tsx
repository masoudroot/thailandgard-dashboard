'use client';

import { useEffect, useMemo, useState } from 'react';
import { Brain, History, SearchX, WifiOff } from 'lucide-react';
import { TEAMS, type TeamName } from '@/lib/types';
import { EmptyState } from '@/components/ui/empty-state';
import PageHeader from '@/components/PageHeader';
import { SkeletonLines, SkeletonPanel } from '@/components/Skeleton';
import { faDigits } from "@/lib/format";
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { Field } from '@/components/ui/Input';
import { SearchInput } from '@/components/ui/search-input';
import { Collapsible } from '@/components/ui/collapsible';

/** نام‌های فارسی خوانا برای تیم‌ها */
const TEAM_LABELS: Record<TeamName, string> = {
  leader: 'رهبر',
  artdir: 'طراحی ارشد',
  branding: 'برند',
  content: 'محتوا',
  seo: 'سئو',
  analytics: 'تحلیل',
  intel: 'اطلاعات',
  lead: 'لید',
  design: 'دیزاین',
  seocontent: 'محتوای سئو',
  vibefarsi: 'وایب‌فارسی',
  farsiui: 'فارسی UI',
  'design-ir': 'دیزاین ایرانی',
  dev: 'توسعه',
  qa: 'کیفیت',
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


const jalaliFormatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** تلاش برای parse رشته به‌عنوان JSON؛ در صورت شکست، خود رشته برمی‌گردد */
function tryParseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return value;
  try {
    return JSON.parse(t);
  } catch {
    return value;
  }
}

/** باز کردن JSONهای تودرتو (مثل content که خودش رشته JSON است)؛ حداکثر ۳ سطح */
function deepParse(value: unknown, depth = 0): unknown {
  if (depth > 3) return value;
  const parsed = tryParseJson(value);
  if (parsed !== value && (typeof parsed === 'object' && parsed !== null)) {
    if (Array.isArray(parsed)) return parsed.map((v) => deepParse(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      out[k] = deepParse(v, depth + 1);
    }
    return out;
  }
  return parsed;
}

/** لیبل فارسی برای کلیدهای رایج حافظه */
function faLabel(key: string): string {
  const map: Record<string, string> = {
    approved: 'تأیید شده',
    reason: 'دلیل',
    payload: 'جزئیات',
    status: 'وضعیت',
    summary: 'خلاصه',
    run_id: 'شناسه اجرا',
    content: 'محتوا',
    no_data: 'بدون داده',
  };
  return map[key] ?? key;
}

/** نمایش یک مقدار ساده */
function PlainValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">-</span>;
  if (typeof value === 'boolean')
    return (
      <span className={value ? 'font-medium text-success' : 'font-medium text-destructive'}>
        {value ? 'بله' : 'خیر'}
      </span>
    );
  return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
}

/** رندر تمیز یک مقدار حافظه: آبجکت ← فهرست مرتب، رشته ← متن ساده */
function MemoryValue({ value }: { value: unknown }) {
  const parsed = deepParse(value);
  if (parsed !== null && typeof parsed === 'object') {
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-muted-foreground">خالی</span>;
    return (
      <dl className="space-y-2.5">
        {entries.map(([k, v]) => (
          <div key={k} className="rounded-lg bg-background px-3 py-2">
            <dt className="text-xs font-medium text-muted-foreground">{faLabel(k)}</dt>
            <dd className="mt-0.5 text-sm leading-7 text-foreground">
              {v !== null && typeof v === 'object' ? (
                <MemoryValue value={v} />
              ) : (
                <PlainValue value={v} />
              )}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <p className="whitespace-pre-wrap break-words text-sm leading-7 text-foreground">
      <PlainValue value={parsed} />
    </p>
  );
}

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
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className="px-4 py-3"
        trigger={
          <span className="flex w-full items-center justify-between gap-3 text-start">
            <span className="min-w-0">
              <span className="block truncate text-left font-mono text-sm font-semibold text-foreground" dir="ltr">
                {row.key}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {TEAM_LABELS[row.team]} · {jalaliFormatter.format(new Date(row.updated_at))}
              </span>
            </span>
          </span>
        }
      >
        <div className="border-t border-border bg-muted/40 px-4 py-3">
          <MemoryValue value={row.value} />
          <div className="border-t border-border px-4 py-3">
            <Collapsible
              open={historyOpen}
              onOpenChange={(next) => {
                setHistoryOpen(next);
                if (next) void loadHistory();
              }}
              trigger={
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-brand">
                  <History size={14} strokeWidth={2} aria-hidden="true" />
                  {historyOpen ? 'بستن تاریخچه' : 'مشاهدهٔ تاریخچهٔ این رکورد'}
                </span>
              }
            >
              <div className="mt-3 space-y-2">
                {historyLoading && (<div aria-busy="true"><SkeletonLines lines={2} /><span className="sr-only">در حال بارگذاری…</span></div>)}
                {!historyLoading && history !== null && history.length === 0 && (
                  <p className="text-xs leading-6 text-muted-foreground">
                    برای این رکورد نسخهٔ قبلی ثبت نشده است.
                  </p>
                )}
                {!historyLoading &&
                  history !== null &&
                  history.map((h, i) => (
                    <div key={i} className="rounded-lg border border-border bg-card p-3">
                      <p className="mb-1 text-xs text-muted-foreground">
                        نسخهٔ {faDigits(history.length - i)} · {jalaliFormatter.format(new Date(h.superseded_at))}
                      </p>
                      <MemoryValue value={h.value} />
                    </div>
                  ))}
              </div>
            </Collapsible>
          </div>
        </div>
      </Collapsible>
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
    <div className="mx-auto w-full max-w-4xl">
        <PageHeader
          icon={Brain}
          title="حافظه"
          subtitle="حافظهٔ بلندمدت تیم‌ها؛ جست‌وجو در متن، فیلتر تیم و تاریخچهٔ هر رکورد"
        />

        <div className="mb-6 flex flex-col gap-3 sm:flex-row">
          <Field label="تیم" className="flex-1">
            <Select
              value={team}
              onChange={(e) => setTeam(e.target.value as TeamFilter)}
              options={[
                { value: 'all', label: 'همهٔ تیم‌ها' },
                ...TEAMS.map((t) => ({
                  value: t,
                  label: `${TEAM_LABELS[t]} (${t})`,
                })),
              ]}
            />
          </Field>

          <Field label="جست‌وجو در متن" className="flex-1">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="کلید یا محتوای مقدار…"
              aria-label="جست‌وجو در متن حافظه"
            />
          </Field>
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
            title="به پایگاه داده متصل نیست"
            description="حافظه بارگذاری نشد. اتصال را بررسی کنید و دوباره تلاش کنید. هیچ دادهٔ نمایشی نشان داده نمی‌شود."
            action={
              <Button variant="outline" onClick={() => window.location.reload()}>
                تلاش دوباره
              </Button>
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
                  <Button variant="outline" onClick={() => setQuery('')}>
                    پاک کردن جست‌وجو
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={Brain}
                title="رکوردی ثبت نشده است"
                description="بعد از اولین اجرای تیم‌ها در چرخه، حافظهٔ بلندمدت همین‌جا نمایش داده می‌شود."
              />
            )
          ) : (
            <>
              <Badge variant="secondary" className="mb-3">
                {faDigits(filtered.length)} رکورد
                {team !== 'all' && ` در حافظه ${TEAM_LABELS[team as TeamName]}`}
              </Badge>
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
