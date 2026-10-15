'use client';

export type VizStatus =
  | 'running'
  | 'pausing'
  | 'paused'
  | 'success'
  | 'failed'
  | 'pending'
  | 'canceled'
  | 'skipped'
  | 'stopped';

const STATUS_LABEL: Record<VizStatus, string> = {
  running: 'در حال اجرا',
  pausing: 'در حال توقف…',
  paused: 'متوقف‌شده',
  success: 'موفق',
  failed: 'ناموفق',
  pending: 'در انتظار',
  canceled: 'لغوشده',
  skipped: 'صرف‌نظر شده',
  stopped: 'متوقف شد',
};

const STATUS_TONE: Record<VizStatus, string> = {
  running: 'border-warning/40 bg-warning/10 text-warning',
  pausing: 'border-warning/40 bg-warning/10 text-warning',
  paused: 'border-border bg-muted/60 text-muted-foreground',
  success: 'border-success/40 bg-success/10 text-success',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  pending: 'border-border bg-muted/60 text-muted-foreground',
  canceled: 'border-border bg-muted/60 text-muted-foreground',
  skipped: 'border-border bg-muted/60 text-muted-foreground',
  stopped: 'border-destructive/40 bg-destructive/10 text-destructive',
};

const STATUS_DOT: Record<VizStatus, string> = {
  running: 'bg-warning',
  pausing: 'bg-warning',
  paused: 'bg-muted-foreground/60',
  success: 'bg-success',
  failed: 'bg-destructive',
  pending: 'bg-muted-foreground/60',
  canceled: 'bg-muted-foreground/60',
  skipped: 'bg-muted-foreground/60',
  stopped: 'bg-destructive',
};

export interface StatusBadgeProps {
  status: VizStatus;
  /** برچسب دلخواه؛ پیش‌فرض برچسب فارسی استاندارد است. */
  label?: string;
  /** اگر true باشد نقطهٔ وضعیت حذف می‌شود. */
  noDot?: boolean;
  className?: string;
}

/**
 * بج یکدست وضعیت: کنتراست کافی در هر دو تم روشن و تیره،
 * و نقطهٔ پالس‌دار برای وضعیت «در حال اجرا».
 */
export default function StatusBadge({
  status,
  label,
  noDot = false,
  className = '',
}: StatusBadgeProps) {
  const dot = STATUS_DOT[status];
  const pulsing = status === 'running' || status === 'pausing';

  return (
    <span
      className={`inline-flex min-h-[28px] items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${STATUS_TONE[status]} ${className}`}
    >
      {!noDot && (
        <span className="relative flex h-2 w-2 shrink-0">
          {pulsing && (
            <span
              aria-hidden="true"
              className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${dot}`}
            />
          )}
          <span
            aria-hidden="true"
            className={`relative inline-flex h-2 w-2 rounded-full ${dot}`}
          />
        </span>
      )}
      {label ?? STATUS_LABEL[status]}
    </span>
  );
}
