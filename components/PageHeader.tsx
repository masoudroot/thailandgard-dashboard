import type { LucideIcon } from 'lucide-react';

interface PageHeaderProps {
  /** آیکون لوکسید صفحه */
  icon: LucideIcon;
  /** تیتر صفحه */
  title: string;
  /** زیرتیتر توضیحی */
  subtitle?: string;
  /** رنگ کاشی آیکون؛ پیش‌فرض لهجهٔ برند */
  tint?: string;
  /** دکمه‌ها و کنترل‌های سمت چپ سربرگ */
  actions?: React.ReactNode;
}

/**
 * سربرگ یکدست صفحه‌های داشبورد: کاشی آیکون، تیتر، زیرتیتر و اقدامات.
 * در موبایل روی هم می‌چینند و در دسکتاپ در یک ردیف می‌نشینند.
 */
export default function PageHeader({
  icon: Icon,
  title,
  subtitle,
  tint = 'bg-brand/10 text-brand',
  actions,
}: PageHeaderProps) {
  return (
    <header className="mb-6 md:mb-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${tint}`}
          >
            <Icon size={22} strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-foreground sm:text-2xl">{title}</h1>
            {subtitle && (
              <p className="mt-1 text-sm leading-7 text-muted-foreground">{subtitle}</p>
            )}
          </div>
        </div>
        {actions && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
    </header>
  );
}
