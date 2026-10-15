"use client";

import { useEffect, useState } from "react";
import { Plus, RefreshCw, Trash2, TrendingUp } from "lucide-react";
import { SkeletonLines } from "@/components/Skeleton";
import { Button } from "@/components/ui/Button";
import { Input, Field, Label } from "@/components/ui/Input";
import { FaNumberInput } from "@/components/ui/FaNumberInput";
import { Switch } from "@/components/ui/Switch";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { faDigits } from "@/lib/format";
import {
  ConnectionRow,
  WhereGuide,
  ResultNote,
  type ConnState,
} from "./ConnectionRow";


interface MarketSourceView {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  hasCache: boolean;
  lastCheck: { ok: boolean; message: string; latencyMs: number | null } | null;
}

type SaveState = "idle" | "saving" | "saved" | "error";

function SaveNote({ state }: { state: SaveState }) {
  if (state === "idle") return null;
  return (
    <p role="status" className="text-xs text-muted-foreground">
      {state === "saving"
        ? "در حال ذخیره…"
        : state === "saved"
          ? "ذخیره شد."
          : "ذخیره انجام نشد؛ دوباره تلاش کنید."}
    </p>
  );
}

/**
 * کارت «منابع داده بازار»: فهرست منابع پیشنهادی کاربر برای تیم تحلیل.
 * این منابع پیشنهادند، نه محدودیت؛ تیم می‌تواند فراتر از آن‌ها هم جست‌وجو کند.
 */
export function MarketPanel() {
  const [loading, setLoading] = useState(true);
  const [sources, setSources] = useState<MarketSourceView[]>([]);
  const [timeoutSec, setTimeoutSec] = useState(30);
  const [addName, setAddName] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/settings/market", { cache: "no-store" });
        const body = await res.json();
        const d = body?.data;
        if (res.ok && body?.ok !== false && d) {
          if (Array.isArray(d.sources)) setSources(d.sources);
          if (typeof d.timeoutSec === "number") setTimeoutSec(d.timeoutSec);
        } else {
          setErrorMsg(body?.error?.message ?? "خواندن تنظیمات انجام نشد.");
        }
      } catch {
        setErrorMsg("به سرور وصل نشد؛ اتصال اینترنت را بررسی کنید.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function persist(next: MarketSourceView[], nextTimeout: number) {
    setSaveState("saving");
    try {
      const res = await fetch("/api/settings/market", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sources: next.map((s) => ({ id: s.id, name: s.name, url: s.url, enabled: s.enabled })),
          timeoutSec: nextTimeout,
        }),
      });
      const body = await res.json();
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? "ذخیره انجام نشد.");
      }
      const d = body?.data;
      if (Array.isArray(d?.sources)) setSources(d.sources);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  function handleAdd() {
    if (!addName.trim() || !addUrl.trim()) {
      setErrorMsg("نام و آدرس منبع هر دو لازم‌اند.");
      return;
    }
    setErrorMsg(null);
    setAdding(true);
    const next: MarketSourceView[] = [
      ...sources,
      {
        id: `new_${Date.now().toString(36)}`,
        name: addName.trim(),
        url: addUrl.trim(),
        enabled: true,
        hasCache: false,
        lastCheck: null,
      },
    ];
    setAddName("");
    setAddUrl("");
    void persist(next, timeoutSec).finally(() => setAdding(false));
  }

  function handleToggle(id: string) {
    const next = sources.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s));
    setSources(next);
    void persist(next, timeoutSec);
  }

  function handleDelete(id: string) {
    const next = sources.filter((s) => s.id !== id);
    setSources(next);
    setConfirmDeleteId(null);
    void persist(next, timeoutSec);
  }

  function handleTimeout(value: string) {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    setTimeoutSec(n);
  }

  function handleTimeoutBlur() {
    const clamped = Math.min(300, Math.max(5, Math.round(timeoutSec)));
    setTimeoutSec(clamped);
    void persist(sources, clamped);
  }

  async function handleTest(id: string) {
    setTesting((m) => ({ ...m, [id]: true }));
    setTestResults((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
    try {
      const res = await fetch("/api/settings/market/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const body = await res.json();
      const d = body?.data;
      if (res.ok && body?.ok !== false && d) {
        setTestResults((m) => ({
          ...m,
          [id]: {
            ok: !!d.ok,
            text:
              String(d.message ?? "") +
              (d.latencyMs != null ? ` (${faDigits(d.latencyMs)} میلی‌ثانیه)` : ""),
          },
        }));
        // به‌روزرسانی وضعیت آخرین بررسی در فهرست
        setSources((list) =>
          list.map((s) =>
            s.id === id
              ? { ...s, lastCheck: { ok: !!d.ok, message: String(d.message ?? ""), latencyMs: d.latencyMs ?? null } }
              : s,
          ),
        );
      } else {
        throw new Error(body?.error?.message ?? "تست انجام نشد.");
      }
    } catch (err) {
      setTestResults((m) => ({
        ...m,
        [id]: { ok: false, text: err instanceof Error ? err.message : "تست انجام نشد." },
      }));
    } finally {
      setTesting((m) => ({ ...m, [id]: false }));
    }
  }

  const activeCount = sources.filter((s) => s.enabled).length;
  const rowState: ConnState = loading ? "loading" : activeCount > 0 ? "ok" : "fail";
  const rowStatus = loading
    ? "در حال بررسی…"
    : activeCount > 0
      ? `${faDigits(activeCount)} منبع فعال`
      : "خاموش";

  return (
    <ConnectionRow
      icon={TrendingUp}
      title="منابع داده بازار"
      hint="داده بیرونی پیشنهادی برای تیم تحلیل"
      state={rowState}
      statusText={rowStatus}
    >
      <p className="mb-4 text-xs leading-6 text-muted-foreground">
        این منابع، پیشنهادهای شما برای تیم تحلیل‌اند؛ تیم می‌تواند برای کامل‌تر
        شدن تحلیلش، فراتر از این‌ها هم جست‌وجو کند. اگر منبعی قطع باشد، از
        آخرین داده‌ی سالم خودش استفاده می‌شود و چرخه نمی‌ایستد.
      </p>

      {loading ? (
        <div aria-busy="true">
          <SkeletonLines lines={3} />
          <span className="sr-only">در حال بارگذاری…</span>
        </div>
      ) : (
        <div className="space-y-4">
          {sources.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
              هنوز منبعی ثبت نشده است. اولین منبع را با فرم پایین اضافه کنید.
            </p>
          ) : (
            <ul className="space-y-3">
              {sources.map((s) => {
                const r = testResults[s.id];
                return (
                  <li key={s.id} className="rounded-lg border border-border bg-background px-3 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold text-foreground">{s.name}</p>
                        <p dir="ltr" className="truncate text-start text-xs text-muted-foreground">
                          {s.url}
                        </p>
                        {s.lastCheck && (
                          <p className={`mt-1 text-xs ${s.lastCheck.ok ? "text-success" : "text-destructive"}`}>
                            {s.lastCheck.ok ? "آخرین تست: سالم" : "آخرین تست: خطا"}
                            {s.lastCheck.latencyMs != null && ` (${faDigits(s.lastCheck.latencyMs)} میلی‌ثانیه)`}
                            {s.hasCache && "؛ کش موجود است"}
                          </p>
                        )}
                      </div>
                      <Switch
                        checked={s.enabled}
                        onCheckedChange={() => handleToggle(s.id)}
                        aria-label={`روشن/خاموش: ${s.name}`}
                      />
                    </div>
                    {r && <ResultNote ok={r.ok} text={r.text} />}
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <Button variant="outline" onClick={() => handleTest(s.id)} disabled={!!testing[s.id]}>
                        <RefreshCw strokeWidth={1.75} aria-hidden="true" />
                        {testing[s.id] ? "در حال تست…" : "تست اتصال"}
                      </Button>
                      <Button variant="destructive" onClick={() => setConfirmDeleteId(s.id)}>
                        <Trash2 strokeWidth={1.75} aria-hidden="true" />
                        حذف
                      </Button>
                    </div>
                    <AlertDialog
                      open={confirmDeleteId === s.id}
                      onOpenChange={(o) => { if (!o) setConfirmDeleteId(null); }}
                      title={`منبع «${s.name}» حذف شود؟`}
                      confirmText="حذف منبع"
                      destructive
                      onConfirm={() => handleDelete(s.id)}
                    />
                  </li>
                );
              })}
            </ul>
          )}

          <div className="rounded-lg border border-border bg-background px-3 py-4">
            <h3 className="mb-3 flex items-center gap-1.5 text-sm font-bold text-foreground">
              <Plus size={15} strokeWidth={2} aria-hidden="true" />
              افزودن منبع
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="نام" htmlFor="market-src-name">
                <Input
                  id="market-src-name"
                  type="text"
                  placeholder="مثلاً نرخ ارز"
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                />
              </Field>
              <Field label="آدرس" htmlFor="market-src-url">
                <Input
                  id="market-src-url"
                  type="url"
                  dir="ltr"
                  placeholder="https://…"
                  value={addUrl}
                  onChange={(e) => setAddUrl(e.target.value)}
                />
              </Field>
            </div>
            <div className="mt-3">
              <Button variant="default" onClick={handleAdd} disabled={adding}>
                {adding ? "در حال ذخیره…" : "افزودن منبع"}
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Label htmlFor="market-timeout" className="text-muted-foreground">
                تایم‌اوت (ثانیه)
              </Label>
              <div className="w-24">
                <FaNumberInput
                  id="market-timeout"
                  min={5}
                  max={300}
                  value={String(timeoutSec)}
                  onChange={(v) => handleTimeout(v)}
                  onBlur={handleTimeoutBlur}
                />
              </div>
            </div>
            <SaveNote state={saveState} />
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
            "آدرس‌هایی بدهید که بدون ورود، متن یا JSON برگردانند (مثل API نرخ ارز یا آب‌وهوا).",
            "هر منبع را جداگانه تست کنید؛ سالم‌ها در چرخه بعدی تیم تحلیل خوانده می‌شوند.",
            "این‌ها پیشنهادند؛ تیم تحلیل می‌تواند خودش هم منبع دیگری پیدا کند.",
          ]}
        />
      </div>
    </ConnectionRow>
  );
}
