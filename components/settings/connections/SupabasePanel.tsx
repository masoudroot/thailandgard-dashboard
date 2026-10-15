"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Database, RefreshCw, Save } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Field } from "@/components/ui/Input";
import {
  ConnectionRow,
  WhereGuide,
  ResultNote,
  type ConnState,
} from "./ConnectionRow";

/** تبدیل ارقام لاتین به فارسی */
function faDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
}

/**
 * پنل «پایگاه داده» (سوپابیس).
 * مقادیر را از فرم می‌گیرد، تست زنده می‌کند و ذخیره می‌کند.
 * نام متغیرهای محیطی فقط در راهنمای جمع‌شونده است.
 */
export function SupabasePanel() {
  const [state, setState] = useState<ConnState>("loading");
  const [statusText, setStatusText] = useState("در حال بررسی…");

  const [url, setUrl] = useState("");
  const [anonKey, setAnonKey] = useState("");
  const [serviceKey, setServiceKey] = useState("");

  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [manual, setManual] = useState<{ steps: string[]; message: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  /** وضعیت اتصال فعلی سرور */
  async function check() {
    try {
      const res = await fetch("/api/settings/supabase/test", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      const configured = body?.data?.configured ?? body?.configured;
      if (typeof configured === "boolean") {
        setState(configured ? "ok" : "fail");
        setStatusText(configured ? "متصل" : "متصل نیست");
        return;
      }
      const okVal = !!body?.data?.connected;
      setState(okVal ? "ok" : "fail");
      setStatusText(okVal ? "متصل" : "متصل نیست");
    } catch {
      setState("fail");
      setStatusText("متصل نیست");
    }
  }

  useEffect(() => {
    void check();
  }, []);

  /** تست با مقادیر فرم */
  async function handleTest() {
    if (!canTest) {
      setResult({ ok: false, text: "اول آدرس پروژه و کلید service_role را وارد کنید." });
      return;
    }
    setTesting(true);
    setResult(null);
    setManual(null);
    try {
      const res = await fetch("/api/settings/supabase/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, anonKey, serviceKey }),
      });
      const body = await res.json().catch(() => ({}));
      const d = body?.data ?? body;
      const okVal = !!d?.connected;
      setResult({
        ok: okVal,
        text: (d?.message ?? "تست انجام نشد.") + (okVal && d?.latencyMs != null ? ` (${faDigits(d.latencyMs)} میلی‌ثانیه)` : ""),
      });
    } catch {
      setResult({ ok: false, text: "تست انجام نشد؛ دوباره تلاش کنید." });
    } finally {
      setTesting(false);
    }
  }

  /** ذخیره: ورسل مستقیم یا راهنمای دستی */
  async function handleSave() {
    if (!canTest) {
      setResult({ ok: false, text: "اول آدرس پروژه و کلید service_role را وارد کنید." });
      return;
    }
    setSaving(true);
    setResult(null);
    setManual(null);
    try {
      const res = await fetch("/api/settings/supabase/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, anonKey, serviceKey }),
      });
      const body = await res.json().catch(() => ({}));
      const d = body?.data ?? body;
      if (d?.saved) {
        setResult({ ok: true, text: d?.message ?? "ذخیره شد." });
        void check();
      } else if (d?.needsManual) {
        setManual({
          steps: Array.isArray(d?.steps) ? d.steps : [],
          message: d?.message ?? "مقادیر را دستی وارد کنید.",
        });
      } else {
        setResult({ ok: false, text: d?.message ?? "ذخیره نشد؛ دوباره تلاش کنید." });
      }
    } catch {
      setResult({ ok: false, text: "ذخیره نشد؛ دوباره تلاش کنید." });
    } finally {
      setSaving(false);
    }
  }

  async function copyValue(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  }

  const canTest = url.trim().length > 0 && serviceKey.trim().length > 0;

  const copyRows = [
    { label: "آدرس پروژه", value: url.trim() },
    { label: "کلید anon", value: anonKey.trim() },
    { label: "کلید service_role", value: serviceKey.trim() },
  ].filter((r) => r.value.length > 0);

  return (
    <ConnectionRow
      icon={Database}
      title="پایگاه داده"
      hint="سوپابیس؛ ذخیره چرخه‌ها، صف و گزارش‌ها"
      state={state}
      statusText={statusText}
    >
      <div className="space-y-4">
        <div className="space-y-3">
          <Field label="آدرس پروژه" htmlFor="sb-url">
            <Input
              id="sb-url"
              dir="ltr"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://xyzcompany.supabase.co"
              autoComplete="off"
            />
          </Field>
          <Field label="کلید anon" htmlFor="sb-anon">
            <Input
              id="sb-anon"
              dir="ltr"
              type="password"
              value={anonKey}
              onChange={(e) => setAnonKey(e.target.value)}
              placeholder="کلید عمومی anon"
              autoComplete="off"
            />
          </Field>
          <Field label="کلید service_role" htmlFor="sb-service">
            <Input
              id="sb-service"
              dir="ltr"
              type="password"
              value={serviceKey}
              onChange={(e) => setServiceKey(e.target.value)}
              placeholder="کلید محرمانه service_role"
              autoComplete="off"
            />
          </Field>
        </div>

        {result && <ResultNote ok={result.ok} text={result.text} />}

        {manual && (
          <div className="space-y-3 rounded-lg border border-border bg-background p-3">
            <p className="text-sm leading-7 text-foreground">{manual.message}</p>
            <div className="space-y-2">
              {copyRows.map((r) => (
                <div key={r.label} className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">{r.label}</span>
                  <Button variant="outline" size="sm" onClick={() => void copyValue(r.label, r.value)}>
                    <Copy strokeWidth={1.75} aria-hidden="true" />
                    {copied === r.label ? "کپی شد" : "کپی"}
                    {copied === r.label && <Check aria-hidden="true" className="text-success" />}
                  </Button>
                </div>
              ))}
            </div>
            {manual.steps.length > 0 && (
              <ol className="list-decimal space-y-1.5 pe-4 ps-5 text-xs leading-6 text-muted-foreground marker:text-brand">
                {manual.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={handleTest} disabled={testing}>
            <RefreshCw strokeWidth={1.75} aria-hidden="true" />
            {testing ? "در حال تست…" : "تست اتصال"}
          </Button>
          <Button variant="default" onClick={handleSave} disabled={saving}>
            <Save strokeWidth={1.75} aria-hidden="true" />
            {saving ? "در حال ذخیره…" : "ذخیره و اتصال"}
          </Button>
        </div>

        <WhereGuide
          steps={[
            "در داشبورد سوپابیس، پروژه را باز کنید و از بخش Settings و سپس API، مقدارهای Project URL و کلیدهای anon و service_role را بردارید.",
            "مقادیر را در فرم بالا وارد کنید و «تست اتصال» را بزنید.",
            "با «ذخیره و اتصال»، مقادیر در متغیرهای محیطی ورسل (SUPABASE_URL و بقیه) ثبت می‌شود؛ بعد یک دیپلوی تازه بگیرید.",
          ]}
        />
      </div>
    </ConnectionRow>
  );
}
