'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  Inbox,
  Play,
  Rocket,
  RotateCw,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonPanel } from '@/components/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { faNum } from '@/lib/format';

/* ------------------------------------------------------------------ */
/*  مدل داده                                                            */
/* ------------------------------------------------------------------ */

type DeployStatus = 'queued' | 'deploying' | 'deployed' | 'failed' | 'dead';

interface DeployQueueItem {
  id: string;
  patch_id: string;
  team: string | null;
  status: DeployStatus;
  queued_at: string;
  slot_time: string;
  deployed_at: string | null;
  retry_count: number;
  last_error: string | null;
}

interface DeployStats {
  deployedToday: number;
  queued: number;
  failed: number;
  dead: number;
  capacity: number;
  usagePct: number;
}

const STATUS_FA: Record<DeployStatus, string> = {
  queued: 'در صف',
  deploying: 'در حال دیپلوی',
  deployed: 'دیپلوی شد',
  failed: 'ناموفق',
  dead: 'مرده',
};

const STATUS_VARIANT: Record<DeployStatus, 'default' | 'secondary' | 'success' | 'destructive' | 'outline'> = {
  queued: 'secondary',
  deploying: 'default',
  deployed: 'success',
  failed: 'destructive',
  dead: 'outline',
};

function tehranDateTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      timeZone: 'Asia/Tehran',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return '—';
  }
}

function unwrapPayload(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: unknown }).data;
  }
  return body;
}

/* ------------------------------------------------------------------ */
/*  صفحه                                                                 */
/* ------------------------------------------------------------------ */

export default function DeployQueuePage() {
  const [stats, setStats] = useState<DeployStats | null>(null);
  const [items, setItems] = useState<DeployQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/deploy-queue', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error((body as { error?: string }).error ?? 'خطا در خواندن صف');
      const payload = unwrapPayload(body) as { stats: DeployStats; items: DeployQueueItem[] };
      setStats(payload.stats);
      setItems(payload.items ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطای نامشخص');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const handleRetry = useCallback(
    async (id: string) => {
      setRetrying(id);
      try {
        const res = await fetch('/api/deploy-queue/retry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        if (!res.ok) {
          const body = await res.json();
          throw new Error((body as { error?: string }).error ?? 'تلاش مجدد ناموفق بود');
        }
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'خطای نامشخص');
      } finally {
        setRetrying(null);
      }
    },
    [load],
  );

  const handleProcess = useCallback(async () => {
    setProcessing(true);
    try {
      await fetch('/api/deploy-queue', { method: 'POST' });
      await load();
    } finally {
      setProcessing(false);
    }
  }, [load]);

  if (loading) return <SkeletonPanel />;

  const activeItems = items.filter((i) => ['queued', 'deploying', 'failed'].includes(i.status));
  const historyItems = items.filter((i) => ['deployed', 'dead'].includes(i.status));

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Rocket}
        title="صف دیپلوی"
        subtitle="۷۰ اسلات ثابت در ۲۴ ساعت — هر پچ تأییدشده به ترتیب (FIFO) دیپلوی می‌شود"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={load}>
              <RotateCw className="h-4 w-4" />
              به‌روزرسانی
            </Button>
            <Button size="sm" onClick={handleProcess} disabled={processing}>
              <Play className="h-4 w-4" />
              {processing ? 'در حال پردازش…' : 'پردازش دستی'}
            </Button>
          </div>
        }
      />

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* نوار سهمیه روزانه */}
      {stats && (
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Rocket className="h-5 w-5 text-primary" />
              <span className="font-semibold">پیشرفت امروز</span>
            </div>
            <span className="text-sm text-muted-foreground">
              {faNum(stats.deployedToday)} از {faNum(stats.capacity)} دیپلوی
            </span>
          </div>
          <div
            className="h-3 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={stats.usagePct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${Math.min(100, stats.usagePct)}%` }}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="h-4 w-4" />
              در صف: {faNum(stats.queued)}
            </span>
            <span className="flex items-center gap-1 text-destructive">
              <XCircle className="h-4 w-4" />
              ناموفق: {faNum(stats.failed)}
            </span>
            <span className="flex items-center gap-1">
              <AlertTriangle className="h-4 w-4" />
              مرده: {faNum(stats.dead)}
            </span>
            <span className="flex items-center gap-1 text-green-600">
              <CheckCircle2 className="h-4 w-4" />
              دیپلوی‌شده امروز: {faNum(stats.deployedToday)}
            </span>
          </div>
        </div>
      )}

      {/* صف فعال */}
      <section>
        <h2 className="mb-3 text-base font-semibold">صف فعال ({faNum(activeItems.length)})</h2>
        {activeItems.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="صف خالی است"
            description="پچ تأییدشده‌ای در انتظار دیپلوی نیست."
          />
        ) : (
          <div className="space-y-2">
            {activeItems.map((item, idx) => (
              <div
                key={item.id}
                className={`flex items-center justify-between gap-3 rounded-lg border p-3 ${
                  item.status === 'failed' ? 'border-destructive/40 bg-destructive/5' : 'border-border bg-card'
                }`}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-bold">
                    {faNum(idx + 1)}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={STATUS_VARIANT[item.status]}>{STATUS_FA[item.status]}</Badge>
                      {item.team && <span className="text-xs text-muted-foreground">{item.team}</span>}
                      {item.retry_count > 0 && (
                        <span className="text-xs text-destructive">
                          تلاش {faNum(item.retry_count + 1)}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {item.patch_id.slice(0, 8)}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      اسلات: {tehranDateTime(item.slot_time)}
                      {item.last_error && (
                        <span className="block truncate text-destructive">{item.last_error}</span>
                      )}
                    </div>
                  </div>
                </div>
                {item.status === 'failed' && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleRetry(item.id)}
                    disabled={retrying === item.id}
                  >
                    <RotateCw className="h-4 w-4" />
                    {retrying === item.id ? '…' : 'تلاش مجدد'}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* تاریخچه امروز */}
      {historyItems.length > 0 && (
        <section>
          <h2 className="mb-3 text-base font-semibold">تاریخچه ({faNum(historyItems.length)})</h2>
          <div className="space-y-2">
            {historyItems.slice(0, 20).map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3 opacity-75"
              >
                <div className="flex items-center gap-3">
                  <Badge variant={STATUS_VARIANT[item.status]}>{STATUS_FA[item.status]}</Badge>
                  {item.team && <span className="text-xs text-muted-foreground">{item.team}</span>}
                  <span className="font-mono text-xs text-muted-foreground">
                    {item.patch_id.slice(0, 8)}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {tehranDateTime(item.deployed_at ?? item.slot_time)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
