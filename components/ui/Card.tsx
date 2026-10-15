"use client";

import * as React from "react";
import { cx } from "./cx";

export type CardProps = React.HTMLAttributes<HTMLElement> & {
  /** کارت تعاملی: هاور فقط بوردر را کمی پررنگ می‌کند؛ بدون سایه و بدون جابه‌جایی. */
  interactive?: boolean;
};

/** کارت پایه: بوردر ۱px ظریف، بدون سایه، گوشهٔ سطح گرافیت (۲۲px)، پدینگ سخاوتمندانه. */
export function Card({
  interactive = false,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <section
      className={cx(
        "rounded-xl border border-border bg-card text-card-foreground",
        interactive &&
          "cursor-pointer transition-soft hover:border-muted-foreground/60",
        className,
      )}
      {...rest}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("p-5 pb-0 sm:p-6 sm:pb-0", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardTitle({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cx("text-base font-bold leading-7 sm:text-lg", className)}
      {...rest}
    >
      {children}
    </h3>
  );
}

export function CardDescription({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cx("mt-1 text-sm leading-7 text-muted-foreground", className)}
      {...rest}
    >
      {children}
    </p>
  );
}

export function CardContent({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("p-5 sm:p-6", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardFooter({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx(
        "flex flex-col gap-2 border-t border-border p-5 sm:flex-row sm:items-center sm:justify-end sm:p-6",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
