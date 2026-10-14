"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X, type LucideIcon } from "lucide-react";
import {
  NAV_ITEMS,
  NavItem,
  BrandMark,
  LogoutButton,
  NavList,
  isNavActive,
} from "./Nav";

/** ۴ تب اصلی ناوبری پایینی: خانه، چرخه‌ها، تیم‌ها، صف ساخت */
const TABS: NavItem[] = [NAV_ITEMS[0], NAV_ITEMS[1], NAV_ITEMS[2], NAV_ITEMS[4]];

/** آیتم‌هایی که فقط در دراور «بیشتر» دیده می‌شوند */
const MORE_HREFS = [NAV_ITEMS[3].href, NAV_ITEMS[5].href, NAV_ITEMS[6].href];

type TabButtonProps = {
  label: string;
  icon: LucideIcon;
  active: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
};

function TabShell({
  label,
  icon: Icon,
  active,
  buttonRef,
  ...rest
}: TabButtonProps &
  ({ href: string } | { onClick: () => void; "aria-expanded": boolean })) {
  const className = [
    "flex min-h-16 w-full flex-col items-center justify-center gap-1 px-1 py-2 text-[11px] font-medium leading-4 transition-colors duration-200 motion-reduce:transition-none",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    active ? "text-brand" : "text-muted-foreground hover:text-foreground",
  ].join(" ");

  const inner = (
    <>
      <span
        aria-hidden="true"
        className={[
          "h-1 w-8 rounded-full transition-all duration-200 motion-reduce:transition-none",
          active ? "bg-brand opacity-100" : "bg-transparent opacity-0",
        ].join(" ")}
      />
      <Icon
        className="h-6 w-6"
        strokeWidth={active ? 2 : 1.5}
        aria-hidden="true"
      />
      <span>{label}</span>
    </>
  );

  if ("href" in rest) {
    return (
      <Link
        href={rest.href}
        aria-current={active ? "page" : undefined}
        className={className}
      >
        {inner}
      </Link>
    );
  }
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={rest.onClick}
      aria-expanded={rest["aria-expanded"]}
      aria-haspopup="dialog"
      aria-controls="mobile-nav-drawer"
      aria-current={active ? "page" : undefined}
      className={className}
    >
      {inner}
    </button>
  );
}

/**
 * ناوبری موبایل: ناوبری پایینی ثابت (فقط زیر lg) + دراور کناری از سمت راست.
 * دراور با ضربدر، کلیک روی اوورلی یا کلید Escape بسته می‌شود.
 */
export default function MobileNav() {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const closeBtnRef = React.useRef<HTMLButtonElement>(null);
  const moreBtnRef = React.useRef<HTMLButtonElement>(null);

  const close = React.useCallback(() => setOpen(false), []);

  // Escape + قفل اسکرول بدنه + مدیریت فوکوس
  React.useEffect(() => {
    if (!open) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeBtnRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
      moreBtnRef.current?.focus();
    };
  }, [open ]);

  const moreActive = MORE_HREFS.some((href) => isNavActive(pathname, href));

  return (
    <>
      {/* ناوبری پایینی */}
      <nav
        aria-label="ناوبری اصلی موبایل"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/95 backdrop-blur lg:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <ul className="flex items-stretch">
          {TABS.map(({ href, label, icon }) => (
            <li key={href} className="flex-1">
              <TabShell
                href={href}
                label={label}
                icon={icon}
                active={isNavActive(pathname, href)}
              />
            </li>
          ))}
          <li className="flex-1">
            <TabShell
              label="بیشتر"
              icon={Menu}
              active={moreActive}
              buttonRef={moreBtnRef}
              onClick={() => setOpen(true)}
              aria-expanded={open}
            />
          </li>
        </ul>
      </nav>

      {/* اوورلی دراور */}
      <div
        aria-hidden="true"
        onClick={close}
        className={[
          "fixed inset-0 z-40 bg-foreground/50 transition-[opacity,visibility] duration-200 motion-reduce:transition-none lg:hidden",
          open ? "visible opacity-100" : "invisible opacity-0",
        ].join(" ")}
      />

      {/* دراور کناری از سمت راست (شروع در راست‌چین) */}
      <aside
        id="mobile-nav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="منوی ناوبری"
        className={[
          "fixed inset-y-0 start-0 z-50 flex w-72 max-w-[80vw] flex-col bg-card shadow-surface lg:hidden",
          "transition-[transform,visibility] duration-200 ease-out motion-reduce:transition-none",
          open ? "visible translate-x-0" : "invisible translate-x-full",
        ].join(" ")}
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-5">
          <BrandMark />
          <button
            ref={closeBtnRef}
            type="button"
            onClick={close}
            aria-label="بستن منو"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-200 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="mt-6 flex-1 overflow-y-auto px-3">
          <NavList onNavigate={close} />
        </div>
        <div className="border-t border-border px-3 py-3">
          <LogoutButton onNavigate={close} />
        </div>
      </aside>
    </>
  );
}
