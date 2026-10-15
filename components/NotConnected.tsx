'use client';

import { PlugZap } from 'lucide-react';
import EmptyState from './EmptyState';

interface NotConnectedProps {
  /** تلاش دوباره برای بارگذاری داده */
  onRetry?: () => void;
  retrying?: boolean;
}

/**
 * وضعیت «متصل نیست»: وقتی API سوپابیس در دسترس نیست، به‌جای دادهٔ نمونه
 * (mock) این کارت صادقانه نمایش داده می‌شود با راهنمای گام‌به‌گام اتصال.
 */
export default function NotConnected({ onRetry, retrying = false }: NotConnectedProps) {
  return (
    <div dir="rtl">
      <EmptyState
        icon={PlugZap}
        title="به پایگاه داده متصل نیست"
        description="داشبورد به سوپابیس وصل نشده است؛ پس هیچ داده‌ای نمایش داده نمی‌شود. برای اتصال:"
        tint="bg-warning/10 text-warning"
        action={
          onRetry ? (
            <button
              onClick={onRetry}
              disabled={retrying}
              className="tg-btn inline-flex min-h-[44px] items-center justify-center rounded-xl bg-brand px-6 py-2 text-sm font-bold text-brand-foreground shadow-control hover:opacity-90 disabled:opacity-50"
            >
              {retrying ? 'در حال تلاش…' : 'تلاش دوباره'}
            </button>
          ) : undefined
        }
      />
      <ol className="mx-auto mt-4 max-w-xl space-y-2.5 rounded-2xl border border-border bg-card p-4 text-sm leading-7 text-card-foreground shadow-surface sm:p-5">
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
    </div>
  );
}
