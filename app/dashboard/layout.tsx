import Nav, { MobileMenu } from "@/components/Nav";

/**
 * لی‌اوت داشبورد: سایدبار راست (نخستین فرزند در فلکس، یعنی سمت شروع در راست‌چین)
 * و محتوای اصلی با هدر بالایی ثابت.
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh bg-background font-sans text-foreground antialiased">
      {/* سایدبار دسکتاپ */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 border-e border-border bg-card lg:block">
        <Nav />
      </aside>

      {/* ستون محتوا */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 border-b border-border bg-background/95 pt-[env(safe-area-inset-top)] backdrop-blur">
          <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between px-4 lg:h-16 lg:px-6">
            <h1 className="text-base font-bold leading-7 lg:text-lg">
              <span className="lg:hidden">داشبورد</span>
              <span className="hidden lg:inline">
                داشبورد ایجنتیک تایلندگرد
              </span>
            </h1>
            {/* ناوبری جمع‌وجور برای موبایل و تبلت */}
            <MobileMenu />
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 lg:px-6 lg:py-8">
          {children}
          {/* فاصله‌گذار برای ناوبری پایینی موبایل (قرارداد با تیم ناوبری) */}
          <div
            aria-hidden="true"
            className="pb-[calc(6rem+env(safe-area-inset-bottom))] lg:pb-8"
          />
        </main>

        <footer className="border-t border-border">
          <div className="mx-auto flex w-full max-w-7xl flex-col items-center gap-1 px-4 py-3 sm:flex-row sm:justify-between sm:px-6 sm:py-4 lg:px-6">
            <p className="text-xs leading-5 text-muted-foreground">
              داشبورد ایجنتیک تایلندگرد
            </p>
            <p className="hidden text-xs leading-5 text-muted-foreground sm:block">
              نسخهٔ ۱
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
}
