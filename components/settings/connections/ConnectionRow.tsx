"use client";

import { useState, type ReactNode } from "react";
import { Check, X, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Collapsible } from "@/components/ui/collapsible";

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
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        trigger={
          <span className="flex w-full items-center gap-3 text-start">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
              <Icon size={18} strokeWidth={1.75} aria-hidden="true" className="text-brand" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-foreground">{title}</span>
              <span className="block truncate text-xs text-muted-foreground">{hint}</span>
            </span>
            <StatusBadge state={state} text={statusText} />
          </span>
        }
      >
        <div className="border-t border-border px-4 py-4">{children}</div>
      </Collapsible>
    </div>
  );
}

/** بج وضعیت یکدست هاب (رجیستری) */
export function StatusBadge({ state, text }: { state: ConnState; text: string }) {
  if (state === "loading") {
    return (
      <Badge variant="secondary" className="shrink-0 gap-1.5">
        <span className="h-2 w-2 animate-pulse rounded-full bg-current" aria-hidden="true" />
        در حال بررسی…
      </Badge>
    );
  }
  const ok = state === "ok";
  return (
    <Badge variant={ok ? "success" : "destructive"} className="shrink-0 gap-1.5">
      <span className="h-2 w-2 rounded-full bg-current" aria-hidden="true" />
      {ok ? <Check size={12} aria-hidden="true" /> : <X size={12} aria-hidden="true" />}
      {text}
    </Badge>
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
