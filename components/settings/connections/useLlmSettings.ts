"use client";

import { useEffect, useRef, useState } from "react";
import { faDigits } from "@/lib/format";
import type {
  MaskedEndpoint,
  TeamModelEntry,
  EndpointTestResult,
  SaveState,
  AutoAssignResult,
} from "./llm-types";

/**
 * منطق مشترک پنل‌های «درگاه‌ها» و «مدل‌های هوش مصنوعی».
 * همه‌ی stateها و فراخوانی‌های API اینجاست تا بین دو پنل تکرار نشود.
 */
export function useLlmSettings() {
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [endpoints, setEndpoints] = useState<MaskedEndpoint[]>([]);
  const [teamModels, setTeamModels] = useState<Record<string, TeamModelEntry>>({});
  const [defaultModel, setDefaultModel] = useState<TeamModelEntry | null>(null);
  const [autoAssigning, setAutoAssigning] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);
  const [autoResult, setAutoResult] = useState<AutoAssignResult | null>(null);
  const [embeddingModel, setEmbeddingModel] = useState<TeamModelEntry | null>(null);
  const [modelsCache, setModelsCache] = useState<Record<string, string[]>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, EndpointTestResult>>({});
  const [loadingModels, setLoadingModels] = useState<Record<string, boolean>>({});
  /* سلامت مدل‌ها: endpointId -> model -> { ok, message } */
  const [modelHealth, setModelHealth] = useState<
    Record<string, Record<string, { ok: boolean; message: string }>>
  >({});
  const [healthLoading, setHealthLoading] = useState<Record<string, boolean>>({});
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
  const [ptPrompt, setPtPrompt] = useState("در یک جمله بگو کی هستی.");
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
            // انتخاب‌گرهای مدل از اول پر باشند.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        const models = d.models as string[];
        setModelsCache((m) => ({ ...m, [endpointId]: models }));
        void ensureModelHealth(endpointId, models);
      }
    } catch {
      // بی‌صدا؛ کاربر می‌تواند مدل را دستی تایپ کند
    } finally {
      setLoadingModels((m) => ({ ...m, [endpointId]: false }));
    }
  }

  /**
   * تست سلامت مدل‌های یک درگاه. force=true کش ۲۴ ساعته را نادیده می‌گیرد.
   * فقط نتیجه‌ی { ok, message } در حافظه‌ی کلاینت نگه داشته می‌شود؛ کلیدی لو نمی‌رود.
   */
  async function ensureModelHealth(
    endpointId: string,
    models: string[],
    force = false,
  ) {
    if (!endpointId || models.length === 0 || healthLoading[endpointId]) return;
    setHealthLoading((m) => ({ ...m, [endpointId]: true }));
    try {
      const res = await fetch(
        `/api/settings/llm/${encodeURIComponent(endpointId)}/models-health`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ models, force }),
        },
      );
      const body = await res.json();
      const d = body?.data;
      if (res.ok && body?.ok !== false && d?.health && typeof d.health === "object") {
        setModelHealth((m) => ({ ...m, [endpointId]: d.health }));
      }
    } catch {
      // بی‌صدا؛ فهرست مدل‌ها همچنان کامل نشان داده می‌شود
    } finally {
      setHealthLoading((m) => ({ ...m, [endpointId]: false }));
    }
  }

  /** «تست دوباره»: فهرست مدل‌های درگاه را می‌گیرد و همه را دوباره تست می‌کند */
  async function handleRetestModels(endpointId: string) {
    let models = modelsCache[endpointId];
    if (!models) {
      try {
        const res = await fetch(
          `/api/settings/llm/${encodeURIComponent(endpointId)}/test`,
          { method: "POST" },
        );
        const body = await res.json();
        const d = body?.data;
        if (res.ok && body?.ok !== false && d?.ok && Array.isArray(d.models)) {
          models = d.models as string[];
          setModelsCache((m) => ({ ...m, [endpointId]: models as string[] }));
        }
      } catch {
        return;
      }
    }
    if (models && models.length > 0) {
      await ensureModelHealth(endpointId, models, true);
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
      setModelHealth((m) => {
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
            const models = d.models as string[];
            setModelsCache((m) => ({ ...m, [id]: models }));
            void ensureModelHealth(id, models);
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
      const savedMap = d?.teamModels;
      if (savedMap && typeof savedMap === "object") {
        setTeamModels(savedMap as Record<string, TeamModelEntry>);
      }
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

  /** نام نمایشی یک درگاه */
  const epName = (id: string): string =>
    endpoints.find((e) => e.id === id)?.name ?? "-";

  /** گزینه‌های درگاه برای سلکت‌ها؛ گزینه خالی همیشه قابل انتخاب است (پاک کردن) */
  const endpointOptions = (emptyLabel: string) => [
    { value: "", label: emptyLabel },
    ...endpoints.map((ep) => ({ value: ep.id, label: ep.name })),
  ];

  /**
   * فقط مدل‌های سالم یک درگاه برای فهرست انتخاب. تا وقتی نتیجه‌ی تست سلامت
   * نیامده، فهرست کامل /models نشان داده می‌شود تا کاربر گیر نکند.
   */
  const healthyModelsFor = (endpointId: string): string[] | undefined => {
    const cached = modelsCache[endpointId];
    if (!cached) return undefined;
    const h = modelHealth[endpointId];
    if (!h) return cached;
    const healthy = cached.filter((m) => h[m]?.ok);
    return healthy.length > 0 ? healthy : cached;
  };

  return {
    loading,
    connected,
    endpoints,
    teamModels,
    defaultModel,
    autoAssigning,
    autoError,
    autoResult,
    embeddingModel,
    modelsCache,
    testing,
    testResults,
    loadingModels,
    modelHealth,
    healthLoading,
    addName,
    setAddName,
    addBase,
    setAddBase,
    addKey,
    setAddKey,
    adding,
    confirmDeleteId,
    setConfirmDeleteId,
    saveState,
    defaultSave,
    embeddingSave,
    errorMsg,
    ptEndpoint,
    setPtEndpoint,
    ptModel,
    setPtModel,
    ptPrompt,
    setPtPrompt,
    ptSending,
    ptResult,
    setPtResult,
    ensureModels,
    ensureModelHealth,
    handleRetestModels,
    handleAdd,
    handleDelete,
    handleTest,
    handleTeamEndpoint,
    handleTeamModel,
    handleAutoAssign,
    handleDefaultEndpoint,
    handleDefaultModel,
    handleDefaultModelBlur,
    handleEmbeddingEndpoint,
    handleEmbeddingModel,
    handleEmbeddingModelBlur,
    handlePromptTest,
    epName,
    endpointOptions,
    healthyModelsFor,
  };
}

export type LlmSettings = ReturnType<typeof useLlmSettings>;
