'use client';

import { Minus, TrendingDown, TrendingUp, type LucideIcon } from 'lucide-react';
import { faPct } from './fa';

export type TrendDirection = 'up' | 'down' | 'flat';

export interface StatTrend {
  /** جهت روند نسبت به دورهٔ قبل */
  dir: TrendDirection;
  /** مقدار تغییر به درصد (عدد مثبت) */
  pct: number;
  /** توضیح کوتاه دورهٔ مقایسه، مثلاً «نسبت به هفتهٔ پیش» */
  note?: string;
}

export interface StatCardProps {
  icon: LucideIcon;
  label: string;
  /** مقدار نمایشی؛ معمولاً از قبل با faNum فارسی شده */
  value: string;
  hint?: string;
  trend?: StatTrend;
  /** کلاس رنگ آیکون، مثلاً 'bg-brand/10 text-brand' */
  tint?: string;
  className?: string;
}

const TREND_TONE: Record<TrendDirection, string> = {
  up: 'bg-success/10 text-success',
  down: 'bg-destructive/10 text-destructive',
  flat: 'bg-muted text-muted-foreground',
};

const TREND_ICON: Record<TrendDirection, LucideIcon> = {
  up: TrendingUp,
  down: TrendingDown,
  flat: Minus,
};

/**
 * کارت آماری: آیکون، عدد بزرگ فارسی، نشانگر روند و توضیح کوتاه.
 * سلسله‌مراتب: عدد اول، بعد لیبل، بعد روند و راهنما.
 */
export default function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  trend,
  tint = 'bg-brand/10 text-brand',
  className = '',
}: StatCardProps) {
  const TrendIcon = trend ? TREND_ICON[trend.dir] : null;

  return (
    <div
      className={`rounded-2xl border border-border bg-card p-4 shadow-[var(--shadow-control)] ${className}`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tint}`}
        >
          <Icon size={20} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-3xl font-extrabold leading-tight md:text-4xl"
            dir="auto"
          >
            {value}
          </div>
          <div className="mt-0.5 truncate text-sm font-medium text-muted-foreground">
            {label}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        {trend && TrendIcon ? (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${TREND_TONE[trend.dir]}`}
          >
            <TrendIcon size={14} strokeWidth={2.25} />
            {faPct(trend.pct)}
          </span>
        ) : (
          <span />
        )}
        <p className="truncate text-xs text-muted-foreground">
          {trend?.note ?? hint ?? ''}
        </p>
      </div>
    </div>
  );
}
