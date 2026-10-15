"use client";

import * as React from "react";
import { cx } from "./cx";

export type BadgeVariant =
  | "neutral"
  | "brand"
  | "success"
  | "warning"
  | "destructive"
  | "info";

const VARIANTS: Record<BadgeVariant, string> = {
  neutral:
    "bg-muted text-muted-foreground ring-1 ring-inset ring-border",
  brand: "bg-brand/10 text-brand ring-1 ring-inset ring-brand/25",
  success: "bg-success/10 text-success ring-1 ring-inset ring-success/25",
  warning: "bg-warning/10 text-warning ring-1 ring-inset ring-warning/25",
  destructive:
    "bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/25",
  info: "bg-info/10 text-info ring-1 ring-inset ring-info/25",
};

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant;
  /** نقطهٔ وضعیت در ابتدای بج. */
  dot?: boolean;
};

/** بج وضعیت؛ متن کوتاه فارسی، ارقام با faNum در لایهٔ نمایش. */
export function Badge({
  variant = "neutral",
  dot = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium leading-5",
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {dot && (
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-current"
        />
      )}
      {children}
    </span>
  );
}
