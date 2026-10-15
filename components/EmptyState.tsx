import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  /** آیکون لوکسید؛ در کاشی نرم وسط نمایش داده می‌شود */
  icon: LucideIcon;
  /** تیتر کوتاه حالت خالی */
  title: string;
  /** یک جمله راهنما برای قدم بعدی کاربر */
  description?: string;
  /** دکمه یا دکمه‌های اقدام (CTA) */
  action?: React.ReactNode;
  /** رنگ کاشی آیکون؛ پیش‌فرض خنثی */
  tint?: string;
}

/**
 * حالت خالیِ طراحی‌شده برای لیست‌ها: آیکون، متن راهنما و دکمه اقدام.
 * جایگزین پیام‌های خشک تک‌خطی؛ در همهٔ صفحه‌ها یکدست استفاده می‌شود.
 */
export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  tint = 'bg-muted text-muted-foreground',
}: EmptyStateProps) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center shadow-surface sm:py-16">
      <span
        aria-hidden="true"
        className={`mx-auto flex h-14 w-14 items-center justify-center rounded-xl ${tint}`}
      >
        <Icon size={28} strokeWidth={1.5} />
      </span>
      <h2 className="mt-4 text-base font-bold text-card-foreground">{title}</h2>
      {description && (
        <p className="mx-auto mt-2 max-w-md text-sm leading-7 text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-6 flex flex-wrap items-center justify-center gap-3">{action}</div>}
    </div>
  );
}
