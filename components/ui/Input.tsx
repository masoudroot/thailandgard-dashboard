"use client";

import * as React from "react";
import { cx } from "./cx";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  error?: string;
};

/**
 * اینپوت پایه با لیبل، راهنما و خطا.
 * خطا زیر فیلد می‌آید (قرمز از توکن destructive)؛ placeholder جای لیبل نیست.
 */
export function Input({
  label,
  hint,
  error,
  id,
  className,
  ...rest
}: InputProps) {
  const inputId = React.useId();
  const fieldId = id ?? `tg-input-${inputId}`;
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
      <input
        id={fieldId}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
        className={cx(
          "w-full rounded-md border bg-background px-3 py-2.5 text-base text-foreground transition-soft sm:text-sm",
          "placeholder:text-muted-foreground",
          "focus:outline-none focus:ring-2",
          "disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60",
          error
            ? "border-destructive focus:border-destructive focus:ring-destructive/30"
            : "border-input focus:border-ring focus:ring-ring/30",
        )}
        {...rest}
      />
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
