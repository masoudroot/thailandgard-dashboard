"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import { SkeletonLines } from "@/components/Skeleton";
import { TEAMS } from "@/lib/types";
import { TEAM_META } from "@/lib/team-meta";
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
}

type SaveState = "idle" | "saving" | "saved" | "error";

const DEFAULT_PROMPT = "در یک جمله بگو کی هستی.";

function SaveNote({ state }: { state: SaveState }) {
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

/**
 * کارت «مدل‌های هوش مصنوعی»: درگاه‌های OpenAI + مدل پیش‌فرض سامانه +
 * مدل امبدینگ + مدل هر یک از ۱۵ تیم + تست واقعی پرامپت. کلیدها فقط ماسک‌شده نمایش داده می‌شوند.
 */
export function LlmPanel() {
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [endpoints, setEndpoints] = useState<MaskedEndpoint[]>([]);
  const [teamModels, setTeamModels] = useState<Record<string, TeamModelEntry>>({});
  const [defaultModel, setDefaultModel] = useState<TeamModelEntry | null>(null);
  const [embeddingModel, setEmbeddingModel] = useState<TeamModelEntry | null>(null);
  const [modelsCache, setModelsCache] = useState<Record<string, string[]>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, EndpointTestResult>>({});
  const [loadingModels, setLoadingModels] = useState<Record<string, boolean>>({});
  const [addName, setAddName] = useState("");
  const [addBase, setAddBase] = useState("");
  const [addKey, setAddKey] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [defaultSave, setDefaultSave] = useState<SaveState>("idle");
  const [embeddingSave, setEmbeddingSave] = useState<SaveState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // تست واقعی پرامپت
  const [ptEndpoint, setPtEndpoint] = useState("");
  const [ptModel, setPtModel] = useState("");
  const [ptPrompt, setPtPrompt] = useState(DEFAULT_PROMPT);
  const [ptSending, setPtSending] = useState(false);
  const [ptResult, setPtResult] = useState<{ ok: boolean; text: string; latencyMs?: number } | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/settings/llm", { cache: "no-store" });
        const body = await res.json();
        const d = body?.data;
        if (res.ok && body?.ok !== false && d) {
          setConnected(!!d.connected);
          if (Array.isArray(d.endpoints)) {
            setEndpoints(d.endpoints);
            // فهرست واقعی مدل‌های همه‌ی درگاه‌ها را بی‌صدا بگیر تا
            // انتخاب‌گرهای مدل (پیش‌فرض، امبدینگ، تیم‌ها، تست) از اول پر باشند.
            for (const ep of d.endpoints as MaskedEndpoint[]) {
              if (ep?.id) void ensureModels(ep.id);
            }
          }
          if (d.teamModels && typeof d.teamModels === "object")
            setTeamModels(d.teamModels as Record<string, TeamModelEntry>);
          if (d.defaultModel && typeof d.defaultModel === "object")
            setDefaultModel(d.defaultModel as TeamModelEntry);
          if (d.embeddingModel && typeof d.embeddingModel === "object")
            setEmbeddingModel(d.embeddingModel as TeamModelEntry);
        } else {
          setErrorMsg(body?.error?.message ?? "خواندن تنظیمات انجام نشد؛ دوباره تلاش کنید.");
        }
      } catch {
        setErrorMsg("به سرور وصل نشد؛ اتصال اینترنت را بررسی و دوباره تلاش کنید.");
      } finally {
        setLoading(false);
      }
    })();
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  /** بارگذاری بی‌صدا‌ی لیست مدل‌های یک endpoint */
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

  async function persistTeamModels(map: Record<string, TeamModelEntry>) {
    const payload: Record<string, TeamModelEntry> = {};
    for (const [team, entry] of Object.entries(map)) {
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
      throw new Error(body?.error?.message ?? "ذخیره انجام نشد.");
    }
    return body?.data?.teamModels as Record<string, TeamModelEntry> | undefined;
  }

  /** ذخیره خودکار تخصیص تیم‌ها با debounce کوتاه */
  function scheduleTeamSave(next: Record<string, TeamModelEntry>) {
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const saved = await persistTeamModels(next);
        if (saved) setTeamModels(saved);
        setSaveState("saved");
      } catch {
        setSaveState("error");
      }
    }, 700);
  }

  async function handleAdd() {
    if (!addName.trim() || !addBase.trim() || !addKey.trim()) {
      setErrorMsg("نام، آدرس و کلید هر سه لازم‌اند.");
      return;
    }
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

  async function handleDelete(id: string) {
    setDeleting(true);
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
      if (defaultModel?.endpointId === id) setDefaultModel(null);
      if (embeddingModel?.endpointId === id) setEmbeddingModel(null);
      if (ptEndpoint === id) {
        setPtEndpoint("");
        setPtModel("");
      }
      setConfirmDeleteId(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "حذف انجام نشد؛ دوباره تلاش کنید.");
    } finally {
      setDeleting(false);
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
            },
          }));
          if (Array.isArray(d.models)) {
            setModelsCache((m) => ({ ...m, [id]: d.models as string[] }));
          }
        } else {
          setTestResults((m) => ({
            ...m,
            [id]: { ok: false, message: String(d.message ?? "تست اتصال انجام نشد؛ دوباره تلاش کنید."), latencyMs: null },
          }));
        }
      } else {
        throw new Error(body?.error?.message ?? "تست اتصال انجام نشد؛ دوباره تلاش کنید.");
      }
    } catch (err) {
      setTestResults((m) => ({
        ...m,
        [id]: { ok: false, message: err instanceof Error ? err.message : "تست اتصال انجام نشد؛ دوباره تلاش کنید.", latencyMs: null },
      }));
    } finally {
      setTesting((m) => ({ ...m, [id]: false }));
    }
  }

  function handleTeamEndpoint(team: string, endpointId: string) {
    const next = { ...teamModels };
    if (!endpointId) {
      delete next[team];
    } else {
      next[team] = { endpointId, model: next[team]?.model ?? "" };
    }
    setTeamModels(next);
    if (endpointId) void ensureModels(endpointId);
    scheduleTeamSave(next);
  }

  function handleTeamModel(team: string, model: string) {
    const entry = teamModels[team];
    if (!entry) return;
    const next = { ...teamModels, [team]: { ...entry, model } };
    setTeamModels(next);
    scheduleTeamSave(next);
  }

  async function handleDefaultSave(endpointId: string, model: string) {
    setDefaultSave("saving");
    try {
      const res = await fetch("/api/settings/llm/default", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpointId, model }),
      });
      const body = await res.json();
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? "ذخیره انجام نشد.");
      }
      setDefaultModel(body?.data?.defaultModel ?? null);
      setDefaultSave("saved");
    } catch {
      setDefaultSave("error");
    }
  }

  function handleDefaultEndpoint(endpointId: string) {
    if (!endpointId) {
      // پاک کردن پیش‌فرض
      setDefaultSave("saving");
      fetch("/api/settings/llm/default", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear: true }),
      })
        .then(async (res) => {
          const body = await res.json();
          if (!res.ok || body?.ok === false) throw new Error();
          setDefaultModel(null);
          setDefaultSave("saved");
        })
        .catch(() => setDefaultSave("error"));
      return;
    }
    const model = defaultModel?.model ?? "";
    setDefaultModel({ endpointId, model });
    if (model.trim()) void handleDefaultSave(endpointId, model.trim());
    void ensureModels(endpointId);
  }

  function handleDefaultModel(model: string) {
    if (!defaultModel?.endpointId) return;
    setDefaultModel({ endpointId: defaultModel.endpointId, model });
  }

  function handleDefaultModelBlur() {
    if (!defaultModel?.endpointId) return;
    const model = defaultModel.model.trim();
    if (!model) return;
    void handleDefaultSave(defaultModel.endpointId, model);
  }

  async function handleEmbeddingSave(endpointId: string, model: string) {
    setEmbeddingSave("saving");
    try {
      const res = await fetch("/api/settings/llm/embedding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpointId, model }),
      });
      const body = await res.json();
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? "ذخیره انجام نشد.");
      }
      setEmbeddingModel(body?.data?.embeddingModel ?? null);
      setEmbeddingSave("saved");
    } catch {
      setEmbeddingSave("error");
    }
  }

  function handleEmbeddingEndpoint(endpointId: string) {
    if (!endpointId) {
      // پاک کردن مدل امبدینگ
      setEmbeddingSave("saving");
      fetch("/api/settings/llm/embedding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear: true }),
      })
        .then(async (res) => {
          const body = await res.json();
          if (!res.ok || body?.ok === false) throw new Error();
          setEmbeddingModel(null);
          setEmbeddingSave("saved");
        })
        .catch(() => setEmbeddingSave("error"));
      return;
    }
    const model = embeddingModel?.model ?? "";
    setEmbeddingModel({ endpointId, model });
    if (model.trim()) void handleEmbeddingSave(endpointId, model.trim());
    void ensureModels(endpointId);
  }

  function handleEmbeddingModel(model: string) {
    if (!embeddingModel?.endpointId) return;
    setEmbeddingModel({ endpointId: embeddingModel.endpointId, model });
  }

  function handleEmbeddingModelBlur() {
    if (!embeddingModel?.endpointId) return;
    const model = embeddingModel.model.trim();
    if (!model) return;
    void handleEmbeddingSave(embeddingModel.endpointId, model);
  }

  async function handlePromptTest() {
    setPtSending(true);
    setPtResult(null);
    try {
      const res = await fetch("/api/settings/llm/prompt-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpointId: ptEndpoint,
          model: ptModel.trim(),
          prompt: ptPrompt.trim(),
        }),
      });
      const body = await res.json();
      const d = body?.data;
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? "تست انجام نشد؛ دوباره تلاش کنید.");
      }
      setPtResult({ ok: true, text: String(d.text ?? ""), latencyMs: d.latencyMs });
    } catch (err) {
      setPtResult({ ok: false, text: err instanceof Error ? err.message : "تست انجام نشد؛ دوباره تلاش کنید." });
    } finally {
      setPtSending(false);
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

  const ptCached = ptEndpoint ? modelsCache[ptEndpoint] : undefined;
  const defCached = defaultModel?.endpointId ? modelsCache[defaultModel.endpointId] : undefined;
  const embCached = embeddingModel?.endpointId ? modelsCache[embeddingModel.endpointId] : undefined;
  /** فقط مدل‌های امبدینگ همان درگاه (نام شامل embed) */
  const embOnly = embCached?.filter((m) => m.toLowerCase().includes("embed"));

  /** نام نمایشی یک درگاه برای خط «انتخاب فعلی» */
  const epName = (id: string): string =>
    endpoints.find((e) => e.id === id)?.name ?? "-";

  return (
    <ConnectionRow
      icon={Bot}
      title="مدل‌های هوش مصنوعی"
      hint="درگاه‌ها، مدل پیش‌فرض و مدل هر تیم"
      state={rowState}
      statusText={rowStatus}
    >
      <p className="mb-4 text-xs leading-6 text-muted-foreground">
        درگاه‌های سازگار با OpenAI، مدل پیش‌فرض سامانه، مدل امبدینگ و انتخاب
        مدل هر یک از ۱۵ تیم. تیمی که تنظیم نشود، از مدل پیش‌فرض استفاده می‌کند.
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
          {/* ── درگاه‌ها ── */}
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
                  const confirming = confirmDeleteId === ep.id;
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
                      {confirming ? (
                        <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3">
                          <p className="text-sm font-medium text-foreground">
                            درگاه «{ep.name}» حذف شود؟ تیم‌هایی که از آن استفاده می‌کنند به حالت پیش‌فرض برمی‌گردند.
                          </p>
                          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                            <button
                              type="button"
                              onClick={() => handleDelete(ep.id)}
                              disabled={deleting}
                              className="inline-flex min-h-11 items-center justify-center rounded-lg bg-destructive px-5 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50"
                            >
                              {deleting ? "در حال حذف…" : "حذف درگاه"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              disabled={deleting}
                              className="inline-flex min-h-11 items-center justify-center rounded-lg border border-input bg-card px-5 py-2 text-sm font-medium text-foreground hover:opacity-80"
                            >
                              انصراف
                            </button>
                          </div>
                        </div>
                      ) : (
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
                            onClick={() => setConfirmDeleteId(ep.id)}
                            className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-destructive/30 bg-card px-4 py-2 text-sm font-medium text-destructive shadow-control transition-opacity hover:opacity-80"
                          >
                            <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
                            حذف درگاه
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* ── افزودن درگاه ── */}
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
              disabled={adding}
              className="mt-3 min-h-12 rounded-lg bg-primary px-6 py-2.5 text-sm font-bold text-primary-foreground shadow-control transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {adding ? "در حال ذخیره…" : "افزودن درگاه"}
            </button>
          </div>

          {/* ── مدل پیش‌فرض سامانه ── */}
          <div className="rounded-lg border border-border bg-background px-3 py-4">
            <h3 className="mb-1 text-sm font-bold text-foreground">مدل پیش‌فرض سامانه</h3>
            <p className="mb-3 text-xs leading-6 text-muted-foreground">
              تیم‌هایی که مدل اختصاصی ندارند از این درگاه و مدل استفاده می‌کنند.
            </p>
            {defaultModel?.endpointId && (
              <p className="mb-3 rounded-lg bg-muted px-3 py-2 text-xs leading-6 text-foreground">
                انتخاب فعلی: درگاه {epName(defaultModel.endpointId)} | مدل{" "}
                <span dir="ltr" className="font-mono">
                  {defaultModel.model || "انتخاب نشده"}
                </span>
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="llm-default-ep" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  درگاه
                </label>
                <select
                  id="llm-default-ep"
                  value={defaultModel?.endpointId ?? ""}
                  onChange={(e) => handleDefaultEndpoint(e.target.value)}
                  className={inputClass}
                >
                  <option value="">انتخاب نشده</option>
                  {endpoints.map((ep) => (
                    <option key={ep.id} value={ep.id}>
                      {ep.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="llm-default-model" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  مدل
                  {defaultModel?.endpointId && defCached && (
                    <span className="me-1">({faDigits(defCached.length)} مدل از درگاه)</span>
                  )}
                </label>
                <input
                  id="llm-default-model"
                  type="text"
                  dir="ltr"
                  list="llm-default-model-list"
                  placeholder={defaultModel?.endpointId ? "انتخاب یا تایپ مدل…" : "اول یک درگاه انتخاب کنید"}
                  disabled={!defaultModel?.endpointId}
                  value={defaultModel?.model ?? ""}
                  onChange={(e) => handleDefaultModel(e.target.value)}
                  onBlur={handleDefaultModelBlur}
                  className={inputClass}
                />
                {defCached && (
                  <datalist id="llm-default-model-list">
                    {defCached.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                )}
              </div>
            </div>
            <div className="mt-2">
              <SaveNote state={defaultSave} />
            </div>
          </div>

          {/* ── مدل امبدینگ ── */}
          <div className="rounded-lg border border-border bg-background px-3 py-4">
            <h3 className="mb-1 text-sm font-bold text-foreground">مدل امبدینگ</h3>
            <p className="mb-3 text-xs leading-6 text-muted-foreground">
              برای جست‌وجوی معنایی در حافظه تیم‌ها. فهرست مدل‌ها فقط مدل‌های
              امبدینگ همان درگاه را نشان می‌دهد.
            </p>
            {embeddingModel?.endpointId && (
              <p className="mb-3 rounded-lg bg-muted px-3 py-2 text-xs leading-6 text-foreground">
                انتخاب فعلی: درگاه {epName(embeddingModel.endpointId)} | مدل{" "}
                <span dir="ltr" className="font-mono">
                  {embeddingModel.model || "انتخاب نشده"}
                </span>
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="llm-emb-ep" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  درگاه
                </label>
                <select
                  id="llm-emb-ep"
                  value={embeddingModel?.endpointId ?? ""}
                  onChange={(e) => handleEmbeddingEndpoint(e.target.value)}
                  className={inputClass}
                >
                  <option value="">انتخاب نشده</option>
                  {endpoints.map((ep) => (
                    <option key={ep.id} value={ep.id}>
                      {ep.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="llm-emb-model" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  مدل امبدینگ
                  {embeddingModel?.endpointId && embCached && (
                    <span className="me-1">({faDigits(embOnly?.length ?? 0)} مدل امبدینگ از درگاه)</span>
                  )}
                  {embeddingModel?.endpointId && loadingModels[embeddingModel.endpointId] && (
                    <span className="me-1">(در حال گرفتن فهرست…)</span>
                  )}
                </label>
                <input
                  id="llm-emb-model"
                  type="text"
                  dir="ltr"
                  list="llm-emb-model-list"
                  placeholder={embeddingModel?.endpointId ? "انتخاب یا تایپ مدل…" : "اول یک درگاه انتخاب کنید"}
                  disabled={!embeddingModel?.endpointId}
                  value={embeddingModel?.model ?? ""}
                  onChange={(e) => handleEmbeddingModel(e.target.value)}
                  onBlur={handleEmbeddingModelBlur}
                  className={inputClass}
                />
                {embOnly && embOnly.length > 0 && (
                  <datalist id="llm-emb-model-list">
                    {embOnly.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                )}
              </div>
            </div>
            {embeddingModel?.endpointId && embCached && (embOnly?.length ?? 0) === 0 && !loadingModels[embeddingModel.endpointId] && (
              <p className="mt-2 text-xs leading-6 text-muted-foreground">
                در فهرست این درگاه مدل امبدینگ پیدا نشد؛ می‌توانید نام مدل را دستی تایپ کنید.
              </p>
            )}
            <div className="mt-2">
              <SaveNote state={embeddingSave} />
            </div>
          </div>

          {/* ── مدل هر تیم ── */}
          <div>
            <div className="mb-1 flex items-center justify-between gap-3">
              <h3 className="text-sm font-bold text-foreground">مدل هر تیم</h3>
              <SaveNote state={saveState} />
            </div>
            <p className="mb-3 text-xs leading-6 text-muted-foreground">
              تغییر هر ردیف بلافاصله ذخیره می‌شود. بعد از انتخاب درگاه، فهرست
              واقعی مدل‌های آن درگاه برای انتخاب می‌آید؛ می‌توانید نام مدل را
              دستی هم تایپ کنید.
            </p>
            <ul className="space-y-3">
              {TEAMS.map((team) => {
                const entry = teamModels[team];
                const epId = entry?.endpointId ?? "";
                const cached = epId ? modelsCache[epId] : undefined;
                const listId = `llm-model-list-${team}`;
                const meta = TEAM_META[team];
                return (
                  <li
                    key={team}
                    className="rounded-lg border border-border bg-background px-3 py-3"
                  >
                    <p className="mb-2 text-sm font-bold text-foreground">
                      {meta?.faName ?? team}
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
                          <option value="">پیش‌فرض سامانه</option>
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
                            <span className="me-1">
                              ({faDigits(cached.length)} مدل از درگاه)
                            </span>
                          )}
                          {epId && loadingModels[epId] && (
                            <span className="me-1">(در حال گرفتن فهرست…)</span>
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
          </div>

          {/* ── تست واقعی ── */}
          <div className="rounded-lg border border-border bg-background px-3 py-4">
            <h3 className="mb-1 text-sm font-bold text-foreground">تست واقعی</h3>
            <p className="mb-3 text-xs leading-6 text-muted-foreground">
              یک پرامپت کوتاه به درگاه و مدل انتخاب‌شده می‌فرستد و پاسخ واقعی را
              نشان می‌دهد.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="llm-pt-ep" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  درگاه
                </label>
                <select
                  id="llm-pt-ep"
                  value={ptEndpoint}
                  onChange={(e) => {
                    setPtEndpoint(e.target.value);
                    setPtModel("");
                    setPtResult(null);
                    if (e.target.value) void ensureModels(e.target.value);
                  }}
                  className={inputClass}
                >
                  <option value="">انتخاب کنید</option>
                  {endpoints.map((ep) => (
                    <option key={ep.id} value={ep.id}>
                      {ep.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="llm-pt-model" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  مدل
                  {ptEndpoint && ptCached && (
                    <span className="me-1">({faDigits(ptCached.length)} مدل از درگاه)</span>
                  )}
                </label>
                <input
                  id="llm-pt-model"
                  type="text"
                  dir="ltr"
                  list="llm-pt-model-list"
                  placeholder={ptEndpoint ? "انتخاب یا تایپ مدل…" : "اول یک درگاه انتخاب کنید"}
                  disabled={!ptEndpoint}
                  value={ptModel}
                  onChange={(e) => {
                    setPtModel(e.target.value);
                    setPtResult(null);
                  }}
                  className={inputClass}
                />
                {ptCached && (
                  <datalist id="llm-pt-model-list">
                    {ptCached.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                )}
              </div>
            </div>
            <div className="mt-3">
              <label htmlFor="llm-pt-prompt" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                پرامپت آزمایشی
              </label>
              <textarea
                id="llm-pt-prompt"
                rows={2}
                value={ptPrompt}
                onChange={(e) => setPtPrompt(e.target.value)}
                className={inputClass}
              />
            </div>
            <button
              type="button"
              onClick={handlePromptTest}
              disabled={ptSending || !ptEndpoint || !ptModel.trim() || !ptPrompt.trim()}
              className="mt-3 inline-flex min-h-12 items-center justify-center gap-1.5 rounded-lg bg-primary px-6 py-2.5 text-sm font-bold text-primary-foreground shadow-control transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <Send size={15} strokeWidth={2} aria-hidden="true" />
              {ptSending ? "در حال ارسال…" : "ارسال تست"}
            </button>
            {ptResult && (
              <div
                role="status"
                className={`mt-3 rounded-lg px-3 py-3 text-sm leading-7 ${
                  ptResult.ok ? "bg-success/10 text-foreground" : "bg-destructive/10 text-destructive"
                }`}
              >
                {ptResult.ok ? (
                  <>
                    <p className="whitespace-pre-wrap">{ptResult.text}</p>
                    {ptResult.latencyMs != null && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        زمان پاسخ: {faDigits(ptResult.latencyMs)} میلی‌ثانیه
                      </p>
                    )}
                  </>
                ) : (
                  ptResult.text
                )}
              </div>
            )}
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
            "با «تست اتصال» از سالم بودن مطمئن شوید، بعد مدل پیش‌فرض و مدل هر تیم را انتخاب کنید.",
          ]}
        />
      </div>
    </ConnectionRow>
  );
}
