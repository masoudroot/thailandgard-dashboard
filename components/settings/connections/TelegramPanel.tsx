"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Send, Trash2 } from "lucide-react";
import {
  ConnectionRow,
  WhereGuide,
  PrimaryButton,
  GhostButton,
  ResultNote,
  inputClass,
  type ConnState,
} from "./ConnectionRow";

interface TgStatus {
  connected: boolean;
  chatId: string | null;
  tokenMasked: string | null;
  source: "settings" | "env" | null;
  botUsername: string | null;
  message: string;
}

/** پنل «تلگرام»: توکن بات + آیدی چت + تست واقعی با پیام آزمایشی */
export function TelegramPanel() {
  const [state, setState] = useState<ConnState>("loading");
  const [status, setStatus] = useState<TgStatus | null>(null);
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [sendTest, setSendTest] = useState(true);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function refresh() {
    try {
      const res = await fetch("/api/settings/telegram", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      const d = (body?.data ?? {}) as TgStatus;
      setStatus(d);
      setState(d.connected ? "ok" : "fail");
    } catch {
      setState("fail");
    }
  }

  useEffect(() => {
    void refresh().finally(() => {
      setState((s) => (s === "loading" ? "fail" : s));
    });
  }, []);

  async function handleSave() {
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch("/api/settings/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim(), chatId: chatId.trim(), sendTest }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? "ذخیره انجام نشد؛ دوباره تلاش کنید.");
      }
      const d = (body?.data ?? {}) as TgStatus;
      setStatus(d);
      setState("ok");
      setToken("");
      setResult({ ok: true, text: String(d.message ?? "تلگرام متصل شد.") });
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : "ذخیره انجام نشد؛ دوباره تلاش کنید." });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm("پیکربندی تلگرام از داشبورد حذف شود؟")) return;
    setResult(null);
    try {
      const res = await fetch("/api/settings/telegram", { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) throw new Error(body?.error?.message ?? "حذف انجام نشد.");
      await refresh();
      setResult({ ok: true, text: "حذف شد." });
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : "حذف انجام نشد." });
    }
  }

  const statusText =
    state === "loading"
      ? "در حال بررسی…"
      : status?.connected
        ? `متصل${status.botUsername ? ` (${status.botUsername})` : ""}`
        : "متصل نیست";

  return (
    <ConnectionRow
      icon={Send}
      title="تلگرام"
      hint="بات گزارش‌دهی و اعلان‌ها"
      state={state}
      statusText={statusText}
    >
      <div className="space-y-4">
        {status?.connected && (
          <div className="rounded-lg border border-border bg-background px-3 py-2.5 text-sm">
            <p className="text-muted-foreground">
              چت: <span dir="ltr" className="font-mono text-foreground">{status.chatId}</span>
            </p>
            {status.tokenMasked && (
              <p className="mt-1 text-muted-foreground">
                توکن: <span dir="ltr" className="font-mono text-foreground">{status.tokenMasked}</span>
                {status.source === "env" && " (از متغیر محیطی)"}
              </p>
            )}
          </div>
        )}

        <div>
          <label htmlFor="tg-token" className="mb-1.5 block text-sm font-medium text-foreground">
            توکن بات
          </label>
          <input
            id="tg-token"
            type="password"
            dir="ltr"
            autoComplete="off"
            placeholder="123456:ABC-DEF..."
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="tg-chat" className="mb-1.5 block text-sm font-medium text-foreground">
            آیدی چت
          </label>
          <input
            id="tg-chat"
            type="text"
            dir="ltr"
            inputMode="numeric"
            placeholder="مثلاً 123456789"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            آیدی عددی چت یا کانالی که بات باید در آن پیام بفرستد.
          </p>
        </div>

        <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm text-foreground">
          <input
            type="checkbox"
            checked={sendTest}
            onChange={(e) => setSendTest(e.target.checked)}
            className="h-5 w-5 shrink-0 accent-[var(--brand)]"
          />
          بعد از ذخیره، یک پیام آزمایشی بفرست
        </label>

        {result && <ResultNote ok={result.ok} text={result.text} />}

        <div className="flex flex-col gap-2 sm:flex-row">
          <PrimaryButton onClick={handleSave} disabled={saving || !token.trim() || !chatId.trim()}>
            {saving ? "در حال بررسی…" : "ذخیره و اتصال"}
          </PrimaryButton>
          <GhostButton onClick={() => void refresh()} disabled={state === "loading"}>
            <RefreshCw size={15} strokeWidth={1.75} aria-hidden="true" />
            بررسی دوباره
          </GhostButton>
          {status?.source === "settings" && (
            <GhostButton onClick={() => void handleDelete()}>
              <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
              حذف
            </GhostButton>
          )}
        </div>

        <WhereGuide
          steps={[
            "در تلگرام به @BotFather پیام بدهید، دستور /newbot را بفرستید و توکن را کپی کنید.",
            "به بات تازه‌تان یک پیام بدهید، بعد به @userinfobot پیام بدهید تا آیدی عددی چت را بدهد.",
            "اگر بات در کانال پیام می‌فرستد، اول بات را ادمین کانال کنید.",
          ]}
        />
      </div>
    </ConnectionRow>
  );
}
