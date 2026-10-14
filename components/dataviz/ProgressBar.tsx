'use client';

import { faPct } from './fa';

export interface ProgressBarProps {
  /** پیشرفت ۰ تا ۱۰۰ */
  value: number;
  /** برچسب کنار درصد، مثلاً «پیشرفت چرخه» */
  label?: string;
  /** توضیح کوتاه زیر نوار */
  caption?: string;
  className?: string;
}

/**
 * نوار پیشرفت زیبا: گرادیان نرم برند به سبز، انیمیشن پر شدن، درصد فارسی.
 * در راست‌چین از راست پر می‌شود (RTL خودکار).
 */
export default function ProgressBar({
  value,
  label,
  caption,
  className = '',
}: ProgressBarProps) {
  const pct = Math.min(100, Math.max(0, value));

  return (
    <div className={className}>
      <div className="mb-2 flex items-center justify-between text-sm">
        {label ? (
          <span className="font-medium text-foreground">{label}</span>
        ) : (
          <span />
        )}
        <span className="font-bold text-brand">{faPct(pct)}</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? 'پیشرفت'}
        className="relative h-3 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="absolute inset-y-0 start-0 h-full rounded-full bg-gradient-to-l from-brand via-warning to-success transition-[width] duration-700 ease-out"
          style={{ width: `${pct}%` }}
        />
        {/* برق ملایم متحرک برای حس زنده بودن */}
        <div
          aria-hidden="true"
          className="tg-progress-shine absolute inset-y-0 start-0 h-full w-1/3 rounded-full bg-white/25 blur-[6px]"
        />
      </div>
      {caption && (
        <p className="mt-2 text-xs text-muted-foreground">{caption}</p>
      )}
    </div>
  );
}
