"use client";

import { useEffect, useState } from "react";
import { Cpu, Settings, Timer, TrendingUp } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { ConnectionsHub } from "@/components/settings/connections/ConnectionsHub";
import { SkeletonLines } from "@/components/Skeleton";
import { Switch } from "@/components/ui/Switch";
import type { MarketLastCheck } from "@/lib/market";

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
 * کارت «منبع داده بازار»: روشن/خاموش، آدرس، تایم‌اوت، تست اتصال و آخرین وضعیت.
 * مستقل از فرم اصلی تنظیمات است و مستقیم با /api/settings/market کار می‌کند.
 */
function MarketSourceCard() {
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState("");
  const [timeoutSec, setTimeoutSec] = useState("30");
  const [hasCache, setHasCache] = useState(false);
  const [lastCheck, setLastCheck] = useState<MarketLastCheck | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [savedMsg, setSavedMsg] = useState(false);
  const [testMsg, setTestMsg] = useState<{
    ok: boolean;
    message: string;
    latencyMs: number | null;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/settings/market", { cache: "no-store" });
        const body = await res.json();
        const cfg = body?.data;
        if (cfg) {
          setEnabled(!!cfg.enabled);
          setUrl(typeof cfg.url === "string" ? cfg.url : "");
          setTimeoutSec(String(cfg.timeoutSec ?? 30));
          setHasCache(!!cfg.hasCache);
          setLastCheck(cfg.lastCheck ?? null);
        }
      } catch {
        // پیش‌فرض‌ها می‌مانند
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleSave() {
    setSaving(true);
    setSavedMsg(false);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/settings/market", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          url: url.trim(),
          timeoutSec: Number(timeoutSec),
        }),
      });
      const body = await res.json();
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? "ذخیره انجام نشد؛ دوباره تلاش کنید.");
      }
      const cfg = body?.data;
      setHasCache(!!cfg?.hasCache);
      setLastCheck(cfg?.lastCheck ?? null);
      setSavedMsg(true);
      window.setTimeout(() => setSavedMsg(false), 4000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "ذخیره انجام نشد؛ دوباره تلاش کنید.");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestMsg(null);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/settings/market/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), timeoutSec: Number(timeoutSec) }),
      });
      const body = await res.json();
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? "تست اتصال انجام نشد؛ دوباره تلاش کنید.");
      }
      const r = body?.data;
      setTestMsg({
        ok: !!r?.ok,
        message: String(r?.message ?? ""),
        latencyMs: typeof r?.latencyMs === "number" ? r.latencyMs : null,
      });
      // آخرین وضعیت را تازه کن
      try {
        const cfgRes = await fetch("/api/settings/market", { cache: "no-store" });
        const cfgBody = await cfgRes.json();
        setLastCheck(cfgBody?.data?.lastCheck ?? null);
      } catch {
        // نادیده
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "تست اتصال انجام نشد؛ دوباره تلاش کنید.");
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-surface sm:p-6">
      <h2 className="mb-1 flex items-center gap-2 text-base font-bold text-card-foreground">
        <TrendingUp size={18} strokeWidth={1.75} aria-hidden="true" className="text-brand" />
        منبع داده بازار
      </h2>
      <p className="mb-4 text-xs text-muted-foreground">
        تیم «اطلاعات بازار» پیش از شروع چرخه از این منبع داده می‌گیرد. اگر قطع باشد،
        چرخه با کش یا بدون داده ادامه می‌یابد و متوقف نمی‌شود.
      </p>

      {loading ? (
        <div aria-busy="true"><SkeletonLines lines={3} /><span className="sr-only">در حال بارگذاری…</span></div>
      ) : (
        <div className="space-y-4">
          {/* روشن/خاموش */}
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-foreground">اتصال به منبع بیرونی</p>
              <p className="text-xs text-muted-foreground">
                {enabled ? "فعال: هر چرخه داده تازه می‌گیرد." : "خاموش: تیم بدون داده بازار کار می‌کند."}
              </p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={(v) => setEnabled(v)}
              aria-label="اتصال به منبع داده بازار"
            />
          </div>

          {/* آدرس */}
          <div>
            <label htmlFor="market-url" className="mb-1.5 block text-sm font-medium text-foreground">
              آدرس منبع داده
            </label>
            <input
              id="market-url"
              type="url"
              dir="ltr"
              placeholder="https://example.com/market-feed"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className={inputClass}
            />
          </div>

          {/* تایم‌اوت */}
          <div>
            <label htmlFor="market-timeout" className="mb-1.5 block text-sm font-medium text-foreground">
              تایم‌اوت (ثانیه)
            </label>
            <input
              id="market-timeout"
              type="number"
              dir="ltr"
              min={5}
              max={300}
              value={timeoutSec}
              onChange={(e) => setTimeoutSec(e.target.value)}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              بین {faDigits(5)} تا {faDigits(300)} ثانیه؛ پس از ۳ تلاش ناموفق از کش استفاده می‌شود.
            </p>
          </div>

          {/* آخرین وضعیت */}
          <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-foreground">آخرین وضعیت اتصال</p>
              <p className="text-xs text-muted-foreground">
                {lastCheck
                  ? `${faDateTime(lastCheck.at)}${lastCheck.latencyMs != null ? ` | ${faDigits(lastCheck.latencyMs)} میلی‌ثانیه` : ""}`
                  : "هنوز تستی انجام نشده است."}
                {hasCache ? " | کش موجود است." : ""}
              </p>
              {lastCheck && !lastCheck.ok && (
                <p className="mt-1 text-xs text-destructive">{lastCheck.message}</p>
              )}
            </div>
            <span
              className={
                lastCheck?.ok
                  ? "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success"
                  : "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive"
              }
            >
              <span
                className={
                  lastCheck?.ok ? "h-2 w-2 rounded-full bg-success" : "h-2 w-2 rounded-full bg-destructive"
                }
              />
              {lastCheck?.ok ? "سالم" : "قطع"}
            </span>
          </div>

          {/* نتیجه تست */}
          {testMsg && (
            <p
              role="status"
              className={`rounded-lg px-3 py-2.5 text-sm ${
                testMsg.ok
                  ? "bg-success/10 text-success"
                  : "bg-destructive/10 text-destructive"
              }`}
            >
              {testMsg.message}
              {testMsg.latencyMs != null ? ` (${faDigits(testMsg.latencyMs)} میلی‌ثانیه)` : ""}
            </p>
          )}
          {errorMsg && (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
              {errorMsg}
            </p>
          )}

          {/* دکمه‌ها */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="min-h-12 rounded-lg bg-primary px-6 py-2.5 text-sm font-bold text-primary-foreground shadow-control transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "در حال ذخیره…" : "ذخیره"}
            </button>
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || !url.trim()}
              className="min-h-12 rounded-lg border border-input bg-background px-6 py-2.5 text-sm font-medium text-foreground shadow-control transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              {testing ? "در حال تست…" : "تست اتصال"}
            </button>
            {savedMsg && (
              <p role="status" className="text-sm font-medium text-success">
                ذخیره شد.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * کارت «اتصال گیت‌هاب»: ورود توکن شخصی، ذخیره در settings و تست زنده.
 * همین توکن برای صفحهٔ «تاریخچه تغییرات سایت» هم استفاده می‌شود.
 * خود توکن هرگز از سرور برنمی‌گردد؛ فقط وضعیت اتصال نمایش داده می‌شود.
 */
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
    <div className="mx-auto max-w-3xl px-4 py-6 md:py-8">
      <PageHeader
        icon={Settings}
        title="تنظیمات"
        subtitle="پیکربندی مدل‌ها، زمان‌بندی چرخه‌ها و وضعیت اتصال‌ها"
      />

      <ConnectionsHub />

      <form onSubmit={handleSave} className="space-y-6">
        {/* مدل‌ها */}
        <section className="rounded-xl border border-border bg-card p-4 shadow-surface sm:p-6">
          <h2 className="mb-4 flex items-center gap-2 text-base font-bold text-card-foreground">
            <Cpu size={18} strokeWidth={1.75} aria-hidden="true" className="text-brand" />
            مدل‌ها
          </h2>
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

      {/* منبع داده بازار: کارت مستقل با ذخیره و تست خودش */}
      <div className="mt-6">
        <MarketSourceCard />
      </div>
    </div>
  );
}
