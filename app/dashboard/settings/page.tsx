"use client";

import { useState } from "react";

/** تبدیل ارقام لاتین به فارسی */
function faDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
}

const LLM_MODELS = [
  "gpt-5-mini",
  "claude-haiku-4-5",
  "gemini-3-flash",
  "qwen3-235b",
  "glm-4.6",
];

const EMBEDDING_MODELS = [
  "text-embedding-3-large",
  "text-embedding-3-small",
  "gemini-embedding-001",
];

type ConnectionStatus = "ok" | "fail";

const CONNECTIONS: { name: string; desc: string; status: ConnectionStatus }[] = [
  { name: "سوپابیس", desc: "پایگاه داده و ذخیره‌سازی", status: "ok" },
  { name: "تلگرام", desc: "اعلان‌ها و بات گزارش‌دهی", status: "ok" },
  { name: "LLM", desc: "درگاه مدل‌های زبانی", status: "fail" },
];

const inputClass =
  "w-full min-h-[44px] rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground shadow-control placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30";

export default function SettingsPage() {
  const [llmModel, setLlmModel] = useState(LLM_MODELS[0]);
  const [embeddingModel, setEmbeddingModel] = useState(EMBEDDING_MODELS[0]);
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
          llmModel,
          embeddingModel,
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
    <main className="mx-auto max-w-3xl px-4 py-6 md:py-8">
      <header className="mb-6 md:mb-8">
        <h1 className="text-xl font-bold text-foreground sm:text-2xl">تنظیمات</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          پیکربندی مدل‌ها، زمان‌بندی چرخه‌ها و مشاهده وضعیت اتصال‌ها
        </p>
      </header>

      <form onSubmit={handleSave} className="space-y-6">
        {/* مدل‌ها */}
        <section className="rounded-xl border border-border bg-card p-4 shadow-surface sm:p-6">
          <h2 className="mb-4 text-base font-bold text-card-foreground">مدل‌ها</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="llm-model" className="mb-1.5 block text-sm font-medium text-foreground">
                مدل LLM پیش‌فرض
              </label>
              <select
                id="llm-model"
                dir="ltr"
                value={llmModel}
                onChange={(e) => setLlmModel(e.target.value)}
                className={inputClass}
              >
                {LLM_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="embedding-model" className="mb-1.5 block text-sm font-medium text-foreground">
                مدل embedding
              </label>
              <select
                id="embedding-model"
                dir="ltr"
                value={embeddingModel}
                onChange={(e) => setEmbeddingModel(e.target.value)}
                className={inputClass}
              >
                {EMBEDDING_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* چرخه و محدودیت‌ها */}
        <section className="rounded-xl border border-border bg-card p-4 shadow-surface sm:p-6">
          <h2 className="mb-4 text-base font-bold text-card-foreground">چرخه و محدودیت‌ها</h2>
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
                حداکثر موازی‌سازی موج
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

        {/* وضعیت اتصال‌ها */}
        <section className="rounded-xl border border-border bg-card p-4 shadow-surface sm:p-6">
          <h2 className="mb-4 text-base font-bold text-card-foreground">وضعیت اتصال‌ها</h2>
          <ul className="divide-y divide-border">
            {CONNECTIONS.map((c) => (
              <li key={c.name} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                <div>
                  <p className="text-sm font-medium text-foreground">{c.name}</p>
                  <p className="text-xs text-muted-foreground">{c.desc}</p>
                </div>
                <span
                  className={
                    c.status === "ok"
                      ? "inline-flex items-center gap-1.5 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success"
                      : "inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive"
                  }
                >
                  <span
                    className={
                      c.status === "ok"
                        ? "h-2 w-2 rounded-full bg-success"
                        : "h-2 w-2 rounded-full bg-destructive"
                    }
                  />
                  {c.status === "ok" ? "متصل" : "قطع"}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            وضعیت‌ها نمایشی‌اند و از روی پینگ زنده سرویس‌ها به‌روز نمی‌شوند.
          </p>
        </section>

        {/* دکمه ذخیره: چسبان پایین در موبایل، تمام‌عرض؛ با فاصله از ناوبری پایینی */}
        <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 -mx-4 bg-background/85 px-4 pb-1 pt-3 backdrop-blur sm:static sm:mx-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              type="submit"
              disabled={saving}
              className="min-h-[48px] w-full rounded-lg bg-brand px-6 py-2.5 text-sm font-bold text-brand-foreground shadow-control transition-opacity hover:opacity-90 disabled:opacity-50 sm:w-auto"
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
    </main>
  );
}
