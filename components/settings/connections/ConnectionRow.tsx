"use client";

import { useState, type ReactNode } from "react";
import { Check, ChevronDown, X, type LucideIcon } from "lucide-react";

export type ConnState = "loading" | "ok" | "fail" | "unknown";

/** ردیف آکاردئونی هاب اتصال‌ها: یک خط وضعیت + دکمه تنظیم + محتوای بازشونده */
export function ConnectionRow({
  icon: Icon,
  title,
  hint,
  state,
  statusText,
  children,
  defaultOpen = false,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  state: ConnState;
  statusText: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-start"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Icon size={18} strokeWidth={1.75} aria-hidden="true" className="text-brand" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-foreground">{title}</span>
          <span className="block truncate text-xs text-muted-foreground">{hint}</span>
        </span>
        <StatusBadge state={state} text={statusText} />
        <ChevronDown
          size={18}
          aria-hidden="true"
          className={`shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && <div className="border-t border-border px-4 py-4">{children}</div>}
    </div>
  );
}

/** بج وضعیت یکدست هاب */
export function StatusBadge({ state, text }: { state: ConnState; text: string }) {
  if (state === "loading") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
        <span className="h-2 w-2 animate-pulse rounded-full bg-muted-foreground" />
        در حال بررسی…
      </span>
    );
  }
  const ok = state === "ok";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
        ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${ok ? "bg-success" : "bg-destructive"}`} aria-hidden="true" />
      {ok ? <Check size={12} aria-hidden="true" /> : <X size={12} aria-hidden="true" />}
      {text}
    </span>
  );
}

/** راهنمای جمع‌شونده «از کجا بیارم؟» */
export function WhereGuide({ steps }: { steps: string[] }) {
  return (
    <details className="rounded-lg border border-border bg-background px-3 py-2.5">
      <summary className="cursor-pointer text-sm font-medium text-foreground">
        از کجا بیارم؟
      </summary>
      <ol className="mt-2 list-decimal space-y-1.5 pe-4 ps-5 text-xs leading-6 text-muted-foreground marker:text-brand">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
    </details>
  );
}

/** استایل یکدست ورودی‌ها */
export const inputClass =
  "w-full min-h-11 rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30";

/** دکمه اصلی */
export function PrimaryButton({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className="min-h-11 rounded-lg bg-primary px-6 py-2.5 text-sm font-bold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** دکمه فرعی */
export function GhostButton({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-opacity hover:opacity-80 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** پیام نتیجه (موفق/خطا) */
export function ResultNote({ ok, text }: { ok: boolean; text: string }) {
  return (
    <p
      role={ok ? "status" : "alert"}
      className={`rounded-lg px-3 py-2.5 text-sm ${ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}
    >
      {text}
    </p>
  );
}
