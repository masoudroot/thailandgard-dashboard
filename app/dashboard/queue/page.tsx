"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Ban,
  CheckCircle2,
  Inbox,
  ListChecks,
  Play,
  Plus,
  RotateCw,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { TEAMS } from "@/lib/types";
import EmptyState from "@/components/EmptyState";
import PageHeader from "@/components/PageHeader";
import { SkeletonPanel } from "@/components/Skeleton";
import LoadMore, { useVisibleCount } from "@/components/LoadMore";

/* ------------------------------------------------------------------ */
/*  مدل داده                                                          */
/* ------------------------------------------------------------------ */

type TaskStatus = "pending" | "in_progress" | "done" | "failed" | "rejected";
type TaskPriority = "low" | "medium" | "high" | "critical";

interface BuildTask {
  id: string;
  title: string;
  team: string;
  description: string;
  files: string[];
  priority: TaskPriority;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

const STATUSES: { key: TaskStatus; label: string }[] = [
  { key: "pending", label: "در انتظار" },
  { key: "in_progress", label: "در حال انجام" },
  { key: "done", label: "انجام‌شده" },
  { key: "failed", label: "ناموفق" },
  { key: "rejected", label: "ردشده" },
];

const PRIORITIES: { key: TaskPriority; label: string }[] = [
  { key: "low", label: "کم" },
  { key: "medium", label: "متوسط" },
  { key: "high", label: "زیاد" },
  { key: "critical", label: "بحرانی" },
];

const TEAM_LABELS: Record<string, string> = {
  artdir: "مدیر هنری",
  branding: "برندینگ",
  content: "محتوا",
  seo: "سئو",
  analytics: "تحلیل داده",
  intel: "اطلاعات بازار",
  lead: "لید",
  design: "طراحی",
  seocontent: "محتوای سئو",
  vibefarsi: "وایب‌فارسی",
  farsiui: "رابط فارسی",
  "design-ir": "طراحی ایران",
  dev: "توسعه",
  qa: "تضمین کیفیت",
  inspector: "بازرس",
};

/* ------------------------------------------------------------------ */
/*  دادهٔ نمایشی: تا وقتی API واقعی /api/tasks آماده نشده               */
/* ------------------------------------------------------------------ */

const now = Date.now();
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();

const MOCK_TASKS: BuildTask[] = [
  {
    id: "q-101",
    title: "بازطراحی بنر هیروی صفحهٔ تورها",
    team: "design",
    description:
      "هیروی فعلی صفحهٔ /tours نرخ کلیک پایینی دارد. پیشنهاد: ترکیب تصویر واقعی بانکوک با تیتر «تور تایلند، بی‌دغدغه» و دکمهٔ رزرو مشاوره.",
    files: ["site/app/tours/page.tsx", "site/components/Hero.tsx"],
    priority: "high",
    status: "pending",
    created_at: minutesAgo(25),
    updated_at: minutesAgo(25),
  },
  {
    id: "q-102",
    title: "افزودن اسکیمای FAQ به صفحهٔ ویزای تایلند",
    team: "seo",
    description:
      "۱۰ سؤال پرتکرار کاربران دربارهٔ ویزا جمع شده؛ باید به‌صورت JSON-LD داخل صفحه تزریق شود تا شانس ریچ‌اسنیپت بالا برود.",
    files: ["site/app/visa/page.tsx"],
    priority: "medium",
    status: "pending",
    created_at: minutesAgo(90),
    updated_at: minutesAgo(90),
  },
  {
    id: "q-103",
    title: "رفع باگ دکمهٔ تماس در موبایل",
    team: "dev",
    description:
      "دکمهٔ شناور تماس در آیفون‌های قدیمی زیر نوار مرورگر می‌رود و قابل لمس نیست. اصلاح با safe-area-inset-bottom.",
    files: ["site/components/CallButton.tsx", "site/app/globals.css"],
    priority: "critical",
    status: "pending",
    created_at: minutesAgo(180),
    updated_at: minutesAgo(180),
  },
  {
    id: "q-104",
    title: "متن فارسی بخش «چرا تایلندگرد»",
    team: "content",
    description:
      "پاراگراف فعلی ترجمه‌مآب است؛ بازنویسی با لحن گرم و محاوره‌ای ملایم، بدون شعارهای کلیشه‌ای آژانسی.",
    files: ["site/content/why-us.md"],
    priority: "low",
    status: "pending",
    created_at: minutesAgo(320),
    updated_at: minutesAgo(320),
  },
  {
    id: "q-105",
    title: "یکپارچه‌سازی فونت پینار در پنل ادمین",
    team: "vibefarsi",
    description:
      "سربرگ‌ها هنوز با وزیرمتن رندر می‌شوند؛ طبق تصمیم تم، تیترها باید پینار باشند. بررسی کنتراست روی تم تیره هم لازم است.",
    files: ["site/app/admin/layout.tsx", "site/styles/fonts.ts"],
    priority: "medium",
    status: "in_progress",
    created_at: minutesAgo(60 * 5),
    updated_at: minutesAgo(40),
  },
  {
    id: "q-106",
    title: "بهینه‌سازی تصاویر گالری پوکت",
    team: "qa",
    description:
      "۱۲ تصویر بالای ۲ مگابایت‌اند و LCP صفحه را خراب کرده‌اند. فشرده‌سازی WebP و ابعاد ریسپانسیو.",
    files: ["site/public/images/phuket/"],
    priority: "high",
    status: "in_progress",
    created_at: minutesAgo(60 * 9),
    updated_at: minutesAgo(15),
  },
  {
    id: "q-107",
    title: "راه‌اندازی فرم درخواست مشاوره",
    team: "dev",
    description:
      "فرم سه‌مرحله‌ای با اعتبارسنجی شمارهٔ موبایل ایرانی و اتصال به وب‌هوک CRM. تست end-to-end سبز شد.",
    files: ["site/app/consult/page.tsx", "site/lib/crm.ts"],
    priority: "high",
    status: "done",
    created_at: minutesAgo(60 * 30),
    updated_at: minutesAgo(60 * 2),
  },
  {
    id: "q-108",
    title: "کمپین اینستاگرام «پاییز در تایلند»",
    team: "branding",
    description:
      "پالت رنگی پیشنهادی با هویت فعلی سایت هم‌خوان نبود؛ نیاز به بازنگری کامل مودبرد.",
    files: ["brand/autumn-campaign.pdf"],
    priority: "medium",
    status: "rejected",
    created_at: minutesAgo(60 * 48),
    updated_at: minutesAgo(60 * 20),
  },
  {
    id: "q-109",
    title: "اتصال درگاه پرداخت به سبد خرید",
    team: "dev",
    description:
      "در sandbox درگاه، callback برنمی‌گشت؛ باگ سمت مستندات درگاه بود و فعلاً متوقف شده تا پاسخ پشتیبانی بیاید.",
    files: ["site/lib/payment.ts"],
    priority: "critical",
    status: "failed",
    created_at: minutesAgo(60 * 72),
    updated_at: minutesAgo(60 * 26),
  },
];

/* ------------------------------------------------------------------ */
/*  ابزارهای کوچک                                                      */
/* ------------------------------------------------------------------ */

const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

function faNum(value: string | number): string {
  return String(value).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]);
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(1, Math.round(diffMs / 60_000));
  if (minutes < 60) return `${faNum(minutes)} دقیقه پیش`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${faNum(hours)} ساعت پیش`;
  const days = Math.round(hours / 24);
  return `${faNum(days)} روز پیش`;
}

function teamLabel(team: string): string {
  return TEAM_LABELS[team] ?? team;
}

const PRIORITY_STYLE: Record<TaskPriority, string> = {
  critical: "bg-destructive text-destructive-foreground",
  high: "bg-warning text-warning-foreground",
  medium: "bg-brand text-brand-foreground",
  low: "bg-secondary text-secondary-foreground",
};

/** حالت خالیِ هر تب: آیکون، تیتر و یک جمله راهنما */
const TAB_EMPTY: Record<TaskStatus, { icon: LucideIcon; title: string; description: string }> = {
  pending: {
    icon: Inbox,
    title: "صف انتظار خالی است",
    description: "کار تازه‌ای برای تأیید نمانده است. هر وقت لازم شد، کار تازه‌ای دستی ثبت کنید.",
  },
  in_progress: {
    icon: Play,
    title: "کاری در حال انجام نیست",
    description: "کارهای تأییدشده وارد صف اجرا می‌شوند و همین‌جا دیده می‌شوند.",
  },
  done: {
    icon: CheckCircle2,
    title: "هنوز کاری به سرانجام نرسیده است",
    description: "کارهای انجام‌شدهٔ تیم‌ها در این تب فهرست می‌شوند.",
  },
  failed: {
    icon: XCircle,
    title: "خطای ثبت‌شده‌ای نیست",
    description: "همه‌چیز سالم است؛ کارهای ناموفق با دلیلشان اینجا می‌آیند.",
  },
  rejected: {
    icon: Ban,
    title: "کاری رد نشده است",
    description: "کارهایی که رد می‌شوند، با دلیل ردشدنشان در این تب می‌مانند.",
  },
};

const STATUS_BADGE: Record<TaskStatus, string> = {
  pending: "bg-warning/15 text-warning",
  in_progress: "bg-brand/15 text-brand",
  done: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
  rejected: "bg-muted text-muted-foreground",
};

/* ------------------------------------------------------------------ */
/*  لایهٔ دسترسی به API با بازگشت به mock                              */
/* ------------------------------------------------------------------ */

function extractTasks(payload: unknown): BuildTask[] | null {
  if (Array.isArray(payload)) return payload as BuildTask[];
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    const data = obj.data ?? obj.tasks ?? obj.items;
    if (Array.isArray(data)) return data as BuildTask[];
  }
  return null;
}

async function fetchTasks(status: TaskStatus): Promise<BuildTask[]> {
  try {
    const res = await fetch(`/api/tasks?status=${status}`, {
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error("api");
    const payload = await res.json();
    const tasks = extractTasks(payload);
    if (!tasks) throw new Error("api");
    return tasks;
  } catch {
    return MOCK_TASKS.filter((t) => t.status === status);
  }
}

async function patchTask(id: string, action: "approve" | "reject"): Promise<boolean> {
  try {
    const res = await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ action }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function createTask(input: {
  title: string;
  team: string;
  description: string;
  priority: TaskPriority;
}): Promise<BuildTask | null> {
  try {
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error("api");
    const payload = await res.json();
    const tasks = extractTasks(payload);
    return tasks?.[0] ?? null;
  } catch {
    return {
      id: `q-${Date.now()}`,
      title: input.title,
      team: input.team,
      description: input.description,
      files: [],
      priority: input.priority,
      status: "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }
}

/* ------------------------------------------------------------------ */
/*  صفحه                                                              */
/* ------------------------------------------------------------------ */

/** توضیح کار با قابلیت باز و بسته شدن (line-clamp در موبایل) */
function TaskDescription({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-3">
      <p
        className={`text-sm leading-7 text-muted-foreground ${open ? "" : "line-clamp-3"}`}
      >
        {text}
      </p>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mt-1 inline-flex min-h-[32px] items-center text-xs font-medium text-brand hover:underline"
      >
        {open ? "بستن" : "بیشتر"}
      </button>
    </div>
  );
}

export default function QueuePage() {
  const [tab, setTab] = useState<TaskStatus>("pending");
  const [tasks, setTasks] = useState<BuildTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [form, setForm] = useState({
    title: "",
    team: "dev",
    description: "",
    priority: "medium" as TaskPriority,
  });

  const showToast = useCallback((text: string, kind: "ok" | "err" = "ok") => {
    setToast({ text, kind });
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    const results = await Promise.allSettled(STATUSES.map((s) => fetchTasks(s.key)));
    const merged = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    const seen = new Map<string, BuildTask>();
    for (const t of merged) if (!seen.has(t.id)) seen.set(t.id, t);
    setTasks(Array.from(seen.values()));
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const counts = useMemo(() => {
    const c: Record<TaskStatus, number> = {
      pending: 0,
      in_progress: 0,
      done: 0,
      failed: 0,
      rejected: 0,
    };
    for (const t of tasks) c[t.status] += 1;
    return c;
  }, [tasks]);

  const visible = useMemo(
    () =>
      tasks
        .filter((t) => t.status === tab)
        .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)),
    [tasks, tab]
  );

  const PAGE_SIZE = 6;
  const { visible: shownCount, hasMore, showMore } = useVisibleCount(visible.length, PAGE_SIZE, tab);
  const shownTasks = visible.slice(0, shownCount);

  const handleAction = async (id: string, action: "approve" | "reject") => {
    setActing(id);
    await patchTask(id, action);
    const nextStatus: TaskStatus = action === "approve" ? "in_progress" : "rejected";
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, status: nextStatus, updated_at: new Date().toISOString() } : t))
    );
    setActing(null);
    showToast(
      action === "approve" ? "کار تأیید شد و به صف اجرا رفت." : "کار رد شد."
    );
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) {
      showToast("عنوان کار را بنویسید.", "err");
      return;
    }
    setSubmitting(true);
    const created = await createTask({
      title: form.title.trim(),
      team: form.team,
      description: form.description.trim(),
      priority: form.priority,
    });
    setSubmitting(false);
    if (created) {
      setTasks((prev) => [created, ...prev]);
      setForm({ title: "", team: "dev", description: "", priority: "medium" });
      setFormOpen(false);
      setTab("pending");
      showToast("کار تازه در صف «در انتظار» ثبت شد.");
    } else {
      showToast("ثبت کار ناموفق بود.", "err");
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      {/* سربرگ */}
      <PageHeader
        icon={ListChecks}
        title="مدیر صف ساخت"
        subtitle="کارهای پیشنهادی تیم‌ها را بررسی، تأیید یا رد کنید؛ یا کار تازه‌ای دستی ثبت کنید."
        actions={
          <>
            <button
              type="button"
              onClick={reload}
              className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm shadow-control transition hover:bg-accent sm:flex-none"
            >
              <RotateCw size={16} strokeWidth={2} aria-hidden="true" />
              تازه‌سازی
            </button>
            <button
              type="button"
              onClick={() => setFormOpen((v) => !v)}
              className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm text-brand-foreground shadow-control transition hover:opacity-90 sm:flex-none"
            >
              <Plus size={16} strokeWidth={2} aria-hidden="true" />
              {formOpen ? "بستن فرم" : "ثبت کار تازه"}
            </button>
          </>
        }
      />

      {/* فرم ثبت دستی */}
      {formOpen && (
        <section className="mb-6 rounded-xl border border-border bg-card p-5 shadow-surface">
          <h2 className="mb-4 text-lg font-bold">ثبت کار دستی</h2>
          <form onSubmit={handleCreate} className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">عنوان</span>
              <input
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="مثلاً: بازطراحی بنر هیروی صفحهٔ تورها"
                className="w-full min-h-[44px] rounded-lg border border-input bg-background px-3 py-2.5 text-sm"
              />
            </label>
            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="mb-1 block text-sm font-medium">تیم</span>
                <select
                  value={form.team}
                  onChange={(e) => setForm((f) => ({ ...f, team: e.target.value }))}
                  className="w-full min-h-[44px] rounded-lg border border-input bg-background px-3 py-2.5 text-sm"
                >
                  {TEAMS.map((t) => (
                    <option key={t} value={t}>
                      {teamLabel(t)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">اولویت</span>
                <select
                  value={form.priority}
                  onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value as TaskPriority }))}
                  className="w-full min-h-[44px] rounded-lg border border-input bg-background px-3 py-2.5 text-sm"
                >
                  {PRIORITIES.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block md:col-span-2">
              <span className="mb-1 block text-sm font-medium">توضیح</span>
              <textarea
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                rows={3}
                placeholder="شرح کوتاه کار و دلیلش"
                className="w-full min-h-[44px] rounded-lg border border-input bg-background px-3 py-2.5 text-sm"
              />
            </label>
            <div className="md:col-span-2">
              <button
                type="submit"
                disabled={submitting}
                className="min-h-[48px] w-full rounded-lg bg-brand px-6 py-2 text-sm font-bold text-brand-foreground shadow-control transition hover:opacity-90 disabled:opacity-50 sm:w-auto"
              >
                {submitting ? "در حال ثبت..." : "ثبت در صف"}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* فیلتر وضعیت */}
      <nav className="mb-6 flex gap-2 overflow-x-auto pb-2 sm:flex-wrap sm:overflow-visible sm:pb-0" aria-label="فیلتر وضعیت">
        {STATUSES.map((s) => {
          const active = tab === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setTab(s.key)}
              aria-pressed={active}
              className={`min-h-[40px] shrink-0 rounded-full border px-4 py-1.5 text-sm transition ${
                active
                  ? "border-brand bg-brand text-brand-foreground shadow-control"
                  : "border-border bg-card text-foreground hover:bg-accent"
              }`}
            >
              {s.label}
              <span className={`ms-2 inline-block rounded-full px-1.5 text-xs ${active ? "bg-black/15" : "bg-secondary"}`}>
                {faNum(counts[s.key])}
              </span>
            </button>
          );
        })}
      </nav>

      {/* لیست کارها */}
      {loading ? (
        <div className="tg-stagger grid gap-3 sm:gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <SkeletonPanel key={i} />
          ))}
        </div>
      ) : visible.length === 0 ? (
        (() => {
          const meta = TAB_EMPTY[tab];
          return (
            <EmptyState
              icon={meta.icon}
              title={meta.title}
              description={meta.description}
              tint="bg-muted text-muted-foreground"
              action={
                tab === "pending" ? (
                  <button
                    type="button"
                    onClick={() => setFormOpen(true)}
                    className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-brand px-5 py-2 text-sm font-bold text-brand-foreground shadow-control transition hover:opacity-90"
                  >
                    <Plus size={16} strokeWidth={2} aria-hidden="true" />
                    ثبت کار تازه
                  </button>
                ) : undefined
              }
            />
          );
        })()
      ) : (
        <>
        <div className="grid gap-4 md:grid-cols-2">
          {shownTasks.map((task) => {
            const priorityLabel = PRIORITIES.find((p) => p.key === task.priority)?.label ?? task.priority;
            const statusLabel = STATUSES.find((s) => s.key === task.status)?.label ?? task.status;
            return (
              <article key={task.id} className="flex flex-col rounded-xl border border-border bg-card p-5 shadow-surface">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground">
                    تیم {teamLabel(task.team)}
                  </span>
                  <span className={`rounded-full px-3 py-1 text-xs font-medium ${PRIORITY_STYLE[task.priority]}`}>
                    اولویت {priorityLabel}
                  </span>
                  <span className={`ms-auto rounded-full px-3 py-1 text-xs ${STATUS_BADGE[task.status]}`}>
                    {statusLabel}
                  </span>
                </div>

                <h3 className="mb-1 text-base font-bold">{task.title}</h3>
                {task.description && <TaskDescription text={task.description} />}

                {task.files.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {task.files.map((f) => (
                      <code
                        key={f}
                        dir="ltr"
                        className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        {f}
                      </code>
                    ))}
                  </div>
                )}

                <div className="mt-auto flex items-center justify-between pt-3">
                  <span className="text-xs text-muted-foreground">{relativeTime(task.created_at)}</span>
                  {task.status === "pending" && (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={acting === task.id}
                        onClick={() => handleAction(task.id, "approve")}
                        className="min-h-[44px] rounded-lg bg-success px-4 py-1.5 text-sm text-success-foreground shadow-control transition hover:opacity-90 disabled:opacity-50"
                      >
                        {acting === task.id ? "صبر کنید..." : "تأیید"}
                      </button>
                      <button
                        type="button"
                        disabled={acting === task.id}
                        onClick={() => handleAction(task.id, "reject")}
                        className="min-h-[44px] rounded-lg border border-destructive px-4 py-1.5 text-sm text-destructive transition hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
                      >
                        رد
                      </button>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
        {hasMore && (
          <LoadMore visible={shownCount} total={visible.length} onShowMore={showMore} />
        )}
        </>
      )}

      {/* اعلان */}
      {toast && (
        <div
          role="status"
          className={`fixed bottom-6 start-1/2 z-50 max-w-[calc(100vw-2rem)] translate-x-1/2 rounded-xl px-5 py-3 text-sm shadow-surface ${
            toast.kind === "ok" ? "bg-success text-success-foreground" : "bg-destructive text-destructive-foreground"
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
