"use client";

import { useEffect, useState } from "react";
import { GitBranch, RefreshCw } from "lucide-react";
import { SkeletonLines } from "@/components/Skeleton";
import {
  ConnectionRow,
  WhereGuide,
  inputClass,
  type ConnState,
} from "./ConnectionRow";

export function GithubPanel() {
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
        throw new Error(body?.error?.message ?? "ذخیره انجام نشد؛ دوباره تلاش کنید.");
      }
      const d = body?.data;
      setConnected(!!d?.connected);
      setUser(typeof d?.user === "string" ? d.user : null);
      setToken("");
      setMessage({ ok: true, text: String(d?.message ?? "گیت‌هاب متصل شد.") });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "ذخیره انجام نشد؛ دوباره تلاش کنید." });
    } finally {
      setSaving(false);
    }
  }

  const rowState: ConnState = loading ? "loading" : connected ? "ok" : "fail";
  const rowStatus = loading
    ? "در حال بررسی…"
    : connected && user
      ? `متصل (${user})`
      : connected
        ? "متصل"
        : "متصل نیست";

  return (
    <ConnectionRow
      icon={GitBranch}
      title="گیت‌هاب"
      hint="تاریخچه تغییرات سایت و دستیار فنی"
      state={rowState}
      statusText={rowStatus}
    >
      <p className="mb-4 text-xs leading-6 text-muted-foreground">
        توکن شخصی گیت‌هاب برای خواندن «تاریخچه تغییرات سایت» و «دستیار فنی».
      </p>

      {loading ? (
        <div aria-busy="true"><SkeletonLines lines={3} /><span className="sr-only">در حال بارگذاری…</span></div>
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
              اول اتصال با همین توکن تست می‌شود و فقط در صورت موفق بودن ذخیره می‌شود.
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
              className="min-h-12 rounded-lg bg-primary px-6 py-2.5 text-sm font-bold text-primary-foreground shadow-control transition-opacity hover:opacity-90 disabled:opacity-50"
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
              className="min-h-12 rounded-lg border border-input bg-background px-6 py-2.5 text-sm font-medium text-foreground shadow-control transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              بررسی دوباره وضعیت
            </button>
          </div>
        </div>
      )}
      <div className="mt-4">
        <WhereGuide
          steps={[
            "به github.com/settings/tokens بروید و یک توکن تازه با دسترسی repo بسازید.",
            "توکن را در فیلد بالا بچسبانید و «ذخیره و اتصال» را بزنید.",
            "اتصال اول با خود گیت‌هاب تست می‌شود و فقط در صورت موفق بودن ذخیره می‌شود.",
          ]}
        />
      </div>
    </ConnectionRow>
  );
}