"use client";

import { useEffect, useState } from "react";
import { Database, RefreshCw } from "lucide-react";
import {
  ConnectionRow,
  WhereGuide,
  GhostButton,
  ResultNote,
  type ConnState,
} from "./ConnectionRow";

/** تبدیل ارقام لاتین به فارسی */
function faDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
}

/**
 * پنل «پایگاه داده» (سوپابیس).
 * اتصال از متغیرهای محیطی خوانده می‌شود؛ این پنل فقط وضعیت را تست می‌کند.
 * راهنمای تنظیم متغیرها در <details> است.
 */
export function SupabasePanel() {
  const [state, setState] = useState<ConnState>("loading");
  const [statusText, setStatusText] = useState("در حال بررسی…");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function check() {
    try {
      const res = await fetch("/api/settings/supabase/test", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      const configured = body?.data?.configured ?? body?.configured;
      // GET خلاصه می‌دهد، POST تست واقعی
      if (typeof configured === "boolean") {
        setState(configured ? "unknown" : "fail");
        setStatusText(configured ? "پیکربندی شده" : "متصل نیست");
        return;
      }
      applyTest(body?.data ?? body);
    } catch {
      setState("fail");
      setStatusText("متصل نیست");
    }
  }

  function applyTest(d: { connected?: boolean; latencyMs?: number | null; message?: string }) {
    const ok = !!d?.connected;
    setState(ok ? "ok" : "fail");
    setStatusText(ok ? "متصل" : "متصل نیست");
    if (d?.message) {
      setResult({
        ok,
        text: d.message + (ok && d.latencyMs != null ? ` (${faDigits(d.latencyMs)} میلی‌ثانیه)` : ""),
      });
    }
  }

  useEffect(() => {
    void check();
  }, []);

  async function handleTest() {
    setTesting(true);
    setResult(null);
    try {
      const res = await fetch("/api/settings/supabase/test", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      applyTest(body?.data ?? body);
    } catch {
      setState("fail");
      setStatusText("متصل نیست");
      setResult({ ok: false, text: "تست انجام نشد؛ دوباره تلاش کنید." });
    } finally {
      setTesting(false);
    }
  }

  return (
    <ConnectionRow
      icon={Database}
      title="پایگاه داده"
      hint="سوپابیس؛ ذخیره چرخه‌ها، صف و گزارش‌ها"
      state={state}
      statusText={statusText}
    >
      <div className="space-y-4">
        <p className="text-sm leading-7 text-muted-foreground">
          اتصال پایگاه داده از متغیرهای محیطی سرور خوانده می‌شود
          (<span dir="ltr" className="font-mono">SUPABASE_URL</span> و{' '}
          <span dir="ltr" className="font-mono">SUPABASE_SERVICE_ROLE_KEY</span>).
          با دکمه زیر سلامت اتصال فعلی را تست کنید.
        </p>

        {result && <ResultNote ok={result.ok} text={result.text} />}

        <div>
          <GhostButton onClick={handleTest} disabled={testing}>
            <RefreshCw size={15} strokeWidth={1.75} aria-hidden="true" />
            {testing ? "در حال تست…" : "تست اتصال"}
          </GhostButton>
        </div>

        <WhereGuide
          steps={[
            "در داشبورد سوپابیس، پروژه را باز کنید و از بخش Settings و سپس API، مقدارهای Project URL و service_role key را بردارید.",
            "در داشبورد ورسل، پروژه thailandgard-dashboard و بخش Settings و سپس Environment Variables را باز کنید.",
            "دو متغیر SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY را اضافه کنید و دیپلوی تازه بگیرید.",
          ]}
        />
      </div>
    </ConnectionRow>
  );
}
