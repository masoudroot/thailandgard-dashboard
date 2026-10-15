"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { ConnectionRow } from "./ConnectionRow";
import { Button } from "@/components/ui/Button";
import { Input, Field } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { formatJalali } from "@/lib/jalali";

interface ManagerKeyView {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  revoked: boolean;
}

function faDate(iso: string | null): string {
  if (!iso) return "هرگز";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "نامشخص";
  return formatJalali(d);
}

/**
 * پنل «API مدیر داشبورد»: ساخت و مدیریت کلیدهایی که به میرزا
 * (مدیر خودکار داشبورد) دسترسی کامل به /api/manager/* می‌دهند.
 * توکن خام فقط یک بار موقع ساخت نمایش داده می‌شود.
 */
export function ManagerApiPanel() {
  const [keys, setKeys] = useState<ManagerKeyView[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [revokeId, setRevokeId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/manager/keys");
      const body = await res.json();
      if (res.ok && body?.ok !== false) setKeys(body.data ?? []);
    } catch {
      /* نادیده */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError("");
    setNewToken(null);
    try {
      const res = await fetch("/api/manager/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const body = await res.json();
      if (!res.ok || body?.ok === false) throw new Error(body?.error?.message ?? "ساخت کلید ناموفق بود.");
      setNewToken(String(body.data.token));
      setName("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "ساخت کلید ناموفق بود.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke() {
    if (!revokeId) return;
    try {
      const res = await fetch(`/api/manager/keys/${revokeId}`, { method: "DELETE" });
      const body = await res.json();
      if (!res.ok || body?.ok === false) throw new Error(body?.error?.message ?? "لغو کلید ناموفق بود.");
      setRevokeId(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "لغو کلید ناموفق بود.");
    }
  }

  async function handleCopy() {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* نادیده */
    }
  }

  const activeCount = keys.filter((k) => !k.revoked).length;

  return (
    <ConnectionRow
      icon={KeyRound}
      title="API مدیر داشبورد"
      hint="کلید دسترسی میرزا به همه بخش‌های داشبورد"
      state={loading ? "loading" : "ok"}
      statusText={loading ? "" : activeCount > 0 ? "فعال" : "بدون کلید"}
    >
      <div className="space-y-4">
        <p className="text-xs leading-6 text-muted-foreground">
          این کلیدها به «مدیر داشبورد» (میرزا) دسترسی کامل می‌دهند: خواندن وضعیت همه
          بخش‌ها، تنظیمات، خطاها و گزارش‌ها، و اعمال اصلاحات. کلید را بسازید و به
          میرزا بدهید؛ توکن فقط یک بار نمایش داده می‌شود.
        </p>

        {/* ساخت کلید تازه */}
        <div className="rounded-lg border border-border bg-background px-3 py-4">
          <h3 className="mb-1 text-sm font-bold text-foreground">ساخت کلید تازه</h3>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="نام کلید" className="flex-1">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="مثلاً: میرزا - مدیر خودکار"
                disabled={creating}
                maxLength={80}
              />
            </Field>
            <Button
              type="button"
              variant="default"
              onClick={handleCreate}
              disabled={!name.trim() || creating}
            >
              <Plus size={16} strokeWidth={2} aria-hidden="true" />
              {creating ? "در حال ساخت…" : "ساخت کلید"}
            </Button>
          </div>
          {error && (
            <p role="alert" className="mt-3 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
              {error}
            </p>
          )}
          {newToken && (
            <div className="mt-4 overflow-hidden rounded-xl border border-warning/40">
              <div className="flex items-center gap-2 bg-warning/10 px-4 py-2.5">
                <KeyRound size={16} strokeWidth={2} aria-hidden="true" className="shrink-0 text-warning" />
                <p className="text-xs font-bold text-foreground">
                  کلید تازه ساخته شد؛ این توکن را به میرزا بدهید. دوباره دیده نمی‌شود.
                </p>
              </div>
              <div className="flex items-stretch gap-2 bg-zinc-950 p-3" dir="ltr">
                <code className="flex-1 select-all break-all rounded-lg bg-zinc-900 px-3 py-2.5 font-mono text-xs leading-6 text-zinc-100">
                  {newToken}
                </code>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleCopy}
                  className="shrink-0 self-center"
                >
                  {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                  {copied ? "کپی شد" : "کپی"}
                </Button>
              </div>
              <div className="flex items-center justify-between gap-2 bg-warning/10 px-4 py-2.5">
                <p className="text-[11px] leading-5 text-muted-foreground">
                  بعد از بستن این باکس، توکن برای همیشه از دسترس خارج می‌شود.
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setNewToken(null)}
                >
                  بستن
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* فهرست کلیدها */}
        <div>
          <h3 className="mb-2 text-sm font-bold text-foreground">کلیدهای ساخته‌شده</h3>
          {loading ? (
            <p className="text-xs text-muted-foreground">در حال بارگذاری…</p>
          ) : keys.length === 0 ? (
            <p className="text-xs text-muted-foreground">هنوز کلیدی ساخته نشده است.</p>
          ) : (
            <ul className="space-y-3">
              {keys.map((k) => (
                <li
                  key={k.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-bold text-foreground">
                      {k.name}
                      <Badge variant={k.revoked ? "destructive" : "success"} className="shrink-0">
                        {k.revoked ? "لغوشده" : "فعال"}
                      </Badge>
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      ساخت: {faDate(k.created_at)} · آخرین استفاده: {faDate(k.last_used_at)}
                    </p>
                  </div>
                  {!k.revoked && (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => setRevokeId(k.id)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      لغو
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <AlertDialog
        open={revokeId !== null}
        onOpenChange={(o) => { if (!o) setRevokeId(null); }}
        title="لغو کلید API"
        description="این کلید دیگر کار نمی‌کند و دسترسی مدیر داشبورد با آن قطع می‌شود. مطمئن هستید؟"
        confirmText="لغو کلید"
        cancelText="انصراف"
        destructive
        onConfirm={handleRevoke}
      />
    </ConnectionRow>
  );
}
