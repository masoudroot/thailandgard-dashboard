"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BellRing,
  CheckCircle2,
  ClipboardList,
  Clock3,
  Info,
  Loader2,
  Play,
  Users,
  Waves,
  XCircle,
} from "lucide-react";

/* ─────────────────────────────────────────────
   ابزارهای نمایشی
   ───────────────────────────────────────────── */

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** تبدیل ارقام لاتین به فارسی برای لایهٔ نمایش */
function fa(n: number | string): string {
  return String(n).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]);
}

const WAVE_WORDS = ["اول", "دوم", "سوم", "چهارم", "پنجم", "ششم"] as const;

/** نام فارسی هر تیم */
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
  qa: "کنترل کیفیت",
  inspector: "بازرس",
};

type TeamStatus = "pending" | "running" | "success" | "failed";

const TEAM_STATUS_LABEL: Record<TeamStatus, string> = {
  pending: "در انتظار",
  running: "در حال اجرا",
  success: "موفق",
  failed: "ناموفق",
};

const TEAM_STATUS_DOT: Record<TeamStatus, string> = {
  pending: "bg-muted-foreground/40",
  running: "bg-brand animate-pulse",
  success: "bg-success",
  failed: "bg-destructive",
};

interface WaveTeam {
  team: string;
  status: TeamStatus;
}

interface Wave {
  wave: number;
  teams: WaveTeam[];
}

interface CycleSummary {
  id: string;
  status: "running" | "success" | "failed";
  progress: number;
  currentWave: number;
  activeTeam: string;
  startedAgo: string;
  waves: Wave[];
}

interface AlertItem {
  id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  timeAgo: string;
}

/* ─────────────────────────────────────────────
   دادهٔ نمایشی (تا وقتی API واقعی وصل شود)
   ───────────────────────────────────────────── */

const MOCK_CYCLE: CycleSummary = {
  id: "CYC-1842",
  status: "running",
  progress: 68,
  currentWave: 4,
  activeTeam: "dev",
  startedAgo: "۲ ساعت پیش",
  waves: [
    {
      wave: 1,
      teams: [
        { team: "artdir", status: "success" },
        { team: "branding", status: "success" },
        { team: "content", status: "success" },
      ],
    },
    {
      wave: 2,
      teams: [
        { team: "analytics", status: "success" },
        { team: "intel", status: "success" },
        { team: "lead", status: "success" },
      ],
    },
    {
      wave: 3,
      teams: [
        { team: "design", status: "success" },
        { team: "seo", status: "success" },
        { team: "seocontent", status: "success" },
      ],
    },
    {
      wave: 4,
      teams: [
        { team: "design-ir", status: "success" },
        { team: "dev", status: "running" },
        { team: "farsiui", status: "pending" },
      ],
    },
    {
      wave: 5,
      teams: [
        { team: "vibefarsi", status: "pending" },
        { team: "qa", status: "pending" },
      ],
    },
    { wave: 6, teams: [{ team: "inspector", status: "pending" }] },
  ],
};

const MOCK_ALERTS: AlertItem[] = [
  {
    id: "a1",
    severity: "warning",
    title: "نرخ خطای تیم سئو در موج سوم بالا رفت",
    detail: "۳ تلاش ناموفق پشت سر هم در فراخوانی مدل؛ فالبک فعال شد.",
    timeAgo: "۲۵ دقیقه پیش",
  },
  {
    id: "a2",
    severity: "info",
    title: "موج سوم با موفقیت کامل شد",
    detail: "هر ۳ تیم خروجی را تحویل دادند و وارد صف بازبینی شدند.",
    timeAgo: "۱ ساعت پیش",
  },
  {
    id: "a3",
    severity: "critical",
    title: "اتصال API فروش دو بار قطع شد",
    detail: "تیم لید دادهٔ تازه ندارد؛ با آخرین کش سالم ادامه می‌دهد.",
    timeAgo: "۲ ساعت پیش",
  },
];

const ALERT_META: Record<
  AlertItem["severity"],
  { icon: typeof Info; label: string; ring: string; badge: string }
> = {
  info: {
    icon: Info,
    label: "اطلاع",
    ring: "bg-brand/10 text-brand",
    badge: "bg-brand/10 text-brand",
  },
  warning: {
    icon: AlertTriangle,
    label: "هشدار",
    ring: "bg-warning/10 text-warning",
    badge: "bg-warning/10 text-warning",
  },
  critical: {
    icon: XCircle,
    label: "بحرانی",
    ring: "bg-destructive/10 text-destructive",
    badge: "bg-destructive/10 text-destructive",
  },
};

function waveState(wave: Wave, currentWave: number): "done" | "active" | "todo" {
  const allSuccess = wave.teams.every((t) => t.status === "success");
  if (allSuccess) return "done";
  if (wave.wave === currentWave) return "active";
  if (wave.wave < currentWave) return "done";
  return "todo";
}

/* ─────────────────────────────────────────────
   صفحه
   ───────────────────────────────────────────── */

export default function DashboardHomePage() {
  const [cycle, setCycle] = useState<CycleSummary | null>(null);
  const [alerts, setAlerts] = useState<AlertItem[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [queuedNotice, setQueuedNotice] = useState(false);
  const [queuedExtra, setQueuedExtra] = useState(0);

  /* اول API واقعی را امتحان می‌کنیم؛ نبود، mock می‌نشانیم */
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);

    Promise.all([
      fetch("/api/cycles?limit=1", { signal: controller.signal }),
      fetch("/api/alerts?limit=5", { signal: controller.signal }),
    ])
      .then(async ([cyclesRes, alertsRes]) => {
        let nextCycle: CycleSummary | null = null;
        let nextAlerts: AlertItem[] | null = null;
        if (cyclesRes.ok) {
          const body = await cyclesRes.json().catch(() => null);
          const raw = body?.ok ? body.data : body?.data?.[0] ?? body?.[0];
          if (raw) nextCycle = raw as CycleSummary;
        }
        if (alertsRes.ok) {
          const body = await alertsRes.json().catch(() => null);
          const raw = body?.ok ? body.data : body;
          if (Array.isArray(raw) && raw.length > 0) nextAlerts = raw;
        }
        setCycle(nextCycle ?? MOCK_CYCLE);
        setAlerts(nextAlerts ?? MOCK_ALERTS);
      })
      .catch(() => {
        setCycle(MOCK_CYCLE);
        setAlerts(MOCK_ALERTS);
      })
      .finally(() => clearTimeout(timer));

    return () => controller.abort();
  }, []);

  const loading = cycle === null || alerts === null;

  const queueCount = 7 + queuedExtra;
  const stats = [
    {
      icon: Activity,
      label: "چرخه‌های اجراشده",
      value: fa(42),
      hint: "از ابتدای مهر",
      tint: "bg-brand/10 text-brand",
    },
    {
      icon: Users,
      label: "تیم‌های فعال",
      value: fa(15),
      hint: "در ۶ موج",
      tint: "bg-success/10 text-success",
    },
    {
      icon: ClipboardList,
      label: "کارهای در صف",
      value: fa(queueCount),
      hint: "منتظر شروع چرخه",
      tint: "bg-warning/10 text-warning",
    },
    {
      icon: Clock3,
      label: "آخرین چرخه",
      value: cycle ? fa(cycle.id.replace("CYC-", "")) : fa(1842),
      hint: cycle?.startedAgo ?? "۲ ساعت پیش",
      tint: "bg-brand/10 text-brand",
    },
  ];

  const handleConfirmStart = () => {
    if (starting || queuedNotice) return;
    setStarting(true);
    setTimeout(() => {
      setStarting(false);
      setDialogOpen(false);
      setQueuedNotice(true);
      setQueuedExtra((n) => n + 1);
    }, 1200);
  };

  const activeWaveTeams =
    cycle?.waves.find((w) => w.wave === cycle.currentWave)?.teams ?? [];

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-4 pb-16 pt-8 md:px-8 md:pt-12">
        {/* ── هیرو ── */}
        <section
          aria-label="معرفی داشبورد"
          className="relative overflow-hidden rounded-3xl border border-border bg-gradient-to-bl from-brand/15 via-card to-card p-6 shadow-[var(--shadow-surface)] md:p-10"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -start-24 -top-24 h-64 w-64 rounded-full bg-brand/15 blur-3xl"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-28 -end-20 h-72 w-72 rounded-full bg-success/10 blur-3xl"
          />
          <div className="relative">
            <p className="mb-2 inline-flex items-center gap-2 rounded-full bg-brand/10 px-3 py-1 text-sm font-medium text-brand">
              <BellRing size={16} strokeWidth={1.75} />
              عملیات زندهٔ تیم‌های هوش مصنوعی
            </p>
            <h1 className="text-3xl font-extrabold md:text-4xl">
              داشبورد ایجنتیک تایلندگرد
            </h1>
            <p className="mt-3 max-w-2xl text-lg text-muted-foreground">
              پانزده تیم هوش مصنوعی، شش موج، یک چرخهٔ بی‌وقفه برای رشد
              تایلندگرد. این‌جا می‌بینی هر تیم کجای کار است و چرخهٔ بعدی را از
              همین‌جا شروع می‌کنی.
            </p>

            {/* آمار کلی */}
            <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
              {loading
                ? Array.from({ length: 4 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-28 animate-pulse rounded-2xl bg-muted"
                    />
                  ))
                : stats.map((s) => (
                    <div
                      key={s.label}
                      className="rounded-2xl border border-border bg-card p-4 shadow-[var(--shadow-control)]"
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${s.tint}`}
                        >
                          <s.icon size={20} strokeWidth={1.75} />
                        </span>
                        <div className="min-w-0">
                          <div className="text-2xl font-extrabold leading-tight">
                            {s.value}
                          </div>
                          <div className="truncate text-sm text-muted-foreground">
                            {s.label}
                          </div>
                        </div>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {s.hint}
                      </p>
                    </div>
                  ))}
            </div>
          </div>
        </section>

        {/* ── آخرین چرخه + هشدارها ── */}
        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          {/* کارت آخرین چرخه */}
          <section
            aria-label="آخرین چرخه"
            className="rounded-3xl border border-border bg-card p-6 shadow-[var(--shadow-surface)] lg:col-span-2"
          >
            {loading || !cycle ? (
              <div className="h-64 animate-pulse rounded-2xl bg-muted" />
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-xl font-bold">آخرین چرخه</h2>
                  <span className="inline-flex items-center gap-2 rounded-full bg-brand/10 px-3 py-1 text-sm font-medium text-brand">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-brand" />
                    در حال اجرا
                  </span>
                </div>

                <div className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm text-muted-foreground">
                  <span>
                    شناسهٔ چرخه:{" "}
                    <span dir="ltr" className="font-semibold text-foreground">
                      {cycle.id}
                    </span>
                  </span>
                  <span>
                    موج جاری: موج {WAVE_WORDS[cycle.currentWave - 1]} از شش
                  </span>
                  <span>
                    تیم فعال:{" "}
                    <span className="font-semibold text-foreground">
                      {TEAM_LABELS[cycle.activeTeam] ?? cycle.activeTeam}
                    </span>
                  </span>
                  <span>شروع: {cycle.startedAgo}</span>
                </div>

                {/* نوار پیشرفت */}
                <div className="mt-6">
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span className="font-medium">پیشرفت چرخه</span>
                    <span className="font-bold text-brand">
                      {fa(cycle.progress)}٪
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-valuenow={cycle.progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="پیشرفت چرخه"
                    className="h-3 overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className="h-full rounded-full bg-gradient-to-l from-brand to-warning transition-[width] duration-700"
                      style={{ width: `${cycle.progress}%` }}
                    />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {activeWaveTeams.filter((t) => t.status === "success").length}{" "}
                    از {fa(activeWaveTeams.length)} تیم موج جاری کارشان را تمام
                    کرده‌اند.
                  </p>
                </div>

                {/* دکمه شروع */}
                <div className="mt-6 border-t border-border pt-6">
                  {queuedNotice ? (
                    <p className="flex items-center gap-2 rounded-2xl bg-success/10 px-4 py-3 text-sm font-medium text-success">
                      <CheckCircle2 size={18} strokeWidth={1.75} />
                      چرخهٔ جدید در صف شروع قرار گرفت؛ بعد از پایان موج جاری
                      آغاز می‌شود.
                    </p>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setDialogOpen(true)}
                      className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl bg-brand px-6 font-bold text-brand-foreground shadow-[var(--shadow-control)] transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:w-auto"
                    >
                      <Play size={20} strokeWidth={2} />
                      شروع چرخهٔ جدید
                    </button>
                  )}
                </div>
              </>
            )}
          </section>

          {/* کارت هشدارها */}
          <section
            aria-label="هشدارهای اخیر"
            className="rounded-3xl border border-border bg-card p-6 shadow-[var(--shadow-surface)]"
          >
            <h2 className="text-xl font-bold">هشدارهای اخیر</h2>
            <div className="mt-4 space-y-4">
              {loading || !alerts ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-20 animate-pulse rounded-2xl bg-muted"
                  />
                ))
              ) : alerts.length === 0 ? (
                <p className="rounded-2xl bg-muted px-4 py-6 text-center text-sm text-muted-foreground">
                  هشدار تازه‌ای نیست؛ همه‌چیز آرام است.
                </p>
              ) : (
                alerts.map((a) => {
                  const meta = ALERT_META[a.severity];
                  const Icon = meta.icon;
                  return (
                    <article
                      key={a.id}
                      className="flex gap-3 rounded-2xl border border-border p-3"
                    >
                      <span
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${meta.ring}`}
                      >
                        <Icon size={18} strokeWidth={1.75} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="truncate text-sm font-bold">
                            {a.title}
                          </h3>
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${meta.badge}`}
                          >
                            {meta.label}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs leading-6 text-muted-foreground">
                          {a.detail}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {a.timeAgo}
                        </p>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </section>
        </div>

        {/* ── شش موج ── */}
        <section
          aria-label="موج‌های چرخه"
          className="mt-6 rounded-3xl border border-border bg-card p-6 shadow-[var(--shadow-surface)] md:p-8"
        >
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand">
              <Waves size={20} strokeWidth={1.75} />
            </span>
            <div>
              <h2 className="text-xl font-bold">موج‌های چرخه</h2>
              <p className="text-sm text-muted-foreground">
                هر چرخه، پانزده تیم را در شش موج پشت سر هم اجرا می‌کند.
              </p>
            </div>
          </div>

          {loading || !cycle ? (
            <div className="mt-6 h-40 animate-pulse rounded-2xl bg-muted" />
          ) : (
            <>
              {/* خط زمانی */}
              <div className="relative mt-8 px-2">
                <div
                  aria-hidden="true"
                  className="absolute inset-x-8 top-5 hidden border-t-2 border-dashed border-border md:block"
                />
                <ol className="relative grid grid-cols-3 gap-6 md:grid-cols-6">
                  {cycle.waves.map((w) => {
                    const state = waveState(w, cycle.currentWave);
                    const done = state === "done";
                    const active = state === "active";
                    return (
                      <li key={w.wave} className="flex flex-col items-center text-center">
                        <span
                          className={`flex h-10 w-10 items-center justify-center rounded-full border-2 font-bold ${
                            done
                              ? "border-success bg-success/10 text-success"
                              : active
                                ? "border-brand bg-brand/10 text-brand"
                                : "border-border bg-muted text-muted-foreground"
                          }`}
                        >
                          {done ? (
                            <CheckCircle2 size={20} strokeWidth={1.75} />
                          ) : (
                            fa(w.wave)
                          )}
                        </span>
                        <span className="mt-2 text-sm font-bold">
                          موج {WAVE_WORDS[w.wave - 1]}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {done
                            ? "کامل شد"
                            : active
                              ? "در حال اجرا"
                              : "در راه"}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </div>

              {/* جزئیات هر موج */}
              <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {cycle.waves.map((w) => {
                  const state = waveState(w, cycle.currentWave);
                  return (
                    <div
                      key={w.wave}
                      className={`rounded-2xl border p-4 ${
                        state === "active"
                          ? "border-brand/50 bg-brand/[0.04]"
                          : "border-border"
                      }`}
                    >
                      <h3 className="flex items-center justify-between text-sm font-bold">
                        <span>موج {WAVE_WORDS[w.wave - 1]}</span>
                        <span className="font-normal text-muted-foreground">
                          {fa(w.teams.length)} تیم
                        </span>
                      </h3>
                      <ul className="mt-3 space-y-2">
                        {w.teams.map((t) => (
                          <li
                            key={t.team}
                            className="flex items-center justify-between gap-2 text-sm"
                          >
                            <span className="flex items-center gap-2">
                              <span
                                className={`h-2.5 w-2.5 rounded-full ${TEAM_STATUS_DOT[t.status]}`}
                              />
                              {TEAM_LABELS[t.team] ?? t.team}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {TEAM_STATUS_LABEL[t.status]}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>
      </div>

      {/* ── گفت‌وگوی تأیید شروع چرخه ── */}
      {dialogOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="start-cycle-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4"
          onClick={() => !starting && setDialogOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-[var(--shadow-surface)]"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="start-cycle-title" className="text-lg font-bold">
              چرخهٔ جدید شروع شود؟
            </h2>
            <p className="mt-2 text-sm leading-7 text-muted-foreground">
              چرخهٔ تازه بعد از پایان موج جاری آغاز می‌شود و پانزده تیم از اول
              وارد صف می‌شوند. چرخهٔ در حال اجرا متوقف نمی‌شود.
            </p>
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                disabled={starting}
                onClick={handleConfirmStart}
                className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-2xl bg-brand px-5 font-bold text-brand-foreground shadow-[var(--shadow-control)] transition hover:brightness-110 disabled:opacity-60"
              >
                {starting ? (
                  <>
                    <Loader2 size={18} strokeWidth={2} className="animate-spin" />
                    در حال ثبت…
                  </>
                ) : (
                  <>
                    <Play size={18} strokeWidth={2} />
                    شروع چرخه
                  </>
                )}
              </button>
              <button
                type="button"
                disabled={starting}
                onClick={() => setDialogOpen(false)}
                className="inline-flex min-h-[44px] items-center justify-center rounded-2xl border border-border bg-card px-5 font-medium text-foreground transition hover:bg-muted disabled:opacity-60"
              >
                انصراف
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
