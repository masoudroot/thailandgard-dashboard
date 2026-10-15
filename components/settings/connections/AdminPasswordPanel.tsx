"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import {
  ConnectionRow,
  WhereGuide,
  PrimaryButton,
  ResultNote,
  inputClass,
  type ConnState,
} from "./ConnectionRow";

/** پنل «رمز ادمین»: تغییر رمز ورود پنل */
export function AdminPasswordPanel() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function handleChange() {
    setResult(null);
    if (!current || !next || !repeat) {
      setResult({ ok: false, text: "هر سه فیلد را پر کنید." });
      return;
    }
    if (next.length < 8) {
      setResult({ ok: false, text: "رمز تازه باید حداقل ۸ کاراکتر باشد." });
      return;
    }
    if (next !== repeat) {
      setResult({ ok: false, text: "تکرار رمز با رمز تازه یکی نیست." });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/settings/admin-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? "تغییر رمز انجام نشد؛ دوباره تلاش کنید.");
      }
      setCurrent("");
      setNext("");
      setRepeat("");
      setResult({ ok: true, text: String(body?.data?.message ?? "رمز تغییر کرد.") });
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : "تغییر رمز انجام نشد؛ دوباره تلاش کنید." });
    } finally {
      setSaving(false);
    }
  }

  const state: ConnState = "ok";

  return (
    <ConnectionRow
      icon={KeyRound}
      title="رمز ادمین"
      hint="رمز ورود به پنل داشبورد"
      state={state}
      statusText="فعال"
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="admin-cur" className="mb-1.5 block text-sm font-medium text-foreground">
            رمز فعلی
          </label>
          <input
            id="admin-cur"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className={inputClass}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="admin-new" className="mb-1.5 block text-sm font-medium text-foreground">
              رمز تازه
            </label>
            <input
              id="admin-new"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="admin-repeat" className="mb-1.5 block text-sm font-medium text-foreground">
              تکرار رمز تازه
            </label>
            <input
              id="admin-repeat"
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          حداقل ۸ کاراکتر. بعد از تغییر، نشست‌های قبلی باطل می‌شوند.
        </p>

        {result && <ResultNote ok={result.ok} text={result.text} />}

        <div>
          <PrimaryButton
            onClick={handleChange}
            disabled={saving}
          >
            {saving ? "در حال تغییر…" : "تغییر رمز"}
          </PrimaryButton>
        </div>

        <WhereGuide
          steps={[
            "رمز فعلی را وارد کنید (اگر اول بار است، همان رمزی که در متغیر ADMIN_PASSWORD ورسل ست شده).",
            "رمز تازه را دو بار بنویسید و «تغییر رمز» را بزنید.",
            "از این پس ورود با رمز تازه است؛ رمز قبلی دیگر کار نمی‌کند.",
          ]}
        />
      </div>
    </ConnectionRow>
  );
}
