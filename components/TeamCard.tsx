import type { TeamName, TeamRunStatus } from '../lib/types';

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** تبدیل ارقام لاتین و جداکننده هزارگان به فارسی. */
export function faNum(value: number | string): string {
  return String(value)
    .replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)])
    .replace(/,/g, '٬');
}

const STATUS_STYLE: Record<
  TeamRunStatus,
  { label: string; dot: string; chip: string; pulse: boolean }
> = {
  pending: {
    label: 'در انتظار',
    dot: 'bg-warning',
    chip: 'bg-warning/10 text-warning',
    pulse: false,
  },
  running: {
    label: 'در حال اجرا',
    dot: 'bg-brand',
    chip: 'bg-brand/10 text-brand',
    pulse: true,
  },
  success: {
    label: 'موفق',
    dot: 'bg-success',
    chip: 'bg-success/10 text-success',
    pulse: false,
  },
  failed: {
    label: 'ناموفق',
    dot: 'bg-destructive',
    chip: 'bg-destructive/10 text-destructive',
    pulse: false,
  },
  skipped: {
    label: 'صرف‌نظر شده',
    dot: 'bg-muted-foreground',
    chip: 'bg-muted text-muted-foreground',
    pulse: false,
  },
};

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
  const style = STATUS_STYLE[status] ?? STATUS_STYLE.pending;

  return (
    <article className="flex h-full flex-col rounded-xl border border-border bg-card p-5 shadow-surface transition-transform duration-200 hover:-translate-y-0.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-card-foreground">{faName}</h3>
          <p className="mt-1 text-xs leading-6 text-muted-foreground">{mission}</p>
        </div>
        <span
          className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${style.chip}`}
        >
          <span className="relative flex h-2 w-2">
            {style.pulse && (
              <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${style.dot}`} />
            )}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${style.dot}`} />
          </span>
          {style.label}
        </span>
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

      <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
        <span className="text-xs text-muted-foreground">فراخوانی LLM</span>
        <span className="text-sm font-bold text-card-foreground">
          {faNum(llmCalls.toLocaleString('en-US'))}
        </span>
      </div>
    </article>
  );
}
