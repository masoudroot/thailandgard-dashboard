"use client";

import * as React from "react";

/**
 * دکمه با موج ریپل سبک: روی اشاره، یک دایره از نقطه لمس باز می‌شود و محو می‌شود.
 * فقط transform و opacity متحرک‌اند؛ روی موبایل سبک است.
 */

interface RippleButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

export default function RippleButton({
  children,
  className,
  onPointerDown,
  ...rest
}: RippleButtonProps) {
  const ref = React.useRef<HTMLButtonElement>(null);

  function spawnRipple(e: React.PointerEvent<HTMLButtonElement>) {
    onPointerDown?.(e);
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2.2;
    const ink = document.createElement("span");
    ink.className = "tg-ripple-ink";
    ink.style.width = `${size}px`;
    ink.style.height = `${size}px`;
    ink.style.left = `${e.clientX - rect.left - size / 2}px`;
    ink.style.top = `${e.clientY - rect.top - size / 2}px`;
    el.appendChild(ink);
    window.setTimeout(() => ink.remove(), 350);
  }

  return (
    <button
      ref={ref}
      type="button"
      onPointerDown={spawnRipple}
      className={["tg-ripple", className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}
