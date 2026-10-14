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
        <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
          <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-6">
            <h1 className="text-lg font-bold leading-7">
              داشبورد ایجنتیک تایلندگرد
            </h1>
            {/* ناوبری جمع‌وجور برای موبایل و تبلت */}
            <MobileMenu />
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">
          {children}
        </main>

        <footer className="border-t border-border">
          <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-4">
            <p className="text-xs leading-5 text-muted-foreground">
              داشبورد ایجنتیک تایلندگرد
            </p>
            <p className="text-xs leading-5 text-muted-foreground">
              نسخهٔ ۱
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
}
