"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Field } from "@/components/ui/Input";
import {
  ConnectionRow,
  WhereGuide,
  ResultNote,
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
        <Field label="رمز فعلی" htmlFor="admin-cur">
          <Input
            id="admin-cur"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="رمز تازه" htmlFor="admin-new">
            <Input
              id="admin-new"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Field label="تکرار رمز تازه" htmlFor="admin-repeat">
            <Input
              id="admin-repeat"
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">
          حداقل ۸ کاراکتر. بعد از تغییر، نشست‌های قبلی باطل می‌شوند.
        </p>

        {result && <ResultNote ok={result.ok} text={result.text} />}

        <div>
          <Button variant="default" onClick={handleChange} disabled={saving}>
            {saving ? "در حال تغییر…" : "تغییر رمز"}
          </Button>
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
