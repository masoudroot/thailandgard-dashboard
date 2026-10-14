'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Moon, Sun } from 'lucide-react';

/* تاگل سادهٔ تم: فقط کلاس dark روی html و ذخیره در localStorage.
   اسکریپت layout هنگام لود، انتخاب ذخیره‌شده (یا prefers-color-scheme) را اعمال می‌کند. */
function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('tg-theme', next ? 'dark' : 'light');
    } catch {
      /* ذخیره‌سازی در دسترس نیست؛ تم فقط برای همین نشست اعمال می‌شود */
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? 'حالت روشن' : 'حالت تیره'}
      className="touch-target rounded-full border border-border bg-card text-muted-foreground shadow-control transition-soft hover:text-foreground"
    >
      {dark ? <Sun size={20} /> : <Moon size={20} />}
    </button>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) {
      setError('رمز عبور را وارد کنید.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        router.push('/dashboard');
        router.refresh();
      } else {
        setError(data.error ?? 'رمز عبور اشتباه است. دوباره تلاش کنید.');
      }
    } catch {
      setError('خطای اتصال. لطفاً دوباره تلاش کنید.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      dir="rtl"
      className="min-h-dvh flex bg-background pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] ps-4 pe-4"
    >
      <div className="absolute top-[max(1rem,env(safe-area-inset-top))] end-4">
        <ThemeToggle />
      </div>

      <div className="m-auto w-full max-w-sm animate-fade-in">
        <div className="rounded-2xl bg-card border border-border p-6 sm:p-8 shadow-surface">
          <div className="flex items-center gap-3 mb-6">
            <span
              aria-hidden="true"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand text-xl font-bold text-brand-foreground"
            >
              ت
            </span>
            <div>
              <h1 className="text-xl font-bold text-card-foreground">ورود به داشبورد</h1>
              <p className="text-sm text-muted-foreground">داشبورد ایجنتیک تایلندگرد</p>
            </div>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-card-foreground mb-1.5"
              >
                رمز عبور
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                enterKeyHint="go"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-12 w-full rounded-lg border border-input bg-background px-4 text-base text-foreground placeholder:text-muted-foreground outline-none transition-soft focus:border-ring focus:ring-2 focus:ring-ring/30"
                placeholder="رمز عبور مدیر"
                dir="ltr"
              />
            </div>

            {error && (
              <p
                role="alert"
                className="tg-shake rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm leading-7 text-destructive"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="tg-btn touch-target h-12 w-full rounded-lg bg-brand px-4 text-base font-semibold text-brand-foreground hover:brightness-95 active:brightness-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'در حال بررسی…' : 'ورود'}
            </button>
          </form>
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          دسترسی محدود به تیم تایلندگرد
        </p>
      </div>
    </main>
  );
}
