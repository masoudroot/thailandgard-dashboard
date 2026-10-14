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
  Settings,
  LogOut,
  Plane,
  type LucideIcon,
} from "lucide-react";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

const ITEMS: NavItem[] = [
  { href: "/dashboard", label: "خانه", icon: LayoutDashboard },
  { href: "/dashboard/cycles", label: "چرخه‌ها", icon: Repeat2 },
  { href: "/dashboard/teams", label: "تیم‌ها", icon: Users },
  { href: "/dashboard/memory", label: "حافظه", icon: Brain },
  { href: "/dashboard/queue", label: "صف ساخت", icon: ListChecks },
  { href: "/dashboard/reports", label: "گزارش‌ها", icon: FileText },
  { href: "/dashboard/settings", label: "تنظیمات", icon: Settings },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <ul className="flex flex-col gap-1">
      {ITEMS.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <li key={href}>
            <Link
              href={href}
              aria-current={active ? "page" : undefined}
              onClick={onNavigate}
              className={[
                "flex items-center gap-3 rounded-lg px-4 py-2.5 text-[15px] leading-6 transition-colors duration-200",
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
              {active && (
                <span
                  aria-hidden="true"
                  className="ms-auto h-2 w-2 rounded-full bg-brand"
                />
              )}
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
      className="flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-[15px] leading-6 text-destructive transition-colors duration-200 hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <LogOut className="h-5 w-5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
      <span>خروج</span>
    </button>
  );
}

export function BrandMark() {
  return (
    <div className="flex items-center gap-3 px-4">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand text-brand-foreground shadow-control">
        <Plane className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
      </span>
      <span className="flex flex-col leading-6">
        <span className="text-base font-bold">تایلندگرد</span>
        <span className="text-xs text-muted-foreground">داشبورد ایجنتیک</span>
      </span>
    </div>
  );
}

export function MobileMenu() {
  const ref = React.useRef<HTMLDetailsElement>(null);

  function close() {
    ref.current?.removeAttribute("open");
  }

  return (
    <details ref={ref} className="relative lg:hidden">
      <summary
        className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground shadow-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label="باز کردن منوی ناوبری"
      >
        منو
      </summary>
      <div className="absolute inset-x-0 top-full z-20 mt-2 min-w-56 rounded-xl border border-border bg-card p-3 shadow-surface">
        <nav aria-label="ناوبری داشبورد">
          <NavList onNavigate={close} />
          <div className="mt-2 border-t border-border pt-2">
            <LogoutButton onNavigate={close} />
          </div>
        </nav>
      </div>
    </details>
  );
}

export default function Nav() {
  return (
    <nav aria-label="ناوبری داشبورد" className="flex h-full flex-col">
      <div className="pt-6">
        <BrandMark />
      </div>
      <div className="mt-8 flex-1 overflow-y-auto px-4">
        <NavList />
      </div>
      <div className="border-t border-border px-4 py-4">
        <LogoutButton />
      </div>
    </nav>
  );
}
