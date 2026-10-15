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
  TrendingUp,
  Settings,
  LogOut,
  Plane,
  Wrench,
  Activity,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

/** همهٔ آیتم‌های ناوبری داشبورد؛ منبع مشترک سایدبار دسکتاپ و دراور موبایل. */
export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "خانه", icon: LayoutDashboard },
  { href: "/dashboard/live", label: "فعالیت زنده", icon: Activity },
  { href: "/dashboard/cycles", label: "چرخه‌ها", icon: Repeat2 },
  { href: "/dashboard/teams", label: "تیم‌ها", icon: Users },
  { href: "/dashboard/memory", label: "حافظه", icon: Brain },
  { href: "/dashboard/queue", label: "صف ساخت", icon: ListChecks },
  { href: "/dashboard/reports", label: "گزارش‌ها", icon: FileText },
  { href: "/dashboard/changes", label: "تغییرات سایت", icon: GitCommitHorizontal },
  { href: "/dashboard/rates", label: "نرخ ارز", icon: TrendingUp },
  { href: "/dashboard/settings", label: "تنظیمات", icon: Settings },
  { href: "/dashboard/debug", label: "دستیار فنی", icon: Wrench },
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
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = isNavActive(pathname, href);
        return (
          <li key={href}>
            <Link
              href={href}
              aria-current={active ? "page" : undefined}
              onClick={onNavigate}
              className={[
                "flex min-h-11 items-center gap-3 rounded-lg px-4 py-2.5 text-base leading-6 transition-colors duration-200 motion-reduce:transition-none",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                active
                  ? "bg-brand/10 font-semibold text-brand"
                  : "text-foreground/80 hover:bg-accent hover:text-foreground",
              ].join(" ")}
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
      })}
    </ul>
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
    <button
      type="button"
      onClick={handleLogout}
      className="flex min-h-11 w-full items-center gap-3 rounded-lg px-4 py-2.5 text-base leading-6 text-destructive transition-colors duration-200 hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none"
    >
      <LogOut className="h-5 w-5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
      <span>خروج</span>
    </button>
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
