import type { TeamName, TeamRunStatus } from '../lib/types';
import StatusBadge from './dataviz/StatusBadge';

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** تبدیل ارقام لاتین و جداکننده هزارگان به فارسی. */
export function faNum(value: number | string): string {
  return String(value)
    .replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)])
    .replace(/,/g, '٬');
}

export interface TeamCardProps {
  team: TeamName;
  faName: string;
  mission: string;
  status: TeamRunStatus;
  outputSummary: string | null;
  llmCalls: number;
  error?: string | null;
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
}: TeamCardProps) {
  return (
    <article className="flex h-full min-w-0 flex-col rounded-xl border border-border bg-card p-4 shadow-surface transition-transform duration-200 active:scale-[0.99] sm:p-5 hover:sm:-translate-y-0.5">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-bold text-card-foreground">{faName}</h3>
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
