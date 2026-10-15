"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Repeat2,
  Users,
  Brain,
  ListChecks,
  FileText,
  GitCommitHorizontal,
  GitPullRequest,
  TrendingUp,
  Settings,
  LogOut,
  Plane,
  Activity,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import { Button } from "./ui/Button";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** زیرمنو؛ اگر باشد، آیتم والد بازشو می‌شود. */
  children?: { href: string; label: string }[];
};

/** همهٔ آیتم‌های ناوبری داشبورد؛ منبع مشترک سایدبار دسکتاپ و دراور موبایل. */
export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "خانه", icon: LayoutDashboard },
  { href: "/dashboard/live", label: "فعالیت زنده", icon: Activity },
  { href: "/dashboard/cycles", label: "چرخه‌ها", icon: Repeat2 },
  { href: "/dashboard/teams", label: "تیم‌ها", icon: Users },
  { href: "/dashboard/memory", label: "حافظه", icon: Brain },
  { href: "/dashboard/queue", label: "صف ساخت", icon: ListChecks },
  { href: "/dashboard/bridge", label: "پل اجرا", icon: GitPullRequest },
  { href: "/dashboard/reports", label: "گزارش‌ها", icon: FileText },
  { href: "/dashboard/changes", label: "تغییرات سایت", icon: GitCommitHorizontal },
  { href: "/dashboard/rates", label: "نرخ ارز", icon: TrendingUp },
  {
    href: "/dashboard/settings",
    label: "تنظیمات",
    icon: Settings,
    children: [{ href: "/dashboard/settings/models", label: "مدل‌های هوش مصنوعی" }],
  },
];

/** آیتم فعال بر اساس مسیر جاری؛ صفحهٔ خانه فقط روی مسیر دقیق. */
export function isNavActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <ul className="flex flex-col gap-1">
      {NAV_ITEMS.map((item) => (
        <NavRow key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
      ))}
    </ul>
  );
}

/** یک ردیف ناوبری؛ اگر زیرمنو داشته باشد بازشو می‌شود. */
function NavRow({
  item,
  pathname,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  onNavigate?: () => void;
}) {
  const { href, label, icon: Icon, children } = item;
  const selfActive = isNavActive(pathname, href);
  const childActive = children?.some((c) => isNavActive(pathname, c.href)) ?? false;
  const parentExact = pathname === href;
  // هایلایت قوی والد فقط وقتی خودش دقیقاً فعال است؛ اگر فرزند فعال است والد فقط نشانه ملایم می‌گیرد
  const parentStrong = parentExact && !childActive;
  const active = selfActive || childActive;
  // اگر خود والد یا یکی از فرزندان فعال است، زیرمنو باز می‌ماند
  const [open, setOpen] = React.useState(active);
  React.useEffect(() => {
    if (active) setOpen(true);
  }, [active]);

  const linkClass = (isActive: boolean, subtle = false) =>
    [
      "flex min-h-11 items-center gap-3 rounded-lg px-4 py-2.5 text-base leading-6 transition-colors duration-200 motion-reduce:transition-none",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      isActive
        ? "bg-brand/10 font-semibold text-brand"
        : subtle
          ? "text-brand/80 hover:bg-accent hover:text-foreground"
          : "text-foreground/80 hover:bg-accent hover:text-foreground",
    ].join(" ");

  if (!children || children.length === 0) {
    return (
      <li>
        <Link
          href={href}
          aria-current={active ? "page" : undefined}
          onClick={onNavigate}
          className={linkClass(active)}
        >
          <Icon
            className="h-5 w-5 shrink-0"
            strokeWidth={active ? 2 : 1.5}
            aria-hidden="true"
          />
          <span>{label}</span>
          <span
            aria-hidden="true"
            className={[
              "ms-auto h-2 w-2 rounded-full bg-brand transition-all duration-200 motion-reduce:transition-none",
              active ? "scale-100 opacity-100" : "scale-0 opacity-0",
            ].join(" ")}
          />
        </Link>
      </li>
    );
  }

  return (
    <li>
      <div className="flex items-center gap-1">
        <Link
          href={href}
          aria-current={parentStrong ? "page" : undefined}
          onClick={onNavigate}
          className={[linkClass(parentStrong, childActive && !parentStrong), "flex-1"].join(" ")}
        >
          <Icon
            className="h-5 w-5 shrink-0"
            strokeWidth={parentStrong ? 2 : 1.5}
            aria-hidden="true"
          />
          <span>{label}</span>
          <span
            aria-hidden="true"
            className={[
              "ms-auto h-2 w-2 rounded-full bg-brand transition-all duration-200 motion-reduce:transition-none",
              parentStrong ? "scale-100 opacity-100" : "scale-0 opacity-0",
            ].join(" ")}
          />
        </Link>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "بستن زیرمنو" : "باز کردن زیرمنو"}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown
            aria-hidden="true"
            className={[
              "h-4 w-4 transition-transform duration-200 motion-reduce:transition-none",
              open ? "rotate-180" : "",
            ].join(" ")}
          />
        </button>
      </div>
      <div
        className={[
          "grid transition-all duration-200 motion-reduce:transition-none",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        ].join(" ")}
      >
        <ul className="mt-1 space-y-1 overflow-hidden">
          {children.map((c) => {
            const cActive = isNavActive(pathname, c.href);
            // «اتصال‌ها» دقیقاً روی همان مسیر والد است؛ هایلایت جدا می‌خواهد
            const exactActive = pathname === c.href;
            return (
              <li key={c.href + c.label}>
                <Link
                  href={c.href}
                  aria-current={exactActive ? "page" : undefined}
                  onClick={onNavigate}
                  className={[
                    "flex min-h-10 items-center gap-3 rounded-lg py-2 pe-4 ps-12 text-[15px] leading-6 transition-colors duration-200 motion-reduce:transition-none",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    exactActive
                      ? "bg-brand/10 font-semibold text-brand"
                      : "text-foreground/70 hover:bg-accent hover:text-foreground",
                  ].join(" ")}
                >
                  <span>{c.label}</span>
                  <span
                    aria-hidden="true"
                    className={[
                      "ms-auto h-1.5 w-1.5 rounded-full bg-brand transition-all duration-200 motion-reduce:transition-none",
                      exactActive ? "scale-100 opacity-100" : "scale-0 opacity-0",
                    ].join(" ")}
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </li>
  );
}

export function LogoutButton({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter();

  async function handleLogout() {
    onNavigate?.();
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <Button
      variant="ghost"
      onClick={handleLogout}
      className="min-h-11 w-full justify-start gap-3 rounded-lg px-4 py-2.5 text-base leading-6 text-destructive hover:bg-destructive/10 hover:text-destructive"
    >
      <LogOut className="h-5 w-5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
      <span>خروج</span>
    </Button>
  );
}

export function BrandMark() {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-brand-foreground shadow-control">
        <Plane className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
      </span>
      <span className="flex flex-col leading-6">
        <span className="text-base font-bold">تایلندگرد</span>
        <span className="text-xs text-muted-foreground">داشبورد ایجنتیک</span>
      </span>
    </div>
  );
}

/** سایدبار دسکتاپ (lg به بالا)؛ موبایل از MobileNav استفاده می‌کند. */
export default function Nav() {
  return (
    <nav aria-label="ناوبری داشبورد" className="flex h-full flex-col">
      <div className="px-4 pt-6">
        <BrandMark />
      </div>
      <div className="mt-6 flex-1 overflow-y-auto px-3">
        <NavList />
      </div>
      <div className="border-t border-border px-3 py-3">
        <LogoutButton />
      </div>
    </nav>
  );
}
