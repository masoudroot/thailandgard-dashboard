"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cx } from "./cx";

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
  hint?: string;
  error?: string;
};

/** سلکت پایه (native؛ دسترس‌پذیر و موبایل‌دوست) با لیبل، راهنما و خطا. */
export function Select({
  label,
  hint,
  error,
  id,
  className,
  children,
  ...rest
}: SelectProps) {
  const inputId = React.useId();
  const fieldId = id ?? `tg-select-${inputId}`;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;

  return (
    <div className={cx("w-full", className)}>
      {label && (
        <label
          htmlFor={fieldId}
          className="mb-1.5 block text-sm font-medium leading-6 text-foreground"
        >
          {label}
        </label>
      )}
      <div className="relative">
        <select
          id={fieldId}
          aria-invalid={error ? true : undefined}
          aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
          className={cx(
            "min-h-11 w-full appearance-none rounded-md border bg-background py-2.5 pe-10 ps-3 text-base text-foreground transition-soft sm:text-sm",
            "focus:outline-none focus:ring-2",
            "disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60",
            error
              ? "border-destructive focus:border-destructive focus:ring-destructive/30"
              : "border-input focus:border-ring focus:ring-ring/30",
          )}
          {...rest}
        >
          {children}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
      </div>
      {hint && !error && (
        <p id={hintId} className="mt-1.5 text-xs leading-5 text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="mt-1.5 text-xs leading-5 text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
