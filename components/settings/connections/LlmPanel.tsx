"use client";

import { useEffect, useState } from "react";
import { Bot, Plus, RefreshCw, Trash2 } from "lucide-react";
import { SkeletonLines } from "@/components/Skeleton";
import {
  ConnectionRow,
  WhereGuide,
  inputClass,
  type ConnState,
} from "./ConnectionRow";

/** تبدیل ارقام لاتین به فارسی */
function faDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
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
  artdir: "طراحی ارشد",
  branding: "برند",
  content: "محتوا",
  seo: "سئو",
  analytics: "تحلیل",
  intel: "اطلاعات",
  lead: "لید",
  design: "دیزاین",
  seocontent: "محتوای سئو",
  vibefarsi: "وایب‌فارسی",
  farsiui: "فارسی UI",
  "design-ir": "دیزاین ایرانی",
  dev: "توسعه",
  qa: "کیفیت",
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
export function LlmPanel() {
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
          setErrorMsg(body?.error?.message ?? "خواندن تنظیمات انجام نشد؛ دوباره تلاش کنید.");
        }
      } catch {
        setErrorMsg("به سرور وصل نشد؛ اتصال اینترنت را بررسی و دوباره تلاش کنید.");
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
        throw new Error(body?.error?.message ?? "ذخیره انجام نشد؛ دوباره تلاش کنید.");
      }
      const ep = body?.data as MaskedEndpoint;
      if (ep) setEndpoints((list) => [...list, ep]);
      setAddName("");
      setAddBase("");
      setAddKey("");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "ذخیره انجام نشد؛ دوباره تلاش کنید.");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!window.confirm(`درگاه «${name}» حذف شود؟ تیم‌هایی که از آن استفاده می‌کنند به حالت پیش‌فرض برمی‌گردند.`)) return;
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/settings/llm/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const body = await res.json();
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? "حذف انجام نشد؛ دوباره تلاش کنید.");
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
      setErrorMsg(err instanceof Error ? err.message : "حذف انجام نشد؛ دوباره تلاش کنید.");
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
            [id]: { ok: false, message: String(d.message ?? "تست اتصال انجام نشد؛ دوباره تلاش کنید."), latencyMs: null, count: null },
          }));
        }
      } else {
        throw new Error(body?.error?.message ?? "تست اتصال انجام نشد؛ دوباره تلاش کنید.");
      }
    } catch (err) {
      setTestResults((m) => ({
        ...m,
        [id]: { ok: false, message: err instanceof Error ? err.message : "تست اتصال انجام نشد؛ دوباره تلاش کنید.", latencyMs: null, count: null },
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
        throw new Error(body?.error?.message ?? "ذخیره انجام نشد؛ دوباره تلاش کنید.");
      }
      if (body?.data?.teamModels) setTeamModels(body.data.teamModels);
      setSavedMsg(true);
      window.setTimeout(() => setSavedMsg(false), 4000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "ذخیره انجام نشد؛ دوباره تلاش کنید.");
    } finally {
      setSavingTeams(false);
    }
  }

  const rowState: ConnState = loading ? "loading" : connected ? "ok" : "fail";
  const rowStatus = loading
    ? "در حال بررسی…"
    : connected && endpoints.length > 0
      ? `متصل (${faDigits(endpoints.length)} درگاه)`
      : connected
        ? "متصل (بدون درگاه)"
        : "متصل نیست";

  return (
    <ConnectionRow
      icon={Bot}
      title="مدل‌های هوش مصنوعی"
      hint="درگاه‌های OpenAI و مدل هر تیم"
      state={rowState}
      statusText={rowStatus}
    >
      <p className="mb-4 text-xs leading-6 text-muted-foreground">
        درگاه‌های سازگار با OpenAI و انتخاب مدل هر یک از ۱۵ تیم.
        تیمی که تنظیم نشود، از تنظیمات پیش‌فرض سامانه استفاده می‌کند.
      </p>

      {loading ? (
        <div aria-busy="true"><SkeletonLines lines={3} /><span className="sr-only">در حال بارگذاری…</span></div>
      ) : !connected ? (
        <div className="rounded-lg border border-dashed border-border bg-card px-4 py-8 text-center">
          <p className="text-sm font-bold text-foreground">متصل نیست</p>
          <p className="mx-auto mt-1 max-w-md text-sm leading-7 text-muted-foreground">
            برای مدیریت مدل‌ها باید پایگاه داده وصل باشد. اتصال را بررسی کنید و دوباره تلاش کنید.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 inline-flex min-h-11 items-center justify-center rounded-xl bg-primary px-6 py-2 text-sm font-bold text-primary-foreground hover:opacity-90"
          >
            تلاش دوباره
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {/* لیست endpointها */}
          <div>
            <h3 className="mb-2 text-sm font-bold text-foreground">درگاه‌ها</h3>
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
                          <p dir="ltr" className="truncate text-start text-xs text-muted-foreground">
                            {ep.baseUrl}
                          </p>
                          <p dir="ltr" className="mt-0.5 text-start font-mono text-xs text-muted-foreground">
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
                          className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-input bg-card px-4 py-2 text-sm font-medium text-foreground shadow-control transition-opacity hover:opacity-80 disabled:opacity-50"
                        >
                          <RefreshCw size={15} strokeWidth={1.75} aria-hidden="true" />
                          {testing[ep.id] ? "در حال تست…" : "تست اتصال"}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(ep.id, ep.name)}
                          className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-destructive/30 bg-card px-4 py-2 text-sm font-medium text-destructive shadow-control transition-opacity hover:opacity-80"
                        >
                          <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
                          حذف درگاه
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
              افزودن درگاه
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
              className="mt-3 min-h-12 rounded-lg bg-primary px-6 py-2.5 text-sm font-bold text-primary-foreground shadow-control transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {adding ? "در حال ذخیره…" : "افزودن درگاه"}
            </button>
          </div>

          {/* مدل هر تیم */}
          <div>
            <h3 className="mb-1 text-sm font-bold text-foreground">مدل هر تیم</h3>
            <p className="mb-3 text-xs text-muted-foreground">
              برای هر تیم یک درگاه و یک مدل انتخاب کنید. بعد از انتخاب درگاه، فهرست
              واقعی مدل‌های آن درگاه (از آخرین تست اتصال) برای انتخاب می‌آید؛ می‌توانید
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
                            <span className="me-1 text-muted-foreground">
                              ({faDigits(cached.length)} مدل از درگاه)
                            </span>
                          )}
                          {epId && loadingModels[epId] && (
                            <span className="me-1 text-muted-foreground">(در حال گرفتن فهرست…)</span>
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
                className="min-h-12 rounded-lg bg-primary px-6 py-2.5 text-sm font-bold text-primary-foreground shadow-control transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {savingTeams ? "در حال ذخیره…" : "ذخیره مدل‌های تیم‌ها"}
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
      <div className="mt-4">
        <WhereGuide
          steps={[
            "یک درگاه سازگار با OpenAI لازم دارید (مثلاً OpenAI، یا درگاه‌های مشابه).",
            "نام، آدرس base URL و کلید API را در فرم «افزودن درگاه» وارد کنید.",
            "با «تست اتصال» از سالم بودن مطمئن شوید، بعد برای هر تیم مدل را انتخاب کنید.",
          ]}
        />
      </div>
    </ConnectionRow>
  );
}