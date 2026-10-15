'use client';

import Link from 'next/link';
import { PlugZap } from 'lucide-react';
import EmptyState from './EmptyState';

interface NotConnectedProps {
  /** تلاش دوباره برای بارگذاری داده */
  onRetry?: () => void;
  retrying?: boolean;
}

/**
 * وضعیت «متصل نیست»: وقتی API سوپابیس در دسترس نیست، به‌جای دادهٔ نمونه
 * (mock) این کارت صادقانه نمایش داده می‌شود.
 * راهنمای توسعه‌دهنده فقط در محیط development داخل یک details جمع‌شونده است؛
 * در پروداکشن فقط پیام تمیز + اقدام.
 */
export default function NotConnected({ onRetry, retrying = false }: NotConnectedProps) {
  return (
    <div dir="rtl">
      <EmptyState
        icon={PlugZap}
        title="به پایگاه داده متصل نیست"
        description="داشبورد به پایگاه داده وصل نشده است و داده‌ای نمایش داده نمی‌شود."
        tint="bg-warning/10 text-warning"
        action={
          <>
            {onRetry ? (
              <button
                onClick={onRetry}
                disabled={retrying}
                className="tg-btn inline-flex min-h-11 items-center justify-center rounded-xl bg-primary px-6 py-2 text-sm font-bold text-primary-foreground shadow-control hover:opacity-90 disabled:opacity-50"
              >
                {retrying ? 'در حال تلاش…' : 'تلاش دوباره'}
              </button>
            ) : undefined}
            <Link
              href="/dashboard/settings"
              className="inline-flex min-h-11 items-center justify-center rounded-xl border border-border bg-card px-6 py-2 text-sm font-medium text-foreground hover:bg-muted"
            >
              رفتن به تنظیمات
            </Link>
          </>
        }
      />
      {process.env.NODE_ENV === 'development' && (
        <details className="mx-auto mt-4 max-w-xl rounded-xl border border-border bg-card p-4 text-sm shadow-surface">
          <summary className="cursor-pointer font-bold text-foreground">
            راهنمای توسعه‌دهنده
          </summary>
          <ol className="mt-3 space-y-2.5 leading-7 text-card-foreground">
            <li className="flex gap-2">
              <span className="font-bold text-brand">۱.</span>
              <span>
                فایل <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs" dir="ltr">.env.example</code> را به{' '}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs" dir="ltr">.env.local</code> کپی کنید.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="font-bold text-brand">۲.</span>
              <span className="min-w-0">
                از داشبورد سوپابیس (تنظیمات پروژه، بخش API) این دو مقدار را در{' '}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs" dir="ltr">.env.local</code> بگذارید:
                <span className="mt-2 flex flex-col items-start gap-1.5">
                  <code className="rounded bg-muted px-2 py-1 font-mono text-xs whitespace-nowrap" dir="ltr">
                    SUPABASE_URL
                  </code>
                  <code className="rounded bg-muted px-2 py-1 font-mono text-xs whitespace-nowrap" dir="ltr">
                    SUPABASE_SERVICE_ROLE_KEY
                  </code>
                </span>
              </span>
            </li>
            <li className="flex gap-2">
              <span className="font-bold text-brand">۳.</span>
              <span>
                سرور را دوباره اجرا کنید:{' '}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs" dir="ltr">npm run dev</code>
              </span>
            </li>
          </ol>
        </details>
      )}
    </div>
  );
}
