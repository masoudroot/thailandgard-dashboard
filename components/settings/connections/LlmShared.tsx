"use client";

import { faDigits } from "@/lib/format";
import type { SaveState } from "./llm-types";

/** وضعیت ذخیره‌ی خودکار. */
export function SaveNote({ state }: { state: SaveState }) {
  if (state === "idle") return null;
  return (
    <p
      role="status"
      className={
        state === "error"
          ? "text-sm text-destructive"
          : "text-sm text-muted-foreground"
      }
    >
      {state === "saving"
        ? "در حال ذخیره…"
        : state === "saved"
          ? "ذخیره شد."
          : "ذخیره انجام نشد؛ دوباره تلاش کنید."}
    </p>
  );
}

/** شمار «X از Y مدل پاسخ دادند» با ارقام فارسی، کنار لیبل انتخاب مدل */
export function HealthSummary({
  endpointId,
  modelsCache,
  modelHealth,
  healthLoading,
}: {
  endpointId: string;
  modelsCache: Record<string, string[]>;
  modelHealth: Record<string, Record<string, { ok: boolean; message: string }>>;
  healthLoading: Record<string, boolean>;
}) {
  const cached = modelsCache[endpointId];
  const h = modelHealth[endpointId];
  if (!endpointId || !cached || cached.length === 0) return null;
  if (!h) {
    return healthLoading[endpointId] ? (
      <span> (در حال تست سلامت مدل‌ها…)</span>
    ) : null;
  }
  const healthy = cached.filter((m) => h[m]?.ok).length;
  return (
    <span>
      {" "}
      ({faDigits(healthy)} از {faDigits(cached.length)} مدل پاسخ دادند)
      {healthLoading[endpointId] && "؛ در حال تست دوباره…"}
    </span>
  );
}

/**
 * هشدار وقتی مدلِ ست‌شده در آخرین تست سلامت ناسالم بود.
 * تنظیم فعلی خودکار پاک نمی‌شود؛ فقط هشدار داده می‌شود.
 */
export function UnhealthySavedWarning({
  endpointId,
  model,
  modelHealth,
}: {
  endpointId: string;
  model: string;
  modelHealth: Record<string, Record<string, { ok: boolean; message: string }>>;
}) {
  const trimmed = model.trim();
  const h = trimmed ? modelHealth[endpointId]?.[trimmed] : undefined;
  if (!h || h.ok) return null;
  return (
    <p className="mt-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-6 text-foreground">
      هشدار: این مدل در آخرین تست سلامت «{faDigits(h.message)}» بود؛ تنظیم
      فعلی شما دست‌نخورده باقی مانده است. با «تست دوباره» می‌توانید دوباره
      بررسی کنید.
    </p>
  );
}
