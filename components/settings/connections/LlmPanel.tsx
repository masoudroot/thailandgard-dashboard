"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Plus, RefreshCw, Send, Sparkles, Trash2 } from "lucide-react";
import { SkeletonLines } from "@/components/Skeleton";
import { Button } from "@/components/ui/Button";
import { Input, Field } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Badge } from "@/components/ui/Badge";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { TEAMS } from "@/lib/types";
import { TEAM_META } from "@/lib/team-meta";
import { faDigits } from "@/lib/format";
import {
  ConnectionRow,
  WhereGuide,
  ResultNote,
  type ConnState,
} from "./ConnectionRow";


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
  /* انتخاب خودکار مدل‌ها با هوش مصنوعی */
  const [autoAssigning, setAutoAssigning] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);
  const [autoResult, setAutoResult] = useState<{
    assignments: { team: string; faName: string; endpointId: string; endpointName: string; model: string; reason: string }[];
    skipped: { team: string; faName: string; reason: string }[];
  } | null>(null);
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

  /** انتخاب خودکار مدل هر تیم با مدل پیش‌فرض سامانه. */
  async function handleAutoAssign() {
    setAutoAssigning(true);
    setAutoError(null);
    setAutoResult(null);
    try {
      const res = await fetch("/api/settings/llm/auto-assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelsCache }),
      });
      const body = await res.json().catch(() => ({}));
      const d = body?.data;
      if (!res.ok || body?.ok === false) {
        throw new Error(d?.message ?? body?.error?.message ?? "انتخاب خودکار انجام نشد؛ دوباره تلاش کنید.");
      }
      const assignments = Array.isArray(d?.assignments) ? d.assignments : [];
      const skipped = Array.isArray(d?.skipped) ? d.skipped : [];
      // سلکت‌ها را با همان چیزی که ذخیره شد به‌روز کن
      const savedMap = d?.teamModels;
      if (savedMap && typeof savedMap === "object") {
        setTeamModels(savedMap as Record<string, TeamModelEntry>);
      }
      // کش مدل‌ها را با آنچه سرور خواند کامل کن تا فهرست مدل‌ها پر باشند
      const fetched = d?.modelsFetched;
      if (fetched && typeof fetched === "object") {
        setModelsCache((m) => ({ ...m, ...(fetched as Record<string, string[]>) }));
      }
      setAutoResult({ assignments, skipped });
    } catch (err) {
      setAutoError(err instanceof Error ? err.message : "انتخاب خودکار انجام نشد؛ دوباره تلاش کنید.");
    } finally {
      setAutoAssigning(false);
    }
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

  /** گزینه‌های درگاه برای سلکت‌ها؛ گزینه خالی همیشه قابل انتخاب است (پاک کردن) */
  const endpointOptions = (emptyLabel: string) => [
    { value: "", label: emptyLabel },
    ...endpoints.map((ep) => ({ value: ep.id, label: ep.name })),
  ];

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

      <details className="mb-4 rounded-lg border border-border bg-background px-3 py-2.5">
        <summary className="cursor-pointer text-sm font-medium text-foreground">
          راهنمای قدم‌به‌قدم
        </summary>
        <ol className="mt-2 list-decimal space-y-1.5 pe-4 ps-5 text-xs leading-6 text-muted-foreground marker:text-brand">
          <li>در بخش «افزودن درگاه»، نام، آدرس base URL و کلید API درگاه را وارد و «افزودن درگاه» را بزنید.</li>
          <li>روی هر درگاه «تست اتصال» را بزنید؛ اگر سالم باشد، فهرست مدل‌های آن درگاه خودکار خوانده می‌شود.</li>
          <li>در «مدل پیش‌فرض سامانه»، درگاه را انتخاب کنید؛ فهرست مدل‌های همان درگاه می‌آید و یکی را برگزینید.</li>
          <li>در «مدل امبدینگ» هم همین کار را برای مدل امبدینگ انجام دهید.</li>
          <li>اگر تیمی مدل خاصی می‌خواهد، در «مدل هر تیم» برای همان تیم درگاه و مدل جدا انتخاب کنید؛ بقیه تیم‌ها از پیش‌فرض استفاده می‌کنند.</li>
          <li>با «تست واقعی» یک پرامپت کوتاه بفرستید و از سالم بودن مطمئن شوید.</li>
        </ol>
      </details>

      {loading ? (
        <div aria-busy="true"><SkeletonLines lines={3} /><span className="sr-only">در حال بارگذاری…</span></div>
      ) : !connected ? (
        <div className="rounded-lg border border-dashed border-border bg-card px-4 py-8 text-center">
          <p className="text-sm font-bold text-foreground">متصل نیست</p>
          <p className="mx-auto mt-1 max-w-md text-sm leading-7 text-muted-foreground">
            برای مدیریت مدل‌ها باید پایگاه داده وصل باشد. اتصال را بررسی کنید و دوباره تلاش کنید.
          </p>
          <Button variant="outline" size="lg" onClick={() => window.location.reload()} className="mt-4">
            تلاش دوباره
          </Button>
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
                        <Badge
                          variant={r ? (r.ok ? "success" : "destructive") : "secondary"}
                          className="shrink-0 gap-1.5"
                        >
                          <span className="h-2 w-2 rounded-full bg-current" aria-hidden="true" />
                          {r ? (r.ok ? "سالم" : "خطا") : "تست نشده"}
                        </Badge>
                      </div>
                      {r && (
                        <div className="mt-2">
                          <ResultNote
                            ok={r.ok}
                            text={r.message + (r.latencyMs != null ? ` (${faDigits(r.latencyMs)} میلی‌ثانیه)` : "")}
                          />
                        </div>
                      )}
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <Button
                          variant="outline"
                          onClick={() => handleTest(ep.id)}
                          disabled={!!testing[ep.id]}
                        >
                          <RefreshCw strokeWidth={1.75} aria-hidden="true" />
                          {testing[ep.id] ? "در حال تست…" : "تست اتصال"}
                        </Button>
                        <Button
                          variant="destructive"
                          onClick={() => setConfirmDeleteId(ep.id)}
                        >
                          <Trash2 strokeWidth={1.75} aria-hidden="true" />
                          حذف درگاه
                        </Button>
                      </div>
                      <AlertDialog
                        open={confirmDeleteId === ep.id}
                        onOpenChange={(o) => { if (!o) setConfirmDeleteId(null); }}
                        title={`درگاه «${ep.name}» حذف شود؟`}
                        description="تیم‌هایی که از آن استفاده می‌کنند به حالت پیش‌فرض برمی‌گردند."
                        confirmText="حذف درگاه"
                        destructive
                        onConfirm={() => handleDelete(ep.id)}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* ── افزودن درگاه ── */}
          <div className="rounded-lg border border-border bg-card px-3 py-4">
            <h3 className="mb-3 flex items-center gap-1.5 text-sm font-bold text-foreground">
              <Plus size={15} strokeWidth={2} aria-hidden="true" />
              افزودن درگاه
            </h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="نام" htmlFor="llm-ep-name">
                <Input
                  id="llm-ep-name"
                  type="text"
                  placeholder="مثلاً reformboss"
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                />
              </Field>
              <Field label="آدرس base URL" htmlFor="llm-ep-base">
                <Input
                  id="llm-ep-base"
                  type="url"
                  dir="ltr"
                  placeholder="https://api.example.com/v1"
                  value={addBase}
                  onChange={(e) => setAddBase(e.target.value)}
                />
              </Field>
              <Field label="کلید API" htmlFor="llm-ep-key">
                <Input
                  id="llm-ep-key"
                  type="password"
                  dir="ltr"
                  autoComplete="off"
                  placeholder="sk-..."
                  value={addKey}
                  onChange={(e) => setAddKey(e.target.value)}
                />
              </Field>
            </div>
            <Button variant="default" size="lg" onClick={handleAdd} disabled={adding} className="mt-3">
              {adding ? "در حال ذخیره…" : "افزودن درگاه"}
            </Button>
          </div>

          {/* ── مدل پیش‌فرض سامانه ── */}
          <div className="rounded-lg border border-border bg-card px-3 py-4">
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
              <Field label="درگاه" htmlFor="llm-default-ep">
                <Select
                  id="llm-default-ep"
                  value={defaultModel?.endpointId ?? ""}
                  onChange={(e) => handleDefaultEndpoint(e.target.value)}
                  options={endpointOptions("انتخاب نشده")}
                />
              </Field>
              <Field
                label={
                  <>
                    مدل
                    {defaultModel?.endpointId && defCached && (
                      <span> ({faDigits(defCached.length)} مدل از درگاه)</span>
                    )}
                  </>
                }
                htmlFor="llm-default-model"
              >
                <Input
                  id="llm-default-model"
                  type="text"
                  dir="ltr"
                  list="llm-default-model-list"
                  placeholder={defaultModel?.endpointId ? "انتخاب یا تایپ مدل…" : "اول یک درگاه انتخاب کنید"}
                  disabled={!defaultModel?.endpointId}
                  value={defaultModel?.model ?? ""}
                  onChange={(e) => handleDefaultModel(e.target.value)}
                  onBlur={handleDefaultModelBlur}
                />
                {defCached && (
                  <datalist id="llm-default-model-list">
                    {defCached.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                )}
              </Field>
            </div>
            <div className="mt-2">
              <SaveNote state={defaultSave} />
            </div>
          </div>

          {/* ── مدل امبدینگ ── */}
          <div className="rounded-lg border border-border bg-card px-3 py-4">
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
              <Field label="درگاه" htmlFor="llm-emb-ep">
                <Select
                  id="llm-emb-ep"
                  value={embeddingModel?.endpointId ?? ""}
                  onChange={(e) => handleEmbeddingEndpoint(e.target.value)}
                  options={endpointOptions("انتخاب نشده")}
                />
              </Field>
              <Field
                label={
                  <>
                    مدل امبدینگ
                    {embeddingModel?.endpointId && embCached && (
                      <span> ({faDigits(embOnly?.length ?? 0)} مدل امبدینگ از درگاه)</span>
                    )}
                    {embeddingModel?.endpointId && loadingModels[embeddingModel.endpointId] && (
                      <span> (در حال گرفتن فهرست…)</span>
                    )}
                  </>
                }
                htmlFor="llm-emb-model"
              >
                <Input
                  id="llm-emb-model"
                  type="text"
                  dir="ltr"
                  list="llm-emb-model-list"
                  placeholder={embeddingModel?.endpointId ? "انتخاب یا تایپ مدل…" : "اول یک درگاه انتخاب کنید"}
                  disabled={!embeddingModel?.endpointId}
                  value={embeddingModel?.model ?? ""}
                  onChange={(e) => handleEmbeddingModel(e.target.value)}
                  onBlur={handleEmbeddingModelBlur}
                />
                {embOnly && embOnly.length > 0 && (
                  <datalist id="llm-emb-model-list">
                    {embOnly.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                )}
              </Field>
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
            <Button
              variant="default"
              onClick={handleAutoAssign}
              disabled={autoAssigning}
              aria-busy={autoAssigning || undefined}
              className="mb-3"
            >
              <Sparkles size={16} strokeWidth={2} aria-hidden="true" />
              {autoAssigning ? "در حال بررسی مدل‌ها…" : "انتخاب خودکار با هوش مصنوعی"}
            </Button>
            {autoError && (
              <p className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-6 text-destructive">
                {autoError}
              </p>
            )}
            {autoResult && (
              <div className="mb-3 rounded-lg border border-border bg-card px-3 py-3">
                <p className="mb-2 text-xs font-bold text-foreground">
                  نتیجه انتخاب خودکار ({faDigits(autoResult.assignments.length)} تیم)
                </p>
                <ul className="space-y-2">
                  {autoResult.assignments.map((a) => (
                    <li key={a.team} className="text-xs leading-6">
                      <span className="font-bold text-foreground">{a.faName}</span>
                      <span className="text-muted-foreground"> ← {a.endpointName} ← </span>
                      <span dir="ltr" className="font-mono text-foreground">{a.model}</span>
                      <span className="block text-muted-foreground">{a.reason}</span>
                    </li>
                  ))}
                </ul>
                {autoResult.skipped.length > 0 && (
                  <p className="mt-2 text-xs leading-6 text-muted-foreground">
                    رد شد: {autoResult.skipped.map((s) => `${s.faName} (${s.reason})`).join("؛ ")}
                  </p>
                )}
              </div>
            )}
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
                      <Field label="درگاه" htmlFor={`llm-team-ep-${team}`}>
                        <Select
                          id={`llm-team-ep-${team}`}
                          value={epId}
                          onChange={(e) => handleTeamEndpoint(team, e.target.value)}
                          options={endpointOptions("پیش‌فرض سامانه")}
                        />
                      </Field>
                      <Field
                        label={
                          <>
                            مدل
                            {epId && cached && (
                              <span> ({faDigits(cached.length)} مدل از درگاه)</span>
                            )}
                            {epId && loadingModels[epId] && (
                              <span> (در حال گرفتن فهرست…)</span>
                            )}
                          </>
                        }
                        htmlFor={`llm-team-model-${team}`}
                      >
                        <Input
                          id={`llm-team-model-${team}`}
                          type="text"
                          dir="ltr"
                          list={listId}
                          placeholder={epId ? "انتخاب یا تایپ مدل…" : "اول یک درگاه انتخاب کنید"}
                          disabled={!epId}
                          value={entry?.model ?? ""}
                          onChange={(e) => handleTeamModel(team, e.target.value)}
                        />
                        {cached && (
                          <datalist id={listId}>
                            {cached.map((m) => (
                              <option key={m} value={m} />
                            ))}
                          </datalist>
                        )}
                      </Field>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* ── تست واقعی ── */}
          <div className="rounded-lg border border-border bg-card px-3 py-4">
            <h3 className="mb-1 text-sm font-bold text-foreground">تست واقعی</h3>
            <p className="mb-3 text-xs leading-6 text-muted-foreground">
              یک پرامپت کوتاه به درگاه و مدل انتخاب‌شده می‌فرستد و پاسخ واقعی را
              نشان می‌دهد.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="درگاه" htmlFor="llm-pt-ep">
                <Select
                  id="llm-pt-ep"
                  value={ptEndpoint}
                  onChange={(e) => {
                    setPtEndpoint(e.target.value);
                    setPtModel("");
                    setPtResult(null);
                    if (e.target.value) void ensureModels(e.target.value);
                  }}
                  options={endpointOptions("انتخاب کنید")}
                />
              </Field>
              <Field
                label={
                  <>
                    مدل
                    {ptEndpoint && ptCached && (
                      <span> ({faDigits(ptCached.length)} مدل از درگاه)</span>
                    )}
                  </>
                }
                htmlFor="llm-pt-model"
              >
                <Input
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
                />
                {ptCached && (
                  <datalist id="llm-pt-model-list">
                    {ptCached.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                )}
              </Field>
            </div>
            <Field label="پرامپت آزمایشی" htmlFor="llm-pt-prompt" className="mt-3">
              <Textarea
                id="llm-pt-prompt"
                rows={2}
                value={ptPrompt}
                onChange={(e) => setPtPrompt(e.target.value)}
              />
            </Field>
            <Button
              variant="default"
              size="lg"
              onClick={handlePromptTest}
              disabled={ptSending || !ptEndpoint || !ptModel.trim() || !ptPrompt.trim()}
              className="mt-3"
            >
              <Send strokeWidth={2} aria-hidden="true" />
              {ptSending ? "در حال ارسال…" : "ارسال تست"}
            </Button>
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

          {errorMsg && <ResultNote ok={false} text={errorMsg} />}
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
