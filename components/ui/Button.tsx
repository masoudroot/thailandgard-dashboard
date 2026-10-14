"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { cx } from "./cx";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "outline"
  | "ghost"
  | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-brand text-brand-foreground shadow-sm hover:shadow-md hover:brightness-105 active:brightness-95",
  secondary:
    "border border-border bg-secondary text-secondary-foreground shadow-sm hover:bg-accent",
  outline:
    "border border-input bg-card text-foreground shadow-sm hover:bg-accent",
  ghost: "text-foreground hover:bg-accent",
  danger:
    "bg-destructive text-destructive-foreground shadow-sm hover:shadow-md hover:brightness-105 active:brightness-95",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "min-h-9 px-3 text-[13px]",
  md: "min-h-11 px-5 text-sm",
  lg: "min-h-[52px] px-7 text-base",
};

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
};

/**
 * دکمهٔ پایهٔ سیستم دیزاین.
 * variant پیش‌فرض primary است؛ اکشن اصلی همیشه در ابتدای گروه (راست در RTL) می‌نشیند.
 */
export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  const isDisabled = disabled || loading;
  return (
    <button
      type="button"
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cx(
        "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-semibold leading-6",
        "transition-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:pointer-events-none disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading && (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      )}
      {children}
    </button>
  );
}
