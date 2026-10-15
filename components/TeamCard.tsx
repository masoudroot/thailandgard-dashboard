import Link from 'next/link';
import type { TeamName, TeamRunStatus } from '../lib/types';
import StatusBadge from './dataviz/StatusBadge';
import { faNum } from '@/lib/format';

export { faNum };

export interface TeamCardProps {
  team: TeamName;
  faName: string;
  mission: string;
  status: TeamRunStatus;
  outputSummary: string | null;
  llmCalls: number;
  error?: string | null;
  /** اگر داده شود، نام تیم به صفحه‌ی جزئیات/گزارش‌های تیم لینک می‌شود. */
  detailHref?: string;
}

/**
 * کارت یک تیم ایجنتیک: نام فارسی، مأموریت، وضعیت آخرین اجرا،
 * خلاصه خروجی و تعداد فراخوانی LLM.
 */
export default function TeamCard({
  faName,
  mission,
  status,
  outputSummary,
  llmCalls,
  error,
  detailHref,
}: TeamCardProps) {
  return (
    <article className="tg-card flex h-full min-w-0 flex-col rounded-xl border border-border bg-card p-4 shadow-surface sm:p-5">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-bold text-card-foreground">
            {detailHref ? (
              <Link href={detailHref} className="hover:text-brand hover:underline">
                {faName}
              </Link>
            ) : (
              faName
            )}
          </h3>
          <p className="mt-1 line-clamp-2 text-xs leading-6 text-muted-foreground">
            {mission}
          </p>
        </div>
        <div className="shrink-0">
          <StatusBadge status={status} />
        </div>
      </div>

      <div className="mt-4 flex-1">
        {outputSummary ? (
          <p className="line-clamp-3 text-sm leading-7 text-card-foreground/90">
            {outputSummary}
          </p>
        ) : (
          <p className="text-sm leading-7 text-muted-foreground">
            هنوز خروجی ثبت نشده است.
          </p>
        )}
        {status === 'failed' && error && (
          <p className="mt-2 line-clamp-2 text-xs leading-6 text-destructive">
            {error}
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <span className="text-xs text-muted-foreground">فراخوانی LLM</span>
        <span className="text-sm font-bold text-card-foreground">
          {faNum(llmCalls.toLocaleString('en-US'))}
        </span>
      </div>
    </article>
  );
}
