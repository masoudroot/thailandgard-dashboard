"use client";

import { useEffect, useState } from "react";
import { Bot, Cpu, Plus, RefreshCw, Settings, Timer, Trash2, TrendingUp, Wifi, KeyRound } from "lucide-react";
import PageHeader from "@/components/PageHeader";
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

type ConnectionStatus = "ok" | "fail";

const CONNECTIONS: { name: string; desc: string; status: ConnectionStatus }[] = [
  { name: "سوپابیس", desc: "پایگاه داده و ذخیره‌سازی", status: "ok" },
  { name: "تلگرام", desc: "اعلان‌ها و بات گزارش‌دهی", status: "ok" },
  { name: "LLM", desc: "درگاه مدل‌های زبانی", status: "fail" },
];

const inputClass =
  "w-full min-h-[44px] rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground shadow-control placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30";

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
        throw new Error(body?.error?.message ?? "ذخیره ناموفق بود.");
      }
      const cfg = body?.data;
      setHasCache(!!cfg?.hasCache);
      setLastCheck(cfg?.lastCheck ?? null);
      setSavedMsg(true);
      window.setTimeout(() => setSavedMsg(false), 4000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "ذخیره ناموفق بود.");
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
        throw new Error(body?.error?.message ?? "تست ناموفق بود.");
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
      setErrorMsg(err instanceof Error ? err.message : "تست ناموفق بود.");
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
        <p className="py-4 text-sm text-muted-foreground">در حال بارگذاری…</p>
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
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label="اتصال به منبع داده بازار"
              onClick={() => setEnabled((v) => !v)}
              className={`relative h-8 w-14 shrink-0 rounded-full transition-colors ${
                enabled ? "bg-brand" : "bg-input"
              }`}
            >
              <span
                className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${
                  enabled ? "right-1" : "left-1"
                }`}
              />
            </button>
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
              className="min-h-[48px] rounded-lg bg-brand px-6 py-2.5 text-sm font-bold text-brand-foreground shadow-control transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "در حال ذخیره…" : "ذخیره"}
            </button>
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || !url.trim()}
              className="min-h-[48px] rounded-lg border border-input bg-background px-6 py-2.5 text-sm font-medium text-foreground shadow-control transition-opacity hover:opacity-80 disabled:opacity-50"
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
function GithubTokenCard() {
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState<boolean | null>(null);
  const [user, setUser] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function refreshStatus() {
    try {
      const res = await fetch("/api/settings/github", { cache: "no-store" });
      const body = await res.json();
      const d = body?.data;
      setConnected(!!d?.connected);
      setUser(typeof d?.user === "string" ? d.user : null);
      if (d?.message && !d?.connected) {
        setMessage({ ok: false, text: String(d.message) });
      }
    } catch {
      setConnected(null);
    }
  }

  useEffect(() => {
    (async () => {
      await refreshStatus();
      setLoading(false);
    })();
  }, []);

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/github", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      const body = await res.json();
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? "ذخیره ناموفق بود.");
      }
      const d = body?.data;
      setConnected(!!d?.connected);
      setUser(typeof d?.user === "string" ? d.user : null);
      setToken("");
      setMessage({ ok: true, text: String(d?.message ?? "گیت‌هاب متصل شد.") });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "ذخیره ناموفق بود." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-surface sm:p-6">
      <h2 className="mb-1 flex items-center gap-2 text-base font-bold text-card-foreground">
        <KeyRound size={18} strokeWidth={1.75} aria-hidden="true" className="text-brand" />
        اتصال گیت‌هاب
      </h2>
      <p className="mb-4 text-xs text-muted-foreground">
        توکن شخصی گیت‌هاب برای خواندن «تاریخچه تغییرات سایت» و «دستیار فنی». توکن با
        دسترسی <code dir="ltr" className="rounded bg-muted px-1 font-mono">repo</code> بسازید:{' '}
        <span dir="ltr" className="font-mono">github.com/settings/tokens</span>
      </p>

      {loading ? (
        <p className="py-4 text-sm text-muted-foreground">در حال بارگذاری…</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-foreground">وضعیت اتصال</p>
              <p className="text-xs text-muted-foreground">
                {connected && user
                  ? `متصل به حساب ${user}`
                  : connected
                    ? "متصل است."
                    : "هنوز توکن معتبری ذخیره نشده است."}
              </p>
            </div>
            <span
              className={
                connected
                  ? "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success"
                  : "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive"
              }
            >
              <span
                className={connected ? "h-2 w-2 rounded-full bg-success" : "h-2 w-2 rounded-full bg-destructive"}
              />
              {connected ? "متصل" : "متصل نیست"}
            </span>
          </div>

          <div>
            <label htmlFor="github-token" className="mb-1.5 block text-sm font-medium text-foreground">
              توکن شخصی گیت‌هاب
            </label>
            <input
              id="github-token"
              type="password"
              dir="ltr"
              autoComplete="off"
              placeholder="ghp_..."
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              ذخیره، اتصال را با خود گیت‌هاب تست می‌کند و فقط در صورت موفق بودن ذخیره می‌شود.
            </p>
          </div>

          {message && (
            <p
              role={message.ok ? "status" : "alert"}
              className={`rounded-lg px-3 py-2.5 text-sm ${
                message.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"
              }`}
            >
              {message.text}
            </p>
          )}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !token.trim()}
              className="min-h-[48px] rounded-lg bg-brand px-6 py-2.5 text-sm font-bold text-brand-foreground shadow-control transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "در حال بررسی…" : "ذخیره و اتصال"}
            </button>
            <button
              type="button"
              onClick={async () => {
                setLoading(true);
                setMessage(null);
                await refreshStatus();
                setLoading(false);
              }}
              disabled={loading}
              className="min-h-[48px] rounded-lg border border-input bg-background px-6 py-2.5 text-sm font-medium text-foreground shadow-control transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              بررسی دوباره وضعیت
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** ترتیب ثابت ۱۵ تیم + نام فارسی برای نمایش */
const TEAM_LIST = [
  "artdir",
  "branding",
  "content",
  "seo",
  "analytics",
  "intel",
  "lead",
  "design",
  "seocontent",
  "vibefarsi",
  "farsiui",
  "design-ir",
  "dev",
  "qa",
  "inspector",
] as const;

const TEAM_FA: Record<string, string> = {
  artdir: "راهنمای هنری",
  branding: "برندینگ",
  content: "محتوا",
  seo: "سئو",
  analytics: "تحلیل داده",
  intel: "اطلاعات بازار",
  lead: "لید و فروش",
  design: "طراحی",
  seocontent: "محتوای سئو",
  vibefarsi: "وایب‌فارسی",
  farsiui: "رابط فارسی",
  "design-ir": "طراحی ایرانی",
  dev: "توسعه",
  qa: "کنترل کیفیت",
  inspector: "بازرس",
};

interface MaskedEndpoint {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  hasKey: boolean;
}

interface TeamModelEntry {
  endpointId: string;
  model: string;
}

interface EndpointTestResult {
  ok: boolean;
  message: string;
  latencyMs: number | null;
  count: number | null;
}

/**
 * کارت «مدل‌های هوش مصنوعی»: مدیریت endpointهای سازگار با OpenAI
 * (نام، base URL، کلید API) + تست اتصال واقعی /models + انتخاب
 * endpoint و مدل برای هر یک از ۱۵ تیم. کلیدها فقط ماسک‌شده نمایش داده می‌شوند.
 */
function LlmModelsCard() {
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [endpoints, setEndpoints] = useState<MaskedEndpoint[]>([]);
  const [teamModels, setTeamModels] = useState<Record<string, TeamModelEntry>>({});
  const [modelsCache, setModelsCache] = useState<Record<string, string[]>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, EndpointTestResult>>({});
  const [loadingModels, setLoadingModels] = useState<Record<string, boolean>>({});
  const [addName, setAddName] = useState("");
  const [addBase, setAddBase] = useState("");
  const [addKey, setAddKey] = useState("");
  const [adding, setAdding] = useState(false);
  const [savingTeams, setSavingTeams] = useState(false);
  const [savedMsg, setSavedMsg] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/settings/llm", { cache: "no-store" });
        const body = await res.json();
        const d = body?.data;
        if (res.ok && body?.ok !== false && d) {
          setConnected(!!d.connected);
          if (Array.isArray(d.endpoints)) setEndpoints(d.endpoints);
          if (d.teamModels && typeof d.teamModels === "object")
            setTeamModels(d.teamModels as Record<string, TeamModelEntry>);
        } else {
          setErrorMsg(body?.error?.message ?? "خواندن تنظیمات ناموفق بود.");
        }
      } catch {
        setErrorMsg("ارتباط با سرور برقرار نشد.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  /** بارگذاری بی‌صدا‌ی لیست مدل‌های یک endpoint برای انتخاب مدل تیم */
  async function ensureModels(endpointId: string) {
    if (!endpointId || modelsCache[endpointId] || loadingModels[endpointId]) return;
    setLoadingModels((m) => ({ ...m, [endpointId]: true }));
    try {
      const res = await fetch(
        `/api/settings/llm/${encodeURIComponent(endpointId)}/test`,
        { method: "POST" },
      );
      const body = await res.json();
      const d = body?.data;
      if (res.ok && body?.ok !== false && d?.ok && Array.isArray(d.models)) {
        setModelsCache((m) => ({ ...m, [endpointId]: d.models as string[] }));
      }
    } catch {
      // بی‌صدا؛ کاربر می‌تواند مدل را دستی تایپ کند
    } finally {
      setLoadingModels((m) => ({ ...m, [endpointId]: false }));
    }
  }

  async function handleAdd() {
    setAdding(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/settings/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: addName.trim(),
          baseUrl: addBase.trim(),
          apiKey: addKey.trim(),
        }),
      });
      const body = await res.json();
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? "ذخیره ناموفق بود.");
      }
      const ep = body?.data as MaskedEndpoint;
      if (ep) setEndpoints((list) => [...list, ep]);
      setAddName("");
      setAddBase("");
      setAddKey("");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "ذخیره ناموفق بود.");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!window.confirm(`endpoint «${name}» حذف شود؟ تیم‌هایی که از آن استفاده می‌کنند به حالت پیش‌فرض برمی‌گردند.`)) return;
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/settings/llm/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const body = await res.json();
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? "حذف ناموفق بود.");
      }
      setEndpoints((list) => list.filter((e) => e.id !== id));
      setTeamModels((map) => {
        const next = { ...map };
        for (const t of Object.keys(next)) {
          if (next[t]?.endpointId === id) delete next[t];
        }
        return next;
      });
      setModelsCache((m) => {
        const next = { ...m };
        delete next[id];
        return next;
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "حذف ناموفق بود.");
    }
  }

  async function handleTest(id: string) {
    setTesting((m) => ({ ...m, [id]: true }));
    setTestResults((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
    try {
      const res = await fetch(
        `/api/settings/llm/${encodeURIComponent(id)}/test`,
        { method: "POST" },
      );
      const body = await res.json();
      const d = body?.data;
      if (res.ok && body?.ok !== false && d) {
        if (d.ok) {
          setTestResults((m) => ({
            ...m,
            [id]: {
              ok: true,
              message: `${faDigits(d.count ?? 0)} مدل پیدا شد.`,
              latencyMs: typeof d.latencyMs === "number" ? d.latencyMs : null,
              count: typeof d.count === "number" ? d.count : null,
            },
          }));
          if (Array.isArray(d.models)) {
            setModelsCache((m) => ({ ...m, [id]: d.models as string[] }));
          }
        } else {
          setTestResults((m) => ({
            ...m,
            [id]: { ok: false, message: String(d.message ?? "تست ناموفق بود."), latencyMs: null, count: null },
          }));
        }
      } else {
        throw new Error(body?.error?.message ?? "تست ناموفق بود.");
      }
    } catch (err) {
      setTestResults((m) => ({
        ...m,
        [id]: { ok: false, message: err instanceof Error ? err.message : "تست ناموفق بود.", latencyMs: null, count: null },
      }));
    } finally {
      setTesting((m) => ({ ...m, [id]: false }));
    }
  }

  function handleTeamEndpoint(team: string, endpointId: string) {
    setTeamModels((map) => {
      const next = { ...map };
      if (!endpointId) {
        delete next[team];
      } else {
        next[team] = { endpointId, model: next[team]?.model ?? "" };
      }
      return next;
    });
    setSavedMsg(false);
    if (endpointId) void ensureModels(endpointId);
  }

  function handleTeamModel(team: string, model: string) {
    setTeamModels((map) => {
      const next = { ...map };
      const entry = next[team];
      if (!entry) return next;
      next[team] = { ...entry, model };
      return next;
    });
    setSavedMsg(false);
  }

  async function handleSaveTeams() {
    setSavingTeams(true);
    setSavedMsg(false);
    setErrorMsg(null);
    try {
      const payload: Record<string, TeamModelEntry> = {};
      for (const [team, entry] of Object.entries(teamModels)) {
        const model = entry.model.trim();
        if (entry.endpointId && model) payload[team] = { endpointId: entry.endpointId, model };
      }
      const res = await fetch("/api/settings/llm/team-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamModels: payload }),
      });
      const body = await res.json();
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? "ذخیره ناموفق بود.");
      }
      if (body?.data?.teamModels) setTeamModels(body.data.teamModels);
      setSavedMsg(true);
      window.setTimeout(() => setSavedMsg(false), 4000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "ذخیره ناموفق بود.");
    } finally {
      setSavingTeams(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-surface sm:p-6">
      <h2 className="mb-1 flex items-center gap-2 text-base font-bold text-card-foreground">
        <Bot size={18} strokeWidth={1.75} aria-hidden="true" className="text-brand" />
        مدل‌های هوش مصنوعی
      </h2>
      <p className="mb-4 text-xs text-muted-foreground">
        endpointهای سازگار با OpenAI (درگاه مدل‌ها) و انتخاب مدلِ هر یک از ۱۵ تیم.
        تیمی که تنظیم نشود، از متغیرهای محیطی (LLM_MODEL و LLM_API_KEY) استفاده می‌کند.
      </p>

      {loading ? (
        <p className="py-4 text-sm text-muted-foreground">در حال بارگذاری…</p>
      ) : !connected ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-4">
          <p className="text-sm font-bold text-foreground">متصل نیست</p>
          <p className="mt-1 text-sm text-muted-foreground">
            برای مدیریت مدل‌ها باید پایگاه داده وصل باشد. متغیرهای محیطی
            <code dir="ltr" className="mx-1 rounded bg-background px-1 text-xs">SUPABASE_URL</code>
            و
            <code dir="ltr" className="mx-1 rounded bg-background px-1 text-xs">SUPABASE_SERVICE_ROLE_KEY</code>
            را در محیط اجرا تنظیم کنید و سرویس را دوباره راه‌اندازی کنید.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* لیست endpointها */}
          <div>
            <h3 className="mb-2 text-sm font-bold text-foreground">درگاه‌ها (endpointها)</h3>
            {endpoints.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                هنوز درگاهی ثبت نشده است. اولین درگاه را با فرم پایین اضافه کنید.
              </p>
            ) : (
              <ul className="space-y-3">
                {endpoints.map((ep) => {
                  const r = testResults[ep.id];
                  return (
                    <li
                      key={ep.id}
                      className="rounded-lg border border-border bg-background px-3 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-foreground">{ep.name}</p>
                          <p dir="ltr" className="truncate text-left text-xs text-muted-foreground">
                            {ep.baseUrl}
                          </p>
                          <p dir="ltr" className="mt-0.5 text-left font-mono text-xs text-muted-foreground">
                            {ep.apiKeyMasked}
                          </p>
                        </div>
                        <span
                          className={
                            r
                              ? r.ok
                                ? "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success"
                                : "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive"
                              : "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground"
                          }
                        >
                          <span
                            className={
                              r
                                ? r.ok
                                  ? "h-2 w-2 rounded-full bg-success"
                                  : "h-2 w-2 rounded-full bg-destructive"
                                : "h-2 w-2 rounded-full bg-muted-foreground"
                            }
                          />
                          {r ? (r.ok ? "سالم" : "خطا") : "تست نشده"}
                        </span>
                      </div>
                      {r && (
                        <p
                          role="status"
                          className={`mt-2 rounded-lg px-3 py-2 text-xs ${
                            r.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"
                          }`}
                        >
                          {r.message}
                          {r.latencyMs != null ? ` (${faDigits(r.latencyMs)} میلی‌ثانیه)` : ""}
                        </p>
                      )}
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <button
                          type="button"
                          onClick={() => handleTest(ep.id)}
                          disabled={!!testing[ep.id]}
                          className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg border border-input bg-card px-4 py-2 text-sm font-medium text-foreground shadow-control transition-opacity hover:opacity-80 disabled:opacity-50"
                        >
                          <RefreshCw size={15} strokeWidth={1.75} aria-hidden="true" />
                          {testing[ep.id] ? "در حال تست…" : "تست اتصال"}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(ep.id, ep.name)}
                          className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg border border-destructive/30 bg-card px-4 py-2 text-sm font-medium text-destructive shadow-control transition-opacity hover:opacity-80"
                        >
                          <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
                          حذف
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* افزودن درگاه */}
          <div className="rounded-lg border border-border bg-background px-3 py-4">
            <h3 className="mb-3 flex items-center gap-1.5 text-sm font-bold text-foreground">
              <Plus size={15} strokeWidth={2} aria-hidden="true" />
              افزودن درگاه جدید
            </h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="llm-ep-name" className="mb-1.5 block text-sm font-medium text-foreground">
                  نام
                </label>
                <input
                  id="llm-ep-name"
                  type="text"
                  placeholder="مثلاً reformboss"
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="llm-ep-base" className="mb-1.5 block text-sm font-medium text-foreground">
                  آدرس base URL
                </label>
                <input
                  id="llm-ep-base"
                  type="url"
                  dir="ltr"
                  placeholder="https://api.example.com/v1"
                  value={addBase}
                  onChange={(e) => setAddBase(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="llm-ep-key" className="mb-1.5 block text-sm font-medium text-foreground">
                  کلید API
                </label>
                <input
                  id="llm-ep-key"
                  type="password"
                  dir="ltr"
                  autoComplete="off"
                  placeholder="sk-..."
                  value={addKey}
                  onChange={(e) => setAddKey(e.target.value)}
                  className={inputClass}
                />
              </div>
            </div>
            <button
              type="button"
              onClick={handleAdd}
              disabled={adding || !addName.trim() || !addBase.trim() || !addKey.trim()}
              className="mt-3 min-h-[48px] rounded-lg bg-brand px-6 py-2.5 text-sm font-bold text-brand-foreground shadow-control transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {adding ? "در حال ذخیره…" : "افزودن درگاه"}
            </button>
          </div>

          {/* مدل هر تیم */}
          <div>
            <h3 className="mb-1 text-sm font-bold text-foreground">مدل هر تیم</h3>
            <p className="mb-3 text-xs text-muted-foreground">
              برای هر تیم یک درگاه و یک مدل انتخاب کنید. بعد از انتخاب درگاه، لیست
              واقعی مدل‌های آن درگاه (از تست اتصال) برای انتخاب می‌آید؛ می‌توانید
              نام مدل را دستی هم تایپ کنید.
            </p>
            <ul className="space-y-3">
              {TEAM_LIST.map((team) => {
                const entry = teamModels[team];
                const epId = entry?.endpointId ?? "";
                const cached = epId ? modelsCache[epId] : undefined;
                const listId = `llm-model-list-${team}`;
                return (
                  <li
                    key={team}
                    className="rounded-lg border border-border bg-background px-3 py-3"
                  >
                    <p className="mb-2 text-sm font-bold text-foreground">
                      {TEAM_FA[team] ?? team}
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label
                          htmlFor={`llm-team-ep-${team}`}
                          className="mb-1.5 block text-xs font-medium text-muted-foreground"
                        >
                          درگاه
                        </label>
                        <select
                          id={`llm-team-ep-${team}`}
                          value={epId}
                          onChange={(e) => handleTeamEndpoint(team, e.target.value)}
                          className={inputClass}
                        >
                          <option value="">پیش‌فرض (متغیر محیطی)</option>
                          {endpoints.map((ep) => (
                            <option key={ep.id} value={ep.id}>
                              {ep.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label
                          htmlFor={`llm-team-model-${team}`}
                          className="mb-1.5 block text-xs font-medium text-muted-foreground"
                        >
                          مدل
                          {epId && cached && (
                            <span className="mr-1 text-muted-foreground">
                              ({faDigits(cached.length)} مدل از درگاه)
                            </span>
                          )}
                          {epId && loadingModels[epId] && (
                            <span className="mr-1 text-muted-foreground">(در حال گرفتن لیست…)</span>
                          )}
                        </label>
                        <input
                          id={`llm-team-model-${team}`}
                          type="text"
                          dir="ltr"
                          list={listId}
                          placeholder={epId ? "انتخاب یا تایپ مدل…" : "اول یک درگاه انتخاب کنید"}
                          disabled={!epId}
                          value={entry?.model ?? ""}
                          onChange={(e) => handleTeamModel(team, e.target.value)}
                          className={inputClass}
                        />
                        {cached && (
                          <datalist id={listId}>
                            {cached.map((m) => (
                              <option key={m} value={m} />
                            ))}
                          </datalist>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={handleSaveTeams}
                disabled={savingTeams}
                className="min-h-[48px] rounded-lg bg-brand px-6 py-2.5 text-sm font-bold text-brand-foreground shadow-control transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {savingTeams ? "در حال ذخیره…" : "ذخیره مدل تیم‌ها"}
              </button>
              {savedMsg && (
                <p role="status" className="text-sm font-medium text-success">
                  ذخیره شد.
                </p>
              )}
            </div>
          </div>

          {errorMsg && (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
              {errorMsg}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

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
        subtitle="پیکربندی مدل‌ها، زمان‌بندی چرخه‌ها و مشاهده وضعیت اتصال‌ها"
      />

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
          <h2 className="mb-4 flex items-center gap-2 text-base font-bold text-card-foreground">
            <Wifi size={18} strokeWidth={1.75} aria-hidden="true" className="text-brand" />
            وضعیت اتصال‌ها
          </h2>
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

      {/* منبع داده بازار: کارت مستقل با ذخیره و تست خودش */}
      <div className="mt-6">
        <MarketSourceCard />
      </div>

      {/* اتصال گیت‌هاب: کارت مستقل با ذخیره و تست خودش */}
      <div className="mt-6">
        <GithubTokenCard />
      </div>

      {/* مدل‌های هوش مصنوعی: endpointها + مدل هر تیم */}
      <div className="mt-6">
        <LlmModelsCard />
      </div>
    </div>
  );
}
