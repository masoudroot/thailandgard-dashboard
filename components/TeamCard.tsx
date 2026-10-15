import { useState } from 'react';
import Link from 'next/link';
import type { TeamName, TeamRunStatus } from '../lib/types';
import StatusBadge from './dataviz/StatusBadge';
import { faNum } from '@/lib/format';
import { Dialog } from './ui/dialog';
import { Button } from './ui/Button';

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

/** ترجمه خطاهای فنی به فارسی روان برای نمایش. */
function faError(error: string): string {
  const e = error.toLowerCase();
  if (e.includes('not valid json') || e.includes('invalid json')) {
    return 'مدل پاسخ نامعتبر داد؛ در چرخهٔ بعد دوباره تلاش می‌شود.';
  }
  if (e.includes('timeout') || e.includes('timed out')) {
    return 'پاسخ مدل طول کشید و قطع شد؛ در چرخهٔ بعد دوباره تلاش می‌شود.';
  }
  if (e.includes('429') || e.includes('rate limit')) {
    return 'سهمیهٔ درگاه تمام شد؛ در چرخهٔ بعد دوباره تلاش می‌شود.';
  }
  if (e.includes('404')) {
    return 'مدل روی درگاه پیدا نشد؛ نام مدل را در تنظیمات بررسی کنید.';
  }
  if (e.includes('401') || e.includes('403') || e.includes('unauthorized')) {
    return 'کلید درگاه معتبر نیست؛ تنظیمات اتصال را بررسی کنید.';
  }
  if (e.includes('500') || e.includes('502') || e.includes('503')) {
    return 'درگاه فعلاً پاسخ نمی‌دهد؛ در چرخهٔ بعد دوباره تلاش می‌شود.';
  }
  return error;
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
  const [open, setOpen] = useState(false);
  const hasMore = !!outputSummary || !!error;
  return (
    <>
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
          <div>
            <p className="line-clamp-3 text-sm leading-7 text-card-foreground/90">
              {outputSummary}
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOpen(true)}
              className="mt-1 h-auto p-0 text-xs text-brand hover:underline"
            >
              مشاهده کامل
            </Button>
          </div>
        ) : (
          <p className="text-sm leading-7 text-muted-foreground">
            هنوز خروجی ثبت نشده است.
          </p>
        )}
        {status === 'failed' && error && (
          <p className="mt-2 line-clamp-2 text-xs leading-6 text-destructive">
            {faError(error)}
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

    <Dialog
      open={open}
      onOpenChange={setOpen}
      title={`${faName} — جزئیات خروجی`}
      footer={
        <Button variant="outline" onClick={() => setOpen(false)}>
          بستن
        </Button>
      }
    >
      <div className="max-h-[60vh] space-y-4 overflow-y-auto">
        <div>
          <p className="mb-1 text-xs font-bold text-muted-foreground">وضعیت</p>
          <StatusBadge status={status} />
        </div>
        {outputSummary && (
          <div>
            <p className="mb-1 text-xs font-bold text-muted-foreground">خروجی</p>
            <p className="whitespace-pre-wrap text-sm leading-7 text-card-foreground">
              {outputSummary}
            </p>
          </div>
        )}
        {error && (
          <div>
            <p className="mb-1 text-xs font-bold text-muted-foreground">خطا</p>
            <p className="whitespace-pre-wrap text-sm leading-7 text-destructive">
              {faError(error)}
            </p>
          </div>
        )}
        <div className="flex items-center justify-between border-t border-border pt-3">
          <span className="text-xs text-muted-foreground">فراخوانی LLM</span>
          <span className="text-sm font-bold">{faNum(llmCalls.toLocaleString('en-US'))}</span>
        </div>
      </div>
    </Dialog>
    </>
  );
}
