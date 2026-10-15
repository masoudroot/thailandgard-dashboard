"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cx } from "./cx";

export type ModalSize = "sm" | "md" | "lg";

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: ModalSize;
  /** بستن با کلیک روی پس‌زمینه؛ پیش‌فرض روشن است. */
  closeOnBackdropClick?: boolean;
};

const SIZES: Record<ModalSize, string> = {
  sm: "sm:max-w-sm",
  md: "sm:max-w-md",
  lg: "sm:max-w-2xl",
};

/**
 * مودال پایهٔ سیستم دیزاین.
 * ورود: fade به همراه translateY دوازده پیکسل در ۶۰۰ میلی‌ثانیه؛
 * بوردر ۱px، گوشهٔ ۱۲px، سایهٔ خیلی ظریف؛ بدون سایهٔ سنگین.
 * با Escape بسته می‌شود، اسکرول صفحه را قفل می‌کند و فوکوس را روی
 * دکمهٔ بستن می‌نشاند.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  closeOnBackdropClick = true,
}: ModalProps) {
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const titleId = React.useId();
  const descId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4"
      onClick={() => {
        if (closeOnBackdropClick) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={cx(
          "tg-modal-in max-h-[92dvh] w-full overflow-y-auto rounded-lg border border-border bg-card p-5 text-card-foreground shadow-overlay sm:p-6",
          SIZES[size],
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-bold leading-8">
            {title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="بستن"
            className="touch-target -me-2 -mt-2 shrink-0 rounded-md text-muted-foreground transition-soft hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        {description && (
          <p
            id={descId}
            className="mt-1 text-sm leading-7 text-muted-foreground"
          >
            {description}
          </p>
        )}
        <div className="mt-4">{children}</div>
        {footer && (
          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
