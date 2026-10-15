"use client";

import { useRef, useState } from "react";
import { DatabaseBackup, Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { AlertDialog } from "@/components/ui/alert-dialog";

/**
 * بخش کوچک «پشتیبان‌گیری تنظیمات»: خروجی (دانلود JSON) و ورودی (آپلود و بازگردانی).
 * کلیدهای حساس به‌صورت پیش‌فرض صادر نمی‌شوند.
 */
export function SettingsBackup() {
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [confirmFile, setConfirmFile] = useState<{ name: string; text: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleExport() {
    setExporting(true);
    setMsg(null);
    try {
      const res = await fetch(
        `/api/settings/backup?includeSecrets=${includeSecrets ? "true" : "false"}`,
        { cache: "no-store" },
      );
      const body = await res.json();
      if (!res.ok || body?.ok === false) throw new Error(body?.error?.message ?? "خروجی ناموفق بود.");
      const blob = new Blob([JSON.stringify(body?.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const date = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `thailandgard-settings-${date}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMsg({ ok: true, text: "فایل بک‌آپ دانلود شد." });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setExporting(false);
    }
  }

  function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      try {
        const parsed = JSON.parse(text);
        if (!parsed?.settings || typeof parsed.settings !== "object") {
          throw new Error("فایل بک‌آپ معتبر نیست.");
        }
        setConfirmFile({ name: f.name, text });
        setMsg(null);
      } catch (err) {
        setMsg({ ok: false, text: err instanceof Error ? err.message : "فایل بک‌آپ معتبر نیست." });
      }
    };
    reader.readAsText(f);
    e.target.value = "";
  }

  async function handleConfirmImport() {
    if (!confirmFile) return;
    setMsg(null);
    try {
      const parsed = JSON.parse(confirmFile.text);
      const res = await fetch("/api/settings/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: parsed.settings }),
      });
      const body = await res.json();
      if (!res.ok || body?.ok === false) throw new Error(body?.error?.message ?? "بازگردانی ناموفق بود.");
      setMsg({ ok: true, text: `بازگردانی انجام شد (${body?.data?.restored ?? 0} تنظیم).` });
      setConfirmFile(null);
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "بازگردانی ناموفق بود." });
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-surface sm:p-6">
      <h2 className="mb-1 flex items-center gap-2 text-base font-bold text-card-foreground">
        <DatabaseBackup size={18} strokeWidth={1.75} aria-hidden="true" className="text-brand" />
        پشتیبان‌گیری تنظیمات
      </h2>
      <p className="mb-4 text-xs leading-6 text-muted-foreground">
        از تنظیمات خروجی بگیرید و هر وقت لازم شد بازگردانید.
      </p>

      <label className="mb-3 flex cursor-pointer items-center gap-2 text-sm text-foreground">
        <Switch checked={includeSecrets} onCheckedChange={setIncludeSecrets} />
        شامل کلیدها و توکن‌ها هم باشد
      </label>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button variant="outline" onClick={handleExport} disabled={exporting}>
          <Download strokeWidth={1.75} aria-hidden="true" />
          {exporting ? "در حال تهیه…" : "خروجی (دانلود)"}
        </Button>
        <Button variant="outline" onClick={() => fileRef.current?.click()}>
          <Upload strokeWidth={1.75} aria-hidden="true" />
          ورودی (انتخاب فایل)
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={handleFilePick}
          aria-label="انتخاب فایل بک‌آپ"
        />
      </div>

      <AlertDialog
        open={confirmFile !== null}
        onOpenChange={(o) => { if (!o) setConfirmFile(null); }}
        title={`فایل «${confirmFile?.name ?? ""}» بازگردانده شود؟`}
        description="تنظیمات فعلی بازنویسی می‌شوند."
        confirmText="بله، بازگردانی شود"
        onConfirm={handleConfirmImport}
      />

      {msg && (
        <p role="status" className={`mt-3 text-sm ${msg.ok ? "text-success" : "text-destructive"}`}>
          {msg.text}
        </p>
      )}
    </section>
  );
}
