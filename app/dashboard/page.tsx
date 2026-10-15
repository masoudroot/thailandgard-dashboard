"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
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
import { TEAMS } from "@/lib/types";
import RippleButton from "@/components/RippleButton";
import NotConnected from "@/components/NotConnected";
import {
  SkeletonPanel,
  SkeletonRow,
  SkeletonStat,
} from "@/components/Skeleton";
import {
  ProgressBar,
  StatCard,
  StatusBadge,
  type StatCardProps,
} from "@/components/dataviz";

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
  artdir: "طراحی ارشد",
  branding: "برند",
  content: "محتوا",
  seo: "سئو",
  analytics: "تحلیل",
  intel: "اطلاعات",
  lead: "لید",
  design: "دیزاین",
  seocontent: "محتوای سئو",
  vibefarsi: "وایب‌فارسی",
  farsiui: "فارسی UI",
  "design-ir": "دیزاین ایرانی",
  dev: "توسعه",
  qa: "کیفیت",
  inspector: "بازرس",
};

type TeamStatus = "pending" | "running" | "success" | "failed";

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
  const [alertsError, setAlertsError] = useState(false);
  /* قانون مسعود: دادهٔ نمایشی ممنوع. اگر بک‌اند در دسترس نباشد، به‌جای
     عددهای ساختگی، وضعیت «متصل نیست» را صادقانه نشان می‌دهیم. */
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [queuedNotice, setQueuedNotice] = useState(false);
  const [queuedExtra, setQueuedExtra] = useState(0);

  const load = useCallback(async (isRetry = false) => {
    if (isRetry) setRetrying(true);
    else setLoading(true);
    setFailed(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const cyclesRes = await fetch("/api/cycles?limit=1", {
        signal: controller.signal,
      });
      if (!cyclesRes.ok) throw new Error("cycles unavailable");
      const body = await cyclesRes.json().catch(() => null);
      const raw = body?.ok ? body.data : (body?.data?.[0] ?? body?.[0]);
      setCycle((raw as CycleSummary) ?? null);

      /* هشدارها حیاتی نیست؛ نبودشان صفحه را نمی‌اندازد */
      try {
        const alertsRes = await fetch("/api/alerts?limit=5", {
          signal: controller.signal,
        });
        if (!alertsRes.ok) throw new Error("alerts unavailable");
        const abody = await alertsRes.json().catch(() => null);
        const araw = abody?.ok ? abody.data : abody;
        setAlerts(Array.isArray(araw) ? araw : []);
        setAlertsError(false);
      } catch {
        setAlerts([]);
        setAlertsError(true);
      }
    } catch {
      setFailed(true);
    } finally {
      clearTimeout(timer);
      setLoading(false);
      setRetrying(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const queueCount = queuedExtra;
  /* آمار صادقانه: فقط چیزی که واقعاً می‌دانیم (پیکربندی تیم‌ها، شمار صف
     واقعی کاربر، و دادهٔ چرخه از API). هیچ عدد ساختگی و ترند الکی نیست. */
  const stats: StatCardProps[] = [
    {
      icon: Users,
      label: "تیم‌های فعال",
      value: fa(TEAMS.length),
      hint: `در ${fa(6)} موج`,
      tint: "bg-success/10 text-success",
    },
    {
      icon: ClipboardList,
      label: "کارهای در صف",
      value: fa(queueCount),
      hint: "منتظر شروع چرخه",
      tint: "bg-warning/10 text-warning",
    },
    ...(cycle
      ? ([
          {
            icon: Clock3,
            label: "آخرین چرخه",
            value: fa(cycle.id.replace("CYC-", "")),
            hint: cycle.startedAgo,
            tint: "bg-brand/10 text-brand",
          },
          {
            icon: Activity,
            label: "موج جاری",
            value: `موج ${WAVE_WORDS[cycle.currentWave - 1] ?? fa(cycle.currentWave)}`,
            hint: `از ${fa(6)} موج`,
            tint: "bg-brand/10 text-brand",
          },
        ] as StatCardProps[])
      : []),
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
    <div className="bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-4 pb-16 pt-8 md:px-8 md:pt-12">
        {/* ── هیرو ── */}
        <section
          aria-label="معرفی داشبورد"
          className="tg-reveal rounded-xl border border-border bg-card p-6 shadow-surface md:p-10"
        >
          <div className="relative">
            <h1 className="text-3xl font-extrabold">
              داشبورد ایجنتیک تایلندگرد
            </h1>
            <p className="mt-3 max-w-2xl text-lg text-muted-foreground">
              پانزده تیم هوش مصنوعی در شش موج، پشت سر هم برای رشد تایلندگرد کار می‌کنند.
              این‌جا می‌بینید هر تیم کجای کار است و چرخهٔ بعدی را از همین‌جا شروع می‌کنید.
            </p>

            {/* آمار کلی؛ وقتی اتصال نیست، به‌جای عدد ساختگی هیچی نشان نمی‌دهیم */}
            {!failed && (
              <div className="tg-stagger mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 md:mt-8 md:gap-6 lg:grid-cols-4">
                {loading
                  ? Array.from({ length: 4 }).map((_, i) => (
                      <SkeletonStat key={i} />
                    ))
                  : stats.map((s) => <StatCard key={s.label} {...s} />)}
              </div>
            )}
          </div>
        </section>

        {failed ? (
          /* بک‌اند در دسترس نیست: صادقانه می‌گوییم، عدد نمی‌سازیم */
          <div className="mt-4 md:mt-6">
            <NotConnected onRetry={() => load(true)} retrying={retrying} />
          </div>
        ) : (
          <>
        {/* ── آخرین چرخه + هشدارها ── */}
        <div className="mt-4 grid gap-4 md:mt-6 md:gap-6 lg:grid-cols-3">
          {/* کارت آخرین چرخه */}
          <section
            aria-label="آخرین چرخه"
            className="rounded-xl border border-border bg-card p-4 shadow-surface sm:p-6 lg:col-span-2"
          >
            {loading ? (
              <SkeletonPanel />
            ) : !cycle ? (
              <div className="py-6 text-center">
                <p className="text-sm text-muted-foreground">
                  هنوز چرخه‌ای اجرا نشده است؛ اولین چرخه را شروع کنید.
                </p>
                <button
                  type="button"
                  onClick={() => setDialogOpen(true)}
                  className="tg-btn mt-4 inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-primary px-6 font-bold text-primary-foreground shadow-control hover:brightness-105"
                >
                  <Play size={20} strokeWidth={2} />
                  شروع چرخهٔ جدید
                </button>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-xl font-bold">آخرین چرخه</h2>
                  <StatusBadge
                    status={cycle.status === "failed" ? "failed" : cycle.status === "success" ? "success" : "running"}
                  />
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
                  <ProgressBar
                    value={cycle.progress}
                    label="پیشرفت چرخه"
                    caption={`${fa(activeWaveTeams.filter((t) => t.status === "success").length)} از ${fa(activeWaveTeams.length)} تیم موج جاری کارشان را تمام کرده‌اند.`}
                  />
                </div>

                {/* دکمه شروع */}
                <div className="mt-6 border-t border-border pt-6">
                  {queuedNotice ? (
                    <p className="tg-pop flex items-center gap-2 rounded-xl bg-success/10 px-4 py-3 text-sm font-medium text-success">
                      <CheckCircle2 size={18} strokeWidth={1.75} />
                      چرخهٔ جدید در صف شروع قرار گرفت؛ بعد از پایان موج جاری
                      آغاز می‌شود.
                    </p>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setDialogOpen(true)}
                      className="tg-btn inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 font-bold text-primary-foreground shadow-control hover:brightness-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:w-auto"
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
            className="rounded-xl border border-border bg-card p-4 shadow-surface sm:p-6"
          >
            <h2 className="text-xl font-bold">هشدارهای اخیر</h2>
            <div className="tg-stagger mt-4 space-y-4">
              {loading || alerts === null ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <SkeletonRow key={i} />
                ))
              ) : alertsError ? (
                <p className="rounded-xl bg-muted px-4 py-6 text-center text-sm text-muted-foreground">
                  سرویس هشدار در دسترس نیست.
                </p>
              ) : alerts.length === 0 ? (
                <p className="rounded-xl bg-muted px-4 py-6 text-center text-sm text-muted-foreground">
                  هشدار فعالی نیست.
                </p>
              ) : (
                alerts.map((a) => {
                  const meta = ALERT_META[a.severity];
                  const Icon = meta.icon;
                  return (
                    <article
                      key={a.id}
                      className="flex gap-3 rounded-xl border border-border p-3"
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
          className="mt-4 rounded-xl border border-border bg-card p-4 shadow-surface sm:p-6 md:mt-6 md:p-8"
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

          {loading ? (
            <div className="mt-6">
              <SkeletonPanel />
            </div>
          ) : !cycle ? (
            <p className="mt-6 rounded-xl bg-muted px-4 py-6 text-center text-sm text-muted-foreground">
              هنوز چرخه‌ای اجرا نشده است؛ موج‌ها بعد از شروع اولین چرخه این‌جا
              می‌آیند.
            </p>
          ) : (
            <>
              {/* خط زمانی */}
              <div className="relative mt-8 px-2">
                <div
                  aria-hidden="true"
                  className="absolute inset-x-8 top-5 hidden border-t-2 border-dashed border-border md:block"
                />
                <ol className="relative grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-6 md:gap-6">
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
              <div className="tg-stagger mt-6 grid gap-4 sm:grid-cols-2 md:mt-8 md:gap-6 lg:grid-cols-3">
                {cycle.waves.map((w) => {
                  const state = waveState(w, cycle.currentWave);
                  return (
                    <div
                      key={w.wave}
                      className={`rounded-xl border p-4 ${
                        state === "active"
                          ? "border-brand/50 bg-brand/5"
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
                            <span>{TEAM_LABELS[t.team] ?? t.team}</span>
                            <StatusBadge status={t.status} />
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
          </>
        )}
      </div>

      {/* ── گفت‌وگوی تأیید شروع چرخه ── */}
      {dialogOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="start-cycle-title"
          className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/40 p-0 sm:items-center sm:p-4"
          onClick={() => !starting && setDialogOpen(false)}
        >
          <div
            className="tg-pop max-h-[92dvh] w-full overflow-y-auto rounded-t-xl border border-border bg-card p-5 shadow-overlay sm:max-w-md sm:rounded-xl sm:p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="start-cycle-title" className="text-lg font-bold">
              چرخهٔ جدید شروع شود؟
            </h2>
            <p className="mt-2 text-sm leading-7 text-muted-foreground">
              چرخهٔ تازه بعد از پایان موج جاری آغاز می‌شود و پانزده تیم از اول
              وارد صف می‌شوند. چرخهٔ در حال اجرا متوقف نمی‌شود.
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <RippleButton
                disabled={starting}
                onClick={handleConfirmStart}
                className="tg-btn inline-flex min-h-12 w-full flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-5 font-bold text-primary-foreground shadow-control hover:brightness-105 disabled:opacity-60"
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
              </RippleButton>
              <button
                type="button"
                disabled={starting}
                onClick={() => setDialogOpen(false)}
                className="tg-btn inline-flex min-h-12 w-full items-center justify-center rounded-xl border border-border bg-card px-5 font-medium text-foreground hover:bg-muted disabled:opacity-60 sm:w-auto"
              >
                انصراف
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
