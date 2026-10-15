"use client";

import { Plus, RefreshCw, Trash2, PlugZap } from "lucide-react";
import { SkeletonLines } from "@/components/Skeleton";
import { Button } from "@/components/ui/Button";
import { Input, Field } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { faDigits } from "@/lib/format";
import {
  ConnectionRow,
  WhereGuide,
  ResultNote,
  type ConnState,
} from "./ConnectionRow";
import { useLlmSettings } from "./useLlmSettings";

/**
 * کارت «درگاه‌های هوش مصنوعی»: مدیریت درگاه‌های سازگار با OpenAI —
 * فهرست، تست اتصال، تست سلامت مدل‌ها، افزودن و حذف.
 * انتخاب مدل‌ها در صفحه‌ی جدا «مدل‌های هوش مصنوعی» انجام می‌شود.
 */
export function LlmGatewaysPanel() {
  const s = useLlmSettings();

  const rowState: ConnState = s.loading ? "loading" : s.connected ? "ok" : "fail";
  const rowStatus = s.loading
    ? "در حال بررسی…"
    : s.connected && s.endpoints.length > 0
      ? `متصل (${faDigits(s.endpoints.length)} درگاه)`
      : s.connected
        ? "متصل (بدون درگاه)"
        : "متصل نیست";

  return (
    <ConnectionRow
      icon={PlugZap}
      title="درگاه‌های هوش مصنوعی"
      hint="افزودن، تست و حذف درگاه‌ها"
      state={rowState}
      statusText={rowStatus}
    >
      <p className="mb-4 text-xs leading-6 text-muted-foreground">
        درگاه‌های سازگار با OpenAI را اینجا مدیریت کنید: نام، آدرس base URL و
        کلید API. انتخاب مدل‌ها در صفحه‌ی «مدل‌های هوش مصنوعی» انجام می‌شود.
      </p>

      {s.loading ? (
        <div aria-busy="true"><SkeletonLines lines={3} /><span className="sr-only">در حال بارگذاری…</span></div>
      ) : !s.connected ? (
        <div className="rounded-lg border border-dashed border-border bg-card px-4 py-8 text-center">
          <p className="text-sm font-bold text-foreground">متصل نیست</p>
          <p className="mx-auto mt-1 max-w-md text-sm leading-7 text-muted-foreground">
            برای مدیریت درگاه‌ها باید پایگاه داده وصل باشد. اتصال را بررسی کنید و دوباره تلاش کنید.
          </p>
          <Button variant="outline" size="lg" onClick={() => window.location.reload()} className="mt-4">
            تلاش دوباره
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {/* ── درگاه‌ها ── */}
          <div>
            <h3 className="mb-2 text-sm font-bold text-foreground">درگاه‌ها</h3>
            {s.endpoints.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                هنوز درگاهی ثبت نشده است. اولین درگاه را با فرم پایین اضافه کنید.
              </p>
            ) : (
              <ul className="space-y-3">
                {s.endpoints.map((ep) => {
                  const r = s.testResults[ep.id];
                  return (
                    <li
                      key={ep.id}
                      className="rounded-lg border border-border bg-background px-3 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-foreground">{ep.name}</p>
                          <p dir="ltr" className="truncate text-start text-xs text-muted-foreground">
                            {ep.baseUrl}
                          </p>
                          <p dir="ltr" className="mt-0.5 text-start font-mono text-xs text-muted-foreground">
                            {ep.apiKeyMasked}
                          </p>
                        </div>
                        <Badge
                          variant={r ? (r.ok ? "success" : "destructive") : "secondary"}
                          className="shrink-0 gap-1.5"
                        >
                          <span className="h-2 w-2 rounded-full bg-current" aria-hidden="true" />
                          {r ? (r.ok ? "سالم" : "خطا") : "تست نشده"}
                        </Badge>
                      </div>
                      {r && (
                        <div className="mt-2">
                          <ResultNote
                            ok={r.ok}
                            text={r.message + (r.latencyMs != null ? ` (${faDigits(r.latencyMs)} میلی‌ثانیه)` : "")}
                          />
                        </div>
                      )}
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <Button
                          variant="outline"
                          onClick={() => s.handleTest(ep.id)}
                          disabled={!!s.testing[ep.id]}
                        >
                          <RefreshCw strokeWidth={1.75} aria-hidden="true" />
                          {s.testing[ep.id] ? "در حال تست…" : "تست اتصال"}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => s.handleRetestModels(ep.id)}
                          disabled={!!s.healthLoading[ep.id]}
                          title="کش سلامت مدل‌ها را نادیده می‌گیرد و همه‌ی مدل‌ها را دوباره تست می‌کند"
                        >
                          <RefreshCw strokeWidth={1.75} aria-hidden="true" />
                          {s.healthLoading[ep.id] ? "در حال تست مدل‌ها…" : "تست دوباره"}
                        </Button>
                        <Button
                          variant="destructive"
                          onClick={() => s.setConfirmDeleteId(ep.id)}
                        >
                          <Trash2 strokeWidth={1.75} aria-hidden="true" />
                          حذف درگاه
                        </Button>
                      </div>
                      <AlertDialog
                        open={s.confirmDeleteId === ep.id}
                        onOpenChange={(o) => { if (!o) s.setConfirmDeleteId(null); }}
                        title={`درگاه «${ep.name}» حذف شود؟`}
                        description="تیم‌هایی که از آن استفاده می‌کنند به حالت پیش‌فرض برمی‌گردند."
                        confirmText="حذف درگاه"
                        destructive
                        onConfirm={() => s.handleDelete(ep.id)}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* ── افزودن درگاه ── */}
          <div className="rounded-lg border border-border bg-card px-3 py-4">
            <h3 className="mb-3 flex items-center gap-1.5 text-sm font-bold text-foreground">
              <Plus size={15} strokeWidth={2} aria-hidden="true" />
              افزودن درگاه
            </h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="نام" htmlFor="llm-ep-name">
                <Input
                  id="llm-ep-name"
                  type="text"
                  placeholder="مثلاً reformboss"
                  value={s.addName}
                  onChange={(e) => s.setAddName(e.target.value)}
                />
              </Field>
              <Field label="آدرس base URL" htmlFor="llm-ep-base">
                <Input
                  id="llm-ep-base"
                  type="url"
                  dir="ltr"
                  placeholder="https://api.example.com/v1"
                  value={s.addBase}
                  onChange={(e) => s.setAddBase(e.target.value)}
                />
              </Field>
              <Field label="کلید API" htmlFor="llm-ep-key">
                <Input
                  id="llm-ep-key"
                  type="password"
                  dir="ltr"
                  autoComplete="off"
                  placeholder="sk-..."
                  value={s.addKey}
                  onChange={(e) => s.setAddKey(e.target.value)}
                />
              </Field>
            </div>
            <Button variant="default" size="lg" onClick={s.handleAdd} disabled={s.adding} className="mt-3">
              {s.adding ? "در حال ذخیره…" : "افزودن درگاه"}
            </Button>
          </div>

          {s.errorMsg && <ResultNote ok={false} text={s.errorMsg} />}
        </div>
      )}
      <div className="mt-4">
        <WhereGuide
          steps={[
            "یک درگاه سازگار با OpenAI لازم دارید (مثلاً OpenAI، یا درگاه‌های مشابه).",
            "نام، آدرس base URL و کلید API را در فرم «افزودن درگاه» وارد کنید.",
            "با «تست اتصال» از سالم بودن مطمئن شوید؛ بعد در صفحه‌ی «مدل‌های هوش مصنوعی» مدل‌ها را انتخاب کنید.",
          ]}
        />
      </div>
    </ConnectionRow>
  );
}
