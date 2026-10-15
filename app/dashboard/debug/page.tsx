"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Bug,
  CheckCircle2,
  Code2,
  Copy,
  FileDiff,
  History,
  Network,
  Palette,
  Send,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Accordion } from "@/components/ui/accordion";

type RegistryBadgeVariant =
  | "default"
  | "secondary"
  | "outline"
  | "success"
  | "warning"
  | "brand"
  | "destructive";
import { Card } from "@/components/ui/Card";
import { Input, Field } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog } from "@/components/ui/dialog";
import { faDigits } from "@/lib/format";


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

const CONFIDENCE_LABEL: Record<string, { label: string; variant: RegistryBadgeVariant }> = {
  high: { label: "اطمینان بالا", variant: "success" },
  medium: { label: "اطمینان متوسط", variant: "warning" },
  low: { label: "اطمینان پایین", variant: "destructive" },
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
    <Card className="p-4">
      <h3 className="flex items-center gap-2 text-sm font-bold leading-6 text-foreground">
        <Icon className="h-4 w-4 text-brand" aria-hidden="true" />
        {title}
      </h3>
      <div className="mt-2 text-sm leading-7 text-foreground/90">{children}</div>
    </Card>
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
    <Button variant="outline" size="sm" onClick={copy}>
      {done ? <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
      {done ? "کپی شد" : label}
    </Button>
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
        setError(body.error?.message ?? "اعمال انجام نشد؛ دوباره تلاش کنید.");
        return;
      }
      setOpen(false);
      onApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطای شبکه؛ دوباره تلاش کنید.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="default" onClick={() => setOpen(true)}>
        <Wrench className="h-4 w-4" aria-hidden="true" />
        اعمال در گیت‌هاب
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="فیکس در گیت‌هاب اعمال شود؟"
        description={`${faDigits(patchFiles.length)} فایل روی یک شاخهٔ تازه از master کامیت می‌شود. پوش مستقیم روی master انجام نمی‌شود.`}
        footer={
          <>
            <Button
              variant="default"
              disabled={busy}
              aria-busy={busy || undefined}
              onClick={apply}
              className="flex-1"
            >
              {busy ? "در حال اعمال…" : "اعمال فیکس"}
            </Button>
            <Button variant="outline" onClick={() => setOpen(false)}>
              انصراف
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="نام شاخه (اختیاری)">
            <Input
              id="apply-branch"
              dir="ltr"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="fix/debug-xxxxxxxx-20261015"
            />
          </Field>
          <Field label="پیام کامیت">
            <Input
              id="apply-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="fix: توضیح کوتاه فیکس"
            />
          </Field>
          {error && (
            <p className="flex items-start gap-1.5 text-sm leading-6 text-destructive">
              <TriangleAlert className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </p>
          )}
        </div>
      </Dialog>
    </>
  );
}

export default function DebugPage() {
  const [bug, setBug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ session: Session; diagnosis: Diagnosis; context: ContextSummary } | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
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
        setError(body.error?.message ?? "تحلیل انجام نشد؛ دوباره تلاش کنید.");
        return;
      }
      const d = body.data as { session: Session; diagnosis: Diagnosis; context: ContextSummary };
      setResult(d);
      setBug("");
      loadSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطای شبکه؛ دوباره تلاش کنید.");
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
        subtitle="باگ را توصیف کنید؛ با زمینهٔ واقعی (خطاهای team_runs و کامیت‌های گیت‌هاب) تحلیل می‌شود. هیچ دادهٔ نمایشی در کار نیست."
      />

      {/* فرم چت */}
      <Card className="p-4 sm:p-6">
        <label htmlFor="bug-desc" className="mb-2 block text-sm font-bold leading-6">
          باگ را توصیف کنید
        </label>
        <Textarea
          id="bug-desc"
          rows={4}
          value={bug}
          onChange={(e) => setBug(e.target.value)}
          placeholder="مثلاً: در صفحهٔ چرخه‌ها روی موبایل جدول از کادر بیرون می‌زند و اسکرول افقی می‌سازد..."
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
          <Button
            variant="default"
            onClick={submit}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {busy ? (
              "در حال تحلیل با زمینهٔ واقعی..."
            ) : (
              <>
                <Send className="h-4 w-4" aria-hidden="true" />
                تحلیل باگ
              </>
            )}
          </Button>
        </div>
      </Card>

      {/* نتیجهٔ تحلیل */}
      {result && diag && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-bold leading-7">نتیجهٔ تحلیل</h2>
            {conf && (
              <Badge variant={conf.variant}>
                {conf.label}
              </Badge>
            )}
          </div>

          {result.context && (
            <div className="rounded-xl border border-border bg-muted/40 p-3 text-xs leading-6 text-muted-foreground">
              <p>
                زمینهٔ تحلیل: {result.context.errorsNote}{" "}
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

          <RoleCard icon={Network} title="معمار سیستم | ریشهٔ محتمل">
            <p className="whitespace-pre-wrap">{diag.root_cause || "اطلاعات کافی نیست."}</p>
          </RoleCard>

          <RoleCard icon={Palette} title="طراح | اثر روی رابط کاربری">
            <p className="whitespace-pre-wrap">{diag.ui_impact || "اطلاعات کافی نیست."}</p>
          </RoleCard>

          <RoleCard icon={Code2} title="برنامه‌نویس | پیشنهاد رفع">
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
                  <CopyButton text={diag.fix_code} label="کپی کد" />
                </div>
              </div>
            )}
          </RoleCard>

          <RoleCard icon={Bug} title="اشکال‌زدا | قدم‌های راستی‌آزمایی">
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
          <Card className="p-4 sm:p-6">
            <h3 className="flex items-center gap-2 text-sm font-bold leading-6">
              <FileDiff className="h-4 w-4 text-brand" aria-hidden="true" />
              اعمال فیکس
            </h3>
            {diag.patch_files.length > 0 && github?.connected ? (
              <div className="mt-2 space-y-2">
                <p className="text-sm leading-7 text-muted-foreground">
                  {faDigits(diag.patch_files.length)} فایل آمادهٔ اعمال است:{" "}
                  <span dir="ltr" className="text-foreground">
                    {diag.patch_files.map((f) => f.path).join("، ")}
                  </span>
                </p>
                <div className="flex flex-wrap gap-2">
                  <ApplyButton
                    sessionId={result.session.id}
                    patchFiles={diag.patch_files}
                    onApplied={() => {
                      setAppliedMsg("فیکس روی شاخهٔ تازه کامیت شد.");
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
          </Card>
        </div>
      )}

      {/* تحلیل‌های قبلی */}
      <section>
        <h2 className="mb-2 flex items-center gap-2 text-base font-bold leading-7">
          <History className="h-5 w-5 text-brand" aria-hidden="true" />
          تحلیل‌های قبلی
        </h2>
        {sessions.length === 0 ? (
          <EmptyState
            icon={Bug}
            title="تحلیلی ثبت نشده"
            description="هنوز باگی برای تحلیل ثبت نشده است؛ اولین شرح را بالا بنویسید."
          />
        ) : (
          <Accordion
            items={sessions.map((s) => {
              const d = s.diagnosis as (Partial<Diagnosis> & Record<string, unknown>) | undefined;
              return {
                id: String(s.id),
                title: (
                  <span className="flex w-full items-center justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium leading-6">{s.bug_desc}</span>
                      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{faDate(s.created_at)}</span>
                    </span>
                    <Badge variant="secondary" className="shrink-0">
                      {STATUS_LABEL[s.status] ?? s.status}
                    </Badge>
                  </span>
                ),
                content: d ? (
                  <div className="space-y-2 text-sm leading-7">
                    {d.root_cause && (
                      <p>
                        <strong>علت:</strong> {String(d.root_cause).slice(0, 300)}
                        {String(d.root_cause).length > 300 ? "..." : ""}
                      </p>
                    )}
                    {d.fix_summary && (
                      <p>
                        <strong>راه‌حل:</strong> {String(d.fix_summary).slice(0, 300)}
                        {String(d.fix_summary).length > 300 ? "..." : ""}
                      </p>
                    )}
                    {Array.isArray(d.needs_info) && d.needs_info.length > 0 && (
                      <p className="text-warning">
                        <strong>اطلاعات لازم:</strong> {(d.needs_info as string[]).join("؛ ")}
                      </p>
                    )}
                  </div>
                ) : null,
              };
            })}
          />
        )}
      </section>
    </div>
  );
}
