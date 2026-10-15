import Nav from "@/components/Nav";
import MobileNav from "@/components/MobileNav";
import PageTransition from "@/components/PageTransition";
import KnowledgeNavLink from "./KnowledgeNavLink";

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
        <header className="sticky top-0 z-10 border-b border-border bg-background pt-[env(safe-area-inset-top)]">
          <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between px-4 lg:h-16 lg:px-6">
            <h1 className="text-base font-bold leading-7 lg:text-lg">
              <span className="lg:hidden">داشبورد</span>
              <span className="hidden lg:inline">
                داشبورد ایجنتیک تایلندگرد
              </span>
            </h1>
            {/* لینک «دانش» در هدر؛ هم موبایل هم دسکتاپ (تیم ۵، پروژه دانش) */}
            <KnowledgeNavLink />
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 lg:px-6 lg:py-8">
          <PageTransition>{children}</PageTransition>
          {/* فاصله‌گذار برای ناوبری پایینی موبایل (قرارداد با تیم ناوبری) */}
          <div
            aria-hidden="true"
            className="pb-[calc(6rem+env(safe-area-inset-bottom))] lg:pb-8"
          />
        </main>

        <footer className="border-t border-border">
          <div className="mx-auto flex w-full max-w-7xl flex-col items-center justify-center gap-1 px-4 py-4 text-xs leading-5 text-muted-foreground sm:flex-row sm:justify-between sm:px-6 lg:px-6">
            <p className="font-medium">داشبورد ایجنتیک تایلندگرد</p>
            <p className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="hidden h-1 w-1 rounded-full bg-border sm:block"
              />
              نسخهٔ ۱
            </p>
          </div>
        </footer>
      </div>

      {/* ناوبری موبایل: ناوبری پایینی ثابت + دراور کناری (تیم ۲) */}
      <MobileNav />
    </div>
  );
}
