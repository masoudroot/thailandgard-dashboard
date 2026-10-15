'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, TrendingUp, Settings2 } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import EmptyState from '@/components/EmptyState';
import { SkeletonLines } from '@/components/Skeleton';
import { Switch } from '@/components/ui/Switch';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { TimePicker } from '@/components/ui/time-picker';
import { faNum } from '@/lib/format';
import { KEY_CURRENCIES, type NavasanItem, type RatesSchedule } from '@/lib/rates';

const jalaliDate = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

interface RatesPayload {
  latest: { fetchedAt: string; rates: Record<string, NavasanItem> } | null;
  previous: Record<string, NavasanItem> | null;
  history: Array<{ fetchedAt: string; rates: Record<string, NavasanItem> }>;
  schedule: RatesSchedule;
}

function toNum(v: string | number | undefined): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** نمودار خطی ساده‌ی تاریخچه‌ی یک ارز */
function RateChart({ history, symbol }: { history: RatesPayload['history']; symbol: string }) {
  const points = history
    .map((h) => ({ at: h.fetchedAt, v: toNum(h.rates[symbol]?.value) }))
    .filter((p) => p.v !== null) as Array<{ at: string; v: number }>;
  if (points.length < 2) return null;
  const W = 600;
  const H = 160;
  const PAD = 12;
  const min = Math.min(...points.map((p) => p.v));
  const max = Math.max(...points.map((p) => p.v));
  const span = max - min || 1;
  const xy = points.map((p, i) => {
    const x = PAD + (i / (points.length - 1)) * (W - PAD * 2);
    const y = H - PAD - ((p.v - min) / span) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <div dir="ltr" className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full min-w-[480px]" role="img" aria-label="نمودار تاریخچه">
        <polyline points={xy.join(' ')} fill="none" stroke="currentColor" strokeWidth="2" className="text-brand" />
        {xy.map((pt, i) => {
          const [x, y] = pt.split(',');
          return <circle key={i} cx={x} cy={y} r="3" className="fill-brand" />;
        })}
      </svg>
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{faNum(max.toLocaleString('en-US'))}</span>
        <span>{faNum(min.toLocaleString('en-US'))}</span>
      </div>
    </div>
  );
}

export default function RatesPage() {
  const [data, setData] = useState<RatesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState<string | null>(null);
  const [times, setTimes] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/rates', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok || body?.ok === false) throw new Error(body?.error?.message ?? 'خواندن نرخ‌ها ناموفق بود.');
      const d = body.data as RatesPayload;
      setData(d);
      setTimes(d.schedule.times);
      setEnabled(d.schedule.enabled);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleFetch() {
    setFetching(true);
    setFetchMsg(null);
    try {
      const res = await fetch('/api/rates/fetch', { method: 'POST' });
      const body = await res.json();
      if (!res.ok || body?.ok === false) throw new Error(body?.error?.message ?? 'دریافت نرخ‌ها ناموفق بود.');
      setFetchMsg('نرخ‌ها به‌روز شد.');
      await load();
    } catch (err) {
      setFetchMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setFetching(false);
    }
  }

  async function handleSaveSchedule() {
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch('/api/rates/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, times }),
      });
      const body = await res.json();
      if (!res.ok || body?.ok === false) throw new Error(body?.error?.message ?? 'ذخیره ناموفق بود.');
      setSaveMsg('تنظیمات ذخیره شد.');
      await load();
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function setTimeAt(i: number, v: string) {
    setTimes((t) => t.map((x, j) => (j === i ? v : x)));
  }

  const latest = data?.latest;

  return (
    <div>
      <PageHeader
        icon={TrendingUp}
        title="نرخ ارز"
        subtitle="ربات نرخ ارز؛ ۴ بار در روز از نوسان می‌خواند"
        actions={
          <Button
            variant="default"
            onClick={handleFetch}
            disabled={fetching}
            aria-busy={fetching || undefined}
          >
            {fetching ? (
              'در حال دریافت…'
            ) : (
              <>
                <RefreshCw size={15} strokeWidth={2} aria-hidden="true" />
                دریافت دستی
              </>
            )}
          </Button>
        }
      />

      {loading ? (
        <div aria-busy="true">
          <SkeletonLines lines={4} />
          <span className="sr-only">در حال بارگذاری…</span>
        </div>
      ) : error ? (
        <EmptyState icon={TrendingUp} title="خطا" description={error} />
      ) : !latest ? (
        <EmptyState
          icon={TrendingUp}
          title="هنوز نرخی ثبت نشده"
          description="ربات هنوز اولین خوانش را انجام نداده است. با «دریافت دستی» اولین نرخ‌ها را بگیرید."
        />
      ) : (
        <div className="space-y-6">
          <p className="text-xs text-muted-foreground">
            آخرین به‌روزرسانی: {jalaliDate.format(new Date(latest.fetchedAt))}
          </p>
          {fetchMsg && (
            <p role="status" className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
              {fetchMsg}
            </p>
          )}

          {/* جدول نرخ‌های مهم */}
          <section aria-label="نرخ‌های مهم">
            <h2 className="mb-2 text-sm font-bold text-foreground">نرخ‌های مهم</h2>
            <ul className="space-y-2">
              {KEY_CURRENCIES.map(({ symbol, faName }) => {
                const item = latest.rates[symbol];
                const prev = data?.previous?.[symbol];
                const v = toNum(item?.value);
                const pv = toNum(prev?.value);
                const diff = v !== null && pv !== null ? v - pv : null;
                return (
                  <li
                    key={symbol}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-bold text-foreground">{faName}</p>
                      <p className="text-xs text-muted-foreground">تومان</p>
                    </div>
                    <div className="text-left">
                      <p className="text-base font-bold tabular-nums text-foreground">
                        {v !== null ? faNum(v.toLocaleString('en-US')) : 'در دسترس نیست'}
                      </p>
                      {diff !== null && diff !== 0 && (
                        <p
                          className={`text-xs tabular-nums ${diff > 0 ? 'text-destructive' : 'text-success'}`}
                        >
                          {diff > 0 ? '▲' : '▼'} {faNum(Math.abs(diff).toLocaleString('en-US'))} نسبت به دفعه قبل
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* نمودار دلار */}
          {data && data.history.length >= 2 && (
            <Card aria-label="نمودار دلار" className="px-4 py-4">
              <h2 className="mb-3 text-sm font-bold text-foreground">روند دلار تهران (۷ روز)</h2>
              <RateChart history={data.history} symbol="usd_sell" />
            </Card>
          )}

          {/* تنظیمات */}
          <Card aria-label="تنظیمات ربات" className="px-4 py-4">
            <h2 className="mb-1 flex items-center gap-1.5 text-sm font-bold text-foreground">
              <Settings2 size={15} strokeWidth={2} aria-hidden="true" />
              تنظیمات ربات
            </h2>
            <p className="mb-4 text-xs leading-6 text-muted-foreground">
              ساعت‌های خوانش روزانه به وقت تهران. کلید نوسان روزانه ۴ بار خوانش می‌دهد.
            </p>
            <div className="mb-4 flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-foreground">ربات فعال باشد</span>
              <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="فعال بودن ربات نرخ ارز" />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {times.map((t, i) => (
                <div key={i}>
                  <label htmlFor={`rate-time-${i}`} className="mb-1.5 block text-xs text-muted-foreground">
                    خوانش {faNum(i + 1)}
                  </label>
                  {/* TimePicker کنترل‌نشده است: مقدار ناقص حین تایپ نباید times را پاک کند؛
                      فقط ساعت کامل «HH:mm» به والد برمی‌گردد. */}
                  <TimePicker
                    id={`rate-time-${i}`}
                    defaultValue={t}
                    clearable={false}
                    onChange={(v) => {
                      if (v !== null) setTimeAt(i, v);
                    }}
                  />
                </div>
              ))}
            </div>
            <Button
              variant="default"
              onClick={handleSaveSchedule}
              disabled={saving}
              aria-busy={saving || undefined}
              className="mt-4"
            >
              {saving ? 'در حال ذخیره…' : 'ذخیره تنظیمات'}
            </Button>
            {saveMsg && (
              <p role="status" className="mt-2 text-sm text-muted-foreground">
                {saveMsg}
              </p>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
