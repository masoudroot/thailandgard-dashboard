"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Bug,
  CheckCircle2,
  Code2,
  Copy,
  FileDiff,
  History,
  Loader2,
  Network,
  Palette,
  Send,
  TriangleAlert,
  Unplug,
  Wrench,
  X,
} from "lucide-react";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";

/** تبدیل ارقام لاتین به فارسی */
function faDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
}

/** تاریخ شمسی با ارقام فارسی */
function faDate(iso: string | null): string {
  if (!iso) return "نامشخص";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "نامشخص";
  return new Intl.DateTimeFormat("fa-IR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

const inputClass =
  "w-full min-h-[44px] rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground shadow-control placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30";

type PatchFile = { path: string; content: string };

type Diagnosis = {
  root_cause: string;
  ui_impact: string;
  fix_summary: string;
  fix_code: string;
  verification_steps: string[];
  confidence: "high" | "medium" | "low";
  needs_info: string[];
  related_files: string[];
  patch_files: PatchFile[];
};

type Session = {
  id: string;
  bug_desc: string;
  status: string;
  created_at: string;
  diagnosis?: { context_summary?: ContextSummary } & Partial<Diagnosis> & Record<string, unknown>;
};

type ContextSummary = {
  errorsNote: string;
  errorsCount: number;
  commitsCount: number;
  githubConnected: boolean;
  githubMessage: string;
};

type GithubInfo = {
  connected: boolean;
  repo: string;
  user?: string;
  message: string;
};

const CONFIDENCE_LABEL: Record<string, { label: string; className: string }> = {
  high: { label: "اطمینان بالا", className: "bg-success/10 text-success" },
  medium: { label: "اطمینان متوسط", className: "bg-warning/10 text-warning" },
  low: { label: "اطمینان پایین", className: "bg-destructive/10 text-destructive" },
};

const STATUS_LABEL: Record<string, string> = {
  open: "باز",
  analyzed: "تحلیل شد",
  applied: "اعمال شد",
  needs_info: "نیازمند اطلاعات",
};

async function readBody(res: Response): Promise<{ ok: boolean; data?: unknown; error?: { message?: string } }> {
  try {
    return await res.json();
  } catch {
    return { ok: false, error: { message: `پاسخ نامعتبر از سرور (وضعیت ${res.status})` } };
  }
}

function RoleCard({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Network;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h3 className="flex items-center gap-2 text-sm font-bold leading-6 text-foreground">
        <Icon className="h-4 w-4 text-brand" aria-hidden="true" />
        {title}
      </h3>
      <div className="mt-2 text-sm leading-7 text-foreground/90">{children}</div>
    </section>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setDone(true);
    setTimeout(() => setDone(false), 2000);
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-input bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {done ? <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
      {done ? "کپی شد" : label}
    </button>
  );
}

function ApplyButton({
  sessionId,
  patchFiles,
  onApplied,
}: {
  sessionId: string;
  patchFiles: PatchFile[];
  onApplied: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    if (!message.trim()) {
      setError("پیام کامیت را بنویسید.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/debug/${sessionId}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message.trim(), branch: branch.trim() || undefined, files: patchFiles }),
      });
      const body = await readBody(res);
      if (!body.ok) {
        setError(body.error?.message ?? "اعمال ناموفق بود.");
        return;
      }
      setOpen(false);
      onApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطای شبکه.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Wrench className="h-4 w-4" aria-hidden="true" />
        اعمال در گیت‌هاب
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label="تأیید اعمال فیکس"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-t-xl bg-card p-5 shadow-xl sm:rounded-xl sm:p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold leading-7">تأیید اعمال فیکس</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="بستن"
                className="rounded-lg p-2 text-muted-foreground hover:bg-accent"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <p className="mt-2 text-sm leading-7 text-muted-foreground">
              {faDigits(patchFiles.length)} فایل روی یک شاخه‌ی تازه از master کامیت می‌شود. پوش مستقیم روی master
              انجام نمی‌شود.
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label htmlFor="apply-branch" className="mb-1 block text-xs font-medium text-muted-foreground">
                  نام شاخه (اختیاری)
                </label>
                <input
                  id="apply-branch"
                  dir="ltr"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="fix/debug-xxxxxxxx-20261015"
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="apply-message" className="mb-1 block text-xs font-medium text-muted-foreground">
                  پیام کامیت
                </label>
                <input
                  id="apply-message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="fix: توضیح کوتاه فیکس"
                  className={inputClass}
                />
              </div>
            </div>
            {error && (
              <p className="mt-3 flex items-start gap-1.5 text-sm leading-6 text-destructive">
                <TriangleAlert className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
                {error}
              </p>
            )}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={apply}
                disabled={busy}
                className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {busy ? "در حال اعمال..." : "تأیید و اعمال"}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="min-h-[44px] rounded-lg border border-input px-4 text-sm font-medium hover:bg-accent"
              >
                انصراف
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function DebugPage() {
  const [bug, setBug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ session: Session; diagnosis: Diagnosis; context: ContextSummary } | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [github, setGithub] = useState<GithubInfo | null>(null);
  const [appliedMsg, setAppliedMsg] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/debug", { cache: "no-store" });
      const body = await readBody(res);
      if (body.ok && Array.isArray(body.data)) setSessions(body.data as Session[]);
    } catch {
      // لیست نشست‌ها اختیاری است؛ خطایش را ساکت می‌گذاریم
    }
  }, []);

  useEffect(() => {
    loadSessions();
    (async () => {
      try {
        const res = await fetch("/api/settings/github", { cache: "no-store" });
        const body = await readBody(res);
        if (body.ok && body.data) setGithub(body.data as GithubInfo);
      } catch {
        setGithub({ connected: false, repo: "", message: "وضعیت اتصال گیت‌هاب مشخص نشد." });
      }
    })();
  }, [loadSessions]);

  async function submit() {
    const text = bug.trim();
    if (text.length < 10) {
      setError("شرح باگ خیلی کوتاه است؛ با جزئیات بیشتری بنویسید.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    setAppliedMsg(null);
    try {
      const res = await fetch("/api/debug", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bug_description: text }),
      });
      const body = await readBody(res);
      if (!body.ok) {
        setError(body.error?.message ?? "تحلیل ناموفق بود.");
        return;
      }
      const d = body.data as { session: Session; diagnosis: Diagnosis; context: ContextSummary };
      setResult(d);
      setBug("");
      loadSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطای شبکه.");
    } finally {
      setBusy(false);
    }
  }

  function patchAsText(patchFiles: PatchFile[]): string {
    return patchFiles
      .map((f) => `===== ${f.path} =====\n${f.content}`)
      .join("\n\n");
  }

  const diag = result?.diagnosis;
  const conf = diag ? CONFIDENCE_LABEL[diag.confidence] : null;

  return (
    <div className="space-y-6 md:space-y-8">
      <PageHeader
        icon={Wrench}
        title="دستیار فنی"
        subtitle="باگ را توصیف کنید؛ با زمینه‌ی واقعی (خطاهای team_runs و کامیت‌های گیت‌هاب) تحلیل می‌شود. هیچ داده‌ی نمایشی در کار نیست."
      />

      {/* وضعیت اتصال‌ها */}
      <div
        className={`flex items-start gap-2.5 rounded-xl border p-3 text-sm leading-6 ${
          github?.connected
            ? "border-success/30 bg-success/5 text-foreground"
            : "border-warning/30 bg-warning/5 text-foreground"
        }`}
      >
        {github?.connected ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
        ) : (
          <Unplug className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
        )}
        <div>
          <p className="font-semibold">
            {github ? github.message : "در حال بررسی اتصال گیت‌هاب..."}
          </p>
          {!github?.connected && github && (
            <p className="mt-1 text-muted-foreground">
              برای اتصال، در صفحه‌ی{" "}
              <a href="/dashboard/settings" className="font-medium text-brand underline underline-offset-4">
                تنظیمات
              </a>{" "}
              توکن شخصی گیت‌هاب را وارد کنید.
            </p>
          )}
        </div>
      </div>

      {/* فرم چت */}
      <section className="rounded-xl border border-border bg-card p-4 sm:p-6">
        <label htmlFor="bug-desc" className="mb-2 block text-sm font-bold leading-6">
          باگ را توصیف کنید
        </label>
        <textarea
          id="bug-desc"
          rows={4}
          value={bug}
          onChange={(e) => setBug(e.target.value)}
          placeholder="مثلاً: در صفحه‌ی چرخه‌ها روی موبایل جدول از کادر بیرون می‌زند و اسکرول افقی می‌سازد..."
          className={`${inputClass} resize-y`}
        />
        {error && (
          <p className="mt-2 flex items-start gap-1.5 text-sm leading-6 text-destructive">
            <TriangleAlert className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
            {error}
          </p>
        )}
        {appliedMsg && (
          <p className="mt-2 flex items-start gap-1.5 text-sm leading-6 text-success">
            <CheckCircle2 className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
            {appliedMsg}
          </p>
        )}
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
            {busy ? "در حال تحلیل با زمینه‌ی واقعی..." : "تحلیل باگ"}
          </button>
        </div>
      </section>

      {/* نتیجه‌ی تحلیل */}
      {result && diag && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-bold leading-7">نتیجه‌ی تحلیل</h2>
            {conf && (
              <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${conf.className}`}>
                {conf.label}
              </span>
            )}
          </div>

          {result.context && (
            <div className="rounded-xl border border-border bg-muted/40 p-3 text-xs leading-6 text-muted-foreground">
              <p>
                زمینه‌ی استفاده‌شده: {result.context.errorsNote}{" "}
                {result.context.commitsCount >= 0
                  ? `کامیت‌های اخیر خوانده شد (${faDigits(result.context.commitsCount)}).`
                  : "کامیت‌های گیت‌هاب خوانده نشد (متصل نیست)."}
              </p>
            </div>
          )}

          {diag.needs_info.length > 0 && (
            <div className="rounded-xl border border-warning/30 bg-warning/5 p-4">
              <h3 className="flex items-center gap-2 text-sm font-bold leading-6">
                <TriangleAlert className="h-4 w-4 text-warning" aria-hidden="true" />
                برای تشخیص دقیق‌تر این اطلاعات لازم است
              </h3>
              <ul className="mt-2 list-disc space-y-1 pe-5 text-sm leading-7 text-foreground/90">
                {diag.needs_info.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}

          <RoleCard icon={Network} title="معمار سیستم | ریشه‌ی محتمل">
            <p className="whitespace-pre-wrap">{diag.root_cause || "اطلاعات کافی نیست."}</p>
          </RoleCard>

          <RoleCard icon={Palette} title="دیزاینر | اثر روی رابط کاربری">
            <p className="whitespace-pre-wrap">{diag.ui_impact || "اطلاعات کافی نیست."}</p>
          </RoleCard>

          <RoleCard icon={Code2} title="برنامه‌نویس | فیکس پیشنهادی">
            <p className="whitespace-pre-wrap">{diag.fix_summary || "اطلاعات کافی نیست."}</p>
            {diag.fix_code && (
              <div className="mt-3">
                <pre
                  dir="ltr"
                  className="max-h-96 overflow-auto rounded-lg border border-border bg-muted/60 p-3 text-xs leading-5"
                >
                  <code>{diag.fix_code}</code>
                </pre>
                <div className="mt-2">
                  <CopyButton text={diag.fix_code} label="کپی کد فیکس" />
                </div>
              </div>
            )}
          </RoleCard>

          <RoleCard icon={Bug} title="دیباگر | قدم‌های راستی‌آزمایی">
            {diag.verification_steps.length > 0 ? (
              <ol className="list-decimal space-y-1 pe-5">
                {diag.verification_steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            ) : (
              <p>اطلاعات کافی نیست.</p>
            )}
          </RoleCard>

          {/* اعمال فیکس */}
          <section className="rounded-xl border border-border bg-card p-4 sm:p-6">
            <h3 className="flex items-center gap-2 text-sm font-bold leading-6">
              <FileDiff className="h-4 w-4 text-brand" aria-hidden="true" />
              اعمال فیکس
            </h3>
            {diag.patch_files.length > 0 && github?.connected ? (
              <div className="mt-2 space-y-2">
                <p className="text-sm leading-7 text-muted-foreground">
                  {faDigits(diag.patch_files.length)} فایل آماده‌ی اعمال است:{" "}
                  <span dir="ltr" className="text-foreground">
                    {diag.patch_files.map((f) => f.path).join("، ")}
                  </span>
                </p>
                <div className="flex flex-wrap gap-2">
                  <ApplyButton
                    sessionId={result.session.id}
                    patchFiles={diag.patch_files}
                    onApplied={() => {
                      setAppliedMsg("فیکس روی شاخه‌ی تازه در گیت‌هاب کامیت شد.");
                      loadSessions();
                    }}
                  />
                  <CopyButton text={patchAsText(diag.patch_files)} label="کپی پچ" />
                </div>
              </div>
            ) : diag.patch_files.length > 0 ? (
              <div className="mt-2 space-y-2">
                <p className="text-sm leading-7 text-muted-foreground">
                  گیت‌هاب متصل نیست، پس اعمال خودکار ممکن نشد. پچ را کپی و دستی اعمال کنید، یا در{" "}
                  <a href="/dashboard/settings" className="font-medium text-brand underline underline-offset-4">
                    تنظیمات
                  </a>{" "}
                  توکن وارد کنید.
                </p>
                <CopyButton text={patchAsText(diag.patch_files)} label="کپی پچ" />
              </div>
            ) : (
              <p className="mt-2 text-sm leading-7 text-muted-foreground">
                پچ قابل اعمال خودکار تولید نشد (اطلاعات فایل‌ها کامل نبود). کد فیکس بالا را کپی و دستی اعمال
                کنید.
              </p>
            )}
          </section>
        </div>
      )}

      {/* تاریخچه‌ی نشست‌ها */}
      <section>
        <h2 className="mb-2 flex items-center gap-2 text-base font-bold leading-7">
          <History className="h-5 w-5 text-brand" aria-hidden="true" />
          تاریخچه‌ی نشست‌ها
        </h2>
        {sessions.length === 0 ? (
          <EmptyState
            icon={Bug}
            title="نشستی ثبت نشده"
            description="هنوز باگی برای تحلیل ثبت نشده است؛ اولین شرح را بالا بنویسید."
          />
        ) : (
          <ul className="space-y-2">
            {sessions.map((s) => {
              const open = expanded === s.id;
              const d = s.diagnosis as (Partial<Diagnosis> & Record<string, unknown>) | undefined;
              return (
                <li key={s.id} className="rounded-xl border border-border bg-card">
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : s.id)}
                    className="flex w-full items-center justify-between gap-3 p-3 text-start"
                    aria-expanded={open}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium leading-6">{s.bug_desc}</p>
                      <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{faDate(s.created_at)}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                      {STATUS_LABEL[s.status] ?? s.status}
                    </span>
                  </button>
                  {open && d && (
                    <div className="space-y-2 border-t border-border p-3 text-sm leading-7">
                      {d.root_cause && (
                        <p>
                          <strong>ریشه:</strong> {String(d.root_cause).slice(0, 300)}
                          {String(d.root_cause).length > 300 ? "..." : ""}
                        </p>
                      )}
                      {d.fix_summary && (
                        <p>
                          <strong>فیکس:</strong> {String(d.fix_summary).slice(0, 300)}
                          {String(d.fix_summary).length > 300 ? "..." : ""}
                        </p>
                      )}
                      {Array.isArray(d.needs_info) && d.needs_info.length > 0 && (
                        <p className="text-warning">
                          <strong>اطلاعات لازم:</strong> {(d.needs_info as string[]).join("؛ ")}
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
