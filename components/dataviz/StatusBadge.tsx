'use client';

import { Badge } from '../ui/Badge';

type RegistryBadgeVariant =
  | 'default'
  | 'secondary'
  | 'outline'
  | 'success'
  | 'warning'
  | 'brand'
  | 'destructive';

export type VizStatus =
  | 'running'
  | 'pausing'
  | 'paused'
  | 'success'
  | 'failed'
  | 'rejected'
  | 'pending'
  | 'canceled'
  | 'skipped'
  | 'stopped';

const STATUS_LABEL: Record<VizStatus, string> = {
  running: 'در حال اجرا',
  pausing: 'در حال توقف…',
  paused: 'متوقف‌شده',
  success: 'موفق',
  failed: 'خطای سیستمی',
  rejected: 'رد شده توسط منتقد',
  pending: 'در انتظار',
  canceled: 'لغو شد',
  skipped: 'صرف‌نظر شده',
  stopped: 'متوقف شد',
};

/** نگاشت وضعیت به واریانت بج رجیستری وایب‌فارسی. */
const STATUS_VARIANT: Record<VizStatus, RegistryBadgeVariant> = {
  running: 'warning',
  pausing: 'warning',
  paused: 'secondary',
  success: 'success',
  failed: 'destructive',
  rejected: 'warning',
  pending: 'secondary',
  canceled: 'secondary',
  skipped: 'secondary',
  stopped: 'destructive',
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
 * بج یکدست وضعیت؛ روی بج رجیستری وایب‌فارسی سوار است و API قبلی را حفظ می‌کند.
 * نقطهٔ پالس‌دار «در حال اجرا» رفتار ویژهٔ همین کامپوننت است و دستی مانده.
 */
export default function StatusBadge({
  status,
  label,
  noDot = false,
  className = '',
}: StatusBadgeProps) {
  const pulsing = status === 'running' || status === 'pausing';

  return (
    <Badge variant={STATUS_VARIANT[status]} className={className}>
      {!noDot && (
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
          {pulsing && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
          )}
          <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
        </span>
      )}
      {label ?? STATUS_LABEL[status]}
    </Badge>
  );
}
