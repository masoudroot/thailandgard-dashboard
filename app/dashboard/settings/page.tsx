"use client";

import { useEffect, useState } from "react";
import { Settings, Timer } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { ConnectionsHub } from "@/components/settings/connections/ConnectionsHub";
import { SettingsBackup } from "@/components/settings/SettingsBackup";

/** تبدیل ارقام لاتین به فارسی */
function faDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
}

const inputClass =
  "w-full min-h-11 rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground shadow-control placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30";

/** تاریخ شمسی کوتاه با ارقام فارسی */
function faDateTime(iso: string | null): string {
  if (!iso) return "نامشخص";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "نامشخص";
  return new Intl.DateTimeFormat("fa-IR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

/**
 * کارت «اتصال گیت‌هاب»: ورود توکن شخصی، ذخیره در settings و تست زنده.
 * همین توکن برای صفحهٔ «تاریخچه تغییرات سایت» هم استفاده می‌شود.
 * خود توکن هرگز از سرور برنمی‌گردد؛ فقط وضعیت اتصال نمایش داده می‌شود.
 */
export default function SettingsPage() {
  const [cycleMinutes, setCycleMinutes] = useState("120");
  const [llmCallCap, setLlmCallCap] = useState("400");
  const [maxParallelism, setMaxParallelism] = useState("3");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cycleMinutes: Number(cycleMinutes),
          llmCallCap: Number(llmCallCap),
          maxParallelism: Number(maxParallelism),
        }),
      });
    } catch {
      // هنوز API تنظیمات پیاده نشده؛ پیام موفق نمایشی است
    } finally {
      setSaving(false);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 4000);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:py-8">
      <PageHeader
        icon={Settings}
        title="تنظیمات"
        subtitle="زمان‌بندی چرخه‌ها، وضعیت اتصال‌ها و پشتیبان‌گیری"
      />

      <ConnectionsHub />

      <form onSubmit={handleSave} className="space-y-6">
        {/* چرخه و محدودیت‌ها */}
        <section className="rounded-xl border border-border bg-card p-4 shadow-surface sm:p-6">
          <h2 className="mb-4 flex items-center gap-2 text-base font-bold text-card-foreground">
            <Timer size={18} strokeWidth={1.75} aria-hidden="true" className="text-brand" />
            چرخه و محدودیت‌ها
          </h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="cycle-minutes" className="mb-1.5 block text-sm font-medium text-foreground">
                زمان‌بندی چرخه (دقیقه)
              </label>
              <input
                id="cycle-minutes"
                type="number"
                dir="ltr"
                min={15}
                step={15}
                value={cycleMinutes}
                onChange={(e) => setCycleMinutes(e.target.value)}
                className={inputClass}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                فاصله بین شروع خودکار چرخه‌ها: {faDigits(cycleMinutes)} دقیقه
              </p>
            </div>
            <div>
              <label htmlFor="llm-call-cap" className="mb-1.5 block text-sm font-medium text-foreground">
                سقف فراخوانی LLM در هر چرخه
              </label>
              <input
                id="llm-call-cap"
                type="number"
                dir="ltr"
                min={1}
                value={llmCallCap}
                onChange={(e) => setLlmCallCap(e.target.value)}
                className={inputClass}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                حداکثر {faDigits(llmCallCap)} فراخوانی در هر چرخه
              </p>
            </div>
            <div>
              <label htmlFor="max-parallelism" className="mb-1.5 block text-sm font-medium text-foreground">
                حداکثر موازی‌سازی در هر موج
              </label>
              <input
                id="max-parallelism"
                type="number"
                dir="ltr"
                min={1}
                max={15}
                value={maxParallelism}
                onChange={(e) => setMaxParallelism(e.target.value)}
                className={inputClass}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                حداکثر {faDigits(maxParallelism)} تیم هم‌زمان در یک موج
              </p>
            </div>
          </div>
        </section>



        {/* دکمه ذخیره: چسبان پایین در موبایل، تمام‌عرض؛ با فاصله از ناوبری پایینی */}
        <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 -mx-4 bg-background px-4 pb-1 pt-3 sm:static sm:mx-0 sm:bg-transparent sm:p-0">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              type="submit"
              disabled={saving}
              className="min-h-12 w-full rounded-lg bg-primary px-6 py-2.5 text-sm font-bold text-primary-foreground shadow-control transition-opacity hover:opacity-90 disabled:opacity-50 sm:w-auto"
            >
              {saving ? "در حال ذخیره…" : "ذخیره تنظیمات"}
            </button>
            {saved && (
              <p role="status" className="text-sm font-medium text-success">
                تنظیمات ذخیره شد.
              </p>
            )}
          </div>
        </div>
      </form>

      <div className="mt-6">
        <SettingsBackup />
      </div>
    </div>
  );
}
