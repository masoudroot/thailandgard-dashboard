"use client";

import * as React from "react";
import { cx } from "./cx";

export type SwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
} & Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "onClick" | "type" | "role" | "id" | "disabled" | "className"
>;

/** سوییچ/تاگل پایه؛ در RTL آینه‌ای است («روشن» سمت چپ/انتها می‌نشیند). */
export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  id,
  className,
  ...rest
}: SwitchProps) {
  const inputId = React.useId();
  const switchId = id ?? `tg-switch-${inputId}`;

  return (
    <label
      htmlFor={switchId}
      className={cx(
        "inline-flex cursor-pointer items-center gap-2.5",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <button
        type="button"
        role="switch"
        id={switchId}
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        {...rest}
        className={cx(
          "relative h-6 w-11 shrink-0 rounded-full transition-soft",
          /* ناحیهٔ کلیک نامرئی: تاچ‌تارگت ۴۴px بدون تغییر ظاهر سوییچ */
          "before:absolute before:-inset-2.5 before:content-['']",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed",
          checked ? "bg-brand" : "bg-input",
        )}
      >
        <span
          aria-hidden="true"
          className={cx(
            "absolute start-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200 motion-reduce:transition-none",
            checked && "translate-x-5 rtl:-translate-x-5",
          )}
        />
      </button>
      {label && (
        <span className="text-sm font-medium leading-6 text-foreground">
          {label}
        </span>
      )}
    </label>
  );
}
