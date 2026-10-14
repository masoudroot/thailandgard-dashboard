/**
 * اسکلت‌های لودینگ داشبورد: به‌جای اسپینر خشک، برق ملایم روی قالب واقعی.
 * همه از کلاس tg-shimmer در interactions.css استفاده می‌کنند و با
 * prefers-reduced-motion ثابت می‌مانند.
 */

function cx(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export interface SkeletonProps {
  /** کلاس‌های ابعاد و گردی، مثل "h-4 w-24 rounded" */
  className?: string;
  label?: string;
}

/** بلوک پایه اسکلت */
export function Skeleton({ className, label }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      role={label ? undefined : "presentation"}
      aria-label={label}
      className={cx("tg-shimmer", className)}
    />
  );
}

/** چند خط متن پشت سر هم با پهنای طبیعی */
export function SkeletonLines({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div aria-hidden="true" className={cx("space-y-2", className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={cx(
            "h-3 rounded-full",
            i === lines - 1 ? "w-2/3" : "w-full",
          )}
        />
      ))}
    </div>
  );
}

/** اسکلت کارت آمار (چهارتایی صفحه خانه) */
export function SkeletonStat({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cx(
        "rounded-2xl border border-border bg-card p-4",
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-7 w-16 rounded-lg" />
          <Skeleton className="h-3 w-24 rounded-full" />
        </div>
      </div>
      <Skeleton className="mt-3 h-3 w-20 rounded-full" />
    </div>
  );
}

/** اسکلت کارت تیم */
export function SkeletonTeamCard({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cx(
        "flex h-full min-w-0 flex-col rounded-xl border border-border bg-card p-4 sm:p-5",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-5 w-28 rounded-lg" />
          <Skeleton className="h-3 w-full rounded-full" />
          <Skeleton className="h-3 w-4/5 rounded-full" />
        </div>
        <Skeleton className="h-8 w-20 shrink-0 rounded-full" />
      </div>
      <div className="mt-4 flex-1">
        <SkeletonLines lines={2} />
      </div>
      <div className="mt-4 border-t border-border pt-3">
        <Skeleton className="h-4 w-24 rounded-full" />
      </div>
    </div>
  );
}

/** اسکلت یک ردیف هشدار/لیست */
export function SkeletonRow({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cx(
        "flex gap-3 rounded-2xl border border-border p-3",
        className,
      )}
    >
      <Skeleton className="h-9 w-9 shrink-0 rounded-xl" />
      <div className="min-w-0 flex-1 space-y-2 pt-1">
        <Skeleton className="h-4 w-3/4 rounded-lg" />
        <Skeleton className="h-3 w-full rounded-full" />
        <Skeleton className="h-3 w-1/3 rounded-full" />
      </div>
    </div>
  );
}

/** اسکلت جدول: سرستون و چند ردیف */
export function SkeletonTable({
  rows = 5,
  columns = 4,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      role="presentation"
      className={cx("overflow-hidden rounded-2xl border border-border", className)}
    >
      <div className="grid gap-2 border-b border-border bg-muted/60 p-4" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-3 rounded-full" />
        ))}
      </div>
      <div className="divide-y divide-border bg-card">
        {Array.from({ length: rows }).map((_, r) => (
          <div
            key={r}
            className="grid gap-2 p-4"
            style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
          >
            {Array.from({ length: columns }).map((_, c) => (
              <Skeleton
                key={c}
                className={cx(
                  "h-4 rounded-full",
                  c === 0 ? "w-3/4" : "w-full",
                )}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** اسکلت بخش بزرگ (جایگزین بلوک‌های h-64 و h-40 خشک) */
export function SkeletonPanel({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cx("rounded-2xl border border-border bg-card p-5", className)}
    >
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-6 w-40 rounded-lg" />
        <Skeleton className="h-8 w-24 rounded-full" />
      </div>
      <Skeleton className="mt-5 h-3 w-full rounded-full" />
      <div className="mt-6 space-y-3">
        <SkeletonLines lines={3} />
      </div>
    </div>
  );
}
