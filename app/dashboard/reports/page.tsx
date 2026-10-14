'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Cycle, TeamName } from '@/lib/types';

/* ------------------------------------------------------------------ */
/* کمک‌کننده‌های فارسی‌سازی                                          */
/* ------------------------------------------------------------------ */

/** ارقام لاتین را به فارسی تبدیل می‌کند. */
function faDigits(value: number | string): string {
  return String(value).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
}

/** تاریخ شمسی به وقت تهران. */
function jalaliDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(new Date(iso));
  } catch {
    return '';
  }
}

/** ساعت به وقت تهران. */
function tehranTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      timeZone: 'Asia/Tehran',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return '';
  }
}

/** مدت چرخه به دقیقهٔ فارسی. */
function durationFa(cycle: Cycle): string {
  if (!cycle.finished_at) return '';
  const ms = new Date(cycle.finished_at).getTime() - new Date(cycle.started_at).getTime();
  if (Number.isNaN(ms) || ms < 0) return '';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${faDigits(min)} دقیقه`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${faDigits(h)} ساعت` : `${faDigits(h)} ساعت و ${faDigits(m)} دقیقه`;
}

/* ------------------------------------------------------------------ */
/* نوع داده‌ها                                                         */
/* ------------------------------------------------------------------ */

/** قالب پنج‌محوری گزارش چرخه. */
interface AxisReport {
  goal: string; // هدف چه بود
  problem: string; // چه مشکلی بود
  plan: string; // قرار است چه شود
  outcome: string; // چه شد
  actions: string; // چه کاری انجام شد
  summary: string; // در کل چی شد؟
}

interface CycleReport extends Cycle {
  report: AxisReport;
  teams: TeamName[];
}

const TEAM_LABELS: Record<TeamName, string> = {
  artdir: 'مدیریت هنری',
  branding: 'برندینگ',
  content: 'محتوا',
  seo: 'سئو',
  analytics: 'تحلیل داده',
  intel: 'هوشمندی',
  lead: 'سرنخ',
  design: 'طراحی',
  seocontent: 'محتوای سئو',
  vibefarsi: 'وایب‌فارسی',
  farsiui: 'رابط فارسی',
  'design-ir': 'طراحی ایرانی',
  dev: 'توسعه',
  qa: 'کنترل کیفیت',
  inspector: 'بازرس',
};

const ALL_TEAMS: TeamName[] = [
  'artdir',
  'branding',
  'content',
  'seo',
  'analytics',
  'intel',
  'lead',
  'design',
  'seocontent',
  'vibefarsi',
  'farsiui',
  'design-ir',
  'dev',
  'qa',
  'inspector',
];

const AXIS_TITLES = [
  { key: 'goal', title: 'هدف چه بود' },
  { key: 'problem', title: 'چه مشکلی بود' },
  { key: 'plan', title: 'قرار است چه شود' },
  { key: 'outcome', title: 'چه شد' },
  { key: 'actions', title: 'چه کاری انجام شد' },
] as const;

/* ------------------------------------------------------------------ */
/* دادهٔ نمایشی (تا وقتی GET /api/cycles ساخته شود)                   */
/* ------------------------------------------------------------------ */

const MOCK_REPORTS: CycleReport[] = [
  {
    id: 'mock-cycle-1',
    run_id: 'TG-0722-03',
    status: 'success',
    started_at: '2026-10-14T03:58:00+03:30',
    finished_at: '2026-10-14T06:14:00+03:30',
    stats: { commits: 18, tasks: 42, teams: 15 },
    teams: ALL_TEAMS,
    report: {
      goal: 'هدف این چرخه، سبز نگه‌داشتن مسیر دیپلوی و جلو بردن صف نبض دیزاین بود؛ یعنی هیچ آیتم طراحی بیش از یک ساعت بدون پاسخ نماند و بیلد سایت روی هر پوش سالم بیلد شود.',
      problem: 'صبح دیپلوی روی یک فایل جدید که تیم dev ساخته ولی کامیت نکرده بود می‌افتاد؛ بیلد Turbopack با خطای Module not found قرمز شد و دو ران پشت سر هم شکست خوردند. هم‌زمان سه آیتم نبض دیزاین بیش از چهل دقیقه روی «مسدود» مانده بودند و جوابی از تیم مالک نرسیده بود.',
      plan: 'قرار بود همهٔ فایل‌های untracked پوشهٔ site شناسایی و در دو کامیت جدا کامیت شوند، ران دیپلوی دوباره اجرا شود، و آیتم‌های مسدود طبق قانون ضدپارکینگ در همان اجرا تشدید شوند: یا حکم تیم مالک گرفته شود یا راه‌حل استاندارد با ثبت در لاگ اعمال شود.',
      outcome: 'هر چهار فایل گمشده پیدا و کامیت شد؛ ران بعدی دیپلوی سبز شد و پروداکشن با همان کامیت به‌روز شد. هر سه آیتم مسدود هم تشدید شدند: یکی حکم گرفت و جلو رفت، دو تای دیگر با راه‌حل استاندارد بسته شدند.',
      actions: 'تیم dev فایل‌های untracked را فهرست کرد و در دو کامیت پوش کرد؛ تیم qa بیلد را راستی‌آزمایی کرد؛ بازرس قانون ضدپارکینگ را روی آیتم‌های مسدود اجرا کرد؛ تیم محتوا گزارش نهایی چرخه را بست و به تلگرام اطلاع‌رسانی شد.',
      summary:
        'در کل چرخهٔ موفقی بود. دو گرهٔ واقعی باز شدند: دیپلوی از قرمز به سبز برگشت و سه آیتم مسدود از پارکینگ بیرون آمدند. تنها نکتهٔ باقی‌مانده این است که تیم dev باید پیش از هر پوش، چک‌لیست فایل‌های untracked را بزند تا این سناریو تکرار نشود؛ این قانون به چک‌لیست تیم اضافه شد.',
    },
  },
  {
    id: 'mock-cycle-2',
    run_id: 'TG-0721-02',
    status: 'success',
    started_at: '2026-10-13T22:05:00+03:30',
    finished_at: '2026-10-14T00:31:00+03:30',
    stats: { commits: 11, tasks: 27, teams: 15 },
    teams: ALL_TEAMS,
    report: {
      goal: 'هدف، به‌روزرسانی قیمت تورهای صفحهٔ اصلی و همگام‌سازی داده‌های تورسنج بود تا هیچ تور قدیمی با قیمت کهنه روی سایت نماند.',
      problem: 'در سه تور، قیمت دیتابیس با قیمت سایت یکی نبود و تورسنج روی دو تور خطای تازگی داده می‌داد. کاربر سایت قیمت قدیم می‌دید و تیم فروش از اختلاف قیمت شکایت داشت.',
      plan: 'قرار بود کوئری‌های تورسنج مستقیم اجرا شوند، قیمت‌ها از دیتابیس خوانده و روی سایت بنشینند، و بعد از نشستن، راستی‌آزمایی دوم روی همان تورها انجام شود.',
      outcome: 'هر سه قیمت نشست و راستی شد؛ خطای تازگی تورسنج روی هر دو تور رفع شد. صفحهٔ تورها حالا همان قیمتی را نشان می‌دهد که در دیتابیس است.',
      actions: 'تیم analytics کوئری‌های تورسنج را اجرا کرد؛ تیم dev کش قیمت‌ها را تازه کرد؛ تیم qa هر سه تور را دستی باز کرد و قیمت را با دیتابیس مقایسه کرد؛ نتیجه در لاگ چرخه ثبت شد.',
      summary:
        'در کل کار تمیز و سریعی بود و بدون هیچ خطایی در کمتر از سه ساعت بسته شد. فقط یک یادداشت برای چرخه‌های بعد ماند: کوئری‌های تورسنج را دیگر به‌صورت دستی اجرا نکنیم و یک ران خودکار شبانه برایشان بگذاریم تا این اختلاف قیمت اصلاً پیش نیاید.',
    },
  },
  {
    id: 'mock-cycle-3',
    run_id: 'TG-0721-01',
    status: 'success',
    started_at: '2026-10-13T14:00:00+03:30',
    finished_at: '2026-10-13T17:46:00+03:30',
    stats: { commits: 24, tasks: 35, teams: 15 },
    teams: ALL_TEAMS,
    report: {
      goal: 'هدف این چرخه، ممیزی سئوی ده صفحهٔ پربازدید سایت و بستن ایرادهای فنی قبل از ایندکس بعدی گوگل بود.',
      problem: 'در ممیزی قبلی، چهار صفحه متا دیسکریپشن نداشتند، دو صفحه سرعت لودشان بالای چهار ثانیه بود و یک صفحه لینک شکسته داشت. اگر این‌ها می‌ماندند، در ایندکس بعدی رتبه می‌افتاد.',
      plan: 'قرار بود تیم سئو هر ده صفحه را صفحه‌به‌صفحه ممیزی کند، ایرادها را اولویت‌بندی کند، تیم dev ایرادهای فنی را ببندد و تیم محتوا متاها را بنویسد؛ در پایان یک گزارش RAG برای هر صفحه صادر شود.',
      outcome: 'هر ده صفحه ممیزی شدند؛ هر شش ایراد فنی بسته شد؛ متاهای گمشده نوشته و اعمال شدند؛ سرعت هر دو صفحهٔ کند به زیر دو ثانیه رسید. گزارش RAG هر ده صفحه سبز شد.',
      actions: 'تیم seo ممیزی و اولویت‌بندی را انجام داد؛ تیم dev ایرادهای فنی و سرعت را بست؛ تیم content متاها را نوشت؛ تیم qa همه را راستی‌آزمایی کرد؛ بازرس گزارش نهایی را امضا کرد.',
      summary:
        'در کل یکی از تمیزترین چرخه‌های هفته بود: همهٔ ایرادها در همان چرخه بسته شدند و هیچ‌کدام به چرخهٔ بعد منتقل نشد. پیشنهاد تیم سئو برای چرخهٔ بعد: همین ممیزی را روی ده صفحهٔ بعدی پربازدید تکرار کنیم تا کل سایت تا آخر ماه سبز شود.',
    },
  },
];

/* ------------------------------------------------------------------ */
/* واکشی چرخه‌ها از API با بازگشت به دادهٔ نمایشی                    */
/* ------------------------------------------------------------------ */

async function fetchCycles(): Promise<{ cycles: CycleReport[]; isMock: boolean }> {
  try {
    const res = await fetch('/api/cycles', { cache: 'no-store' });
    if (!res.ok) throw new Error('bad status');
    const body = await res.json().catch(() => null);
    const list: Cycle[] | undefined = body?.ok ? body.data : Array.isArray(body) ? body : undefined;
    if (!Array.isArray(list) || list.length === 0) throw new Error('empty');
    // فعلاً API گزارش پنج‌محوری ندارد؛ محورها خالی می‌مانند تا API تکمیل شود.
    const mapped: CycleReport[] = list
      .filter((c) => c.status === 'success')
      .map((c) => ({
        ...c,
        teams: ALL_TEAMS,
        report: { goal: '', problem: '', plan: '', outcome: '', actions: '', summary: '' },
      }));
    if (mapped.length === 0) throw new Error('no success');
    return { cycles: mapped, isMock: false };
  } catch {
    return { cycles: MOCK_REPORTS, isMock: true };
  }
}

/* ------------------------------------------------------------------ */
/* صفحه                                                                 */
/* ------------------------------------------------------------------ */

export default function ReportsPage() {
  const [reports, setReports] = useState<CycleReport[]>([]);
  const [isMock, setIsMock] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchCycles().then(({ cycles, isMock: mock }) => {
      if (!alive) return;
      const sorted = [...cycles].sort(
        (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
      );
      setReports(sorted);
      setIsMock(mock);
      setSelectedId((prev) => prev ?? sorted[0]?.id ?? null);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  const selected = useMemo(
    () => reports.find((r) => r.id === selectedId) ?? null,
    [reports, selectedId],
  );

  const reportEmpty = selected && AXIS_TITLES.every((a) => !selected.report[a.key].trim());

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 md:px-8">
      {/* سربرگ صفحه */}
      <header className="mb-8">
        <h1 className="text-2xl font-bold md:text-3xl">گزارش چرخه‌ها</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          گزارش پنج‌محوری چرخه‌های موفق تیم‌های هوش مصنوعی تایلندگرد. برای خواندن گزارش، یک چرخه را
          از فهرست انتخاب کنید.
        </p>
        {isMock && !loading && (
          <p className="mt-3 inline-block rounded-md bg-secondary px-3 py-1 text-xs text-secondary-foreground">
            دادهٔ نمایشی: مسیر GET /api/cycles هنوز ساخته نشده، پس فهرست نمونه نمایش داده می‌شود.
          </p>
        )}
      </header>

      {loading ? (
        <LoadingState />
      ) : reports.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
          {/* فهرست چرخه‌ها */}
          <aside aria-label="فهرست چرخه‌ها">
            <ul className="flex flex-col gap-3">
              {reports.map((r) => {
                const active = r.id === selectedId;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(r.id)}
                      aria-current={active ? 'true' : undefined}
                      className={`w-full rounded-lg border p-4 text-start transition-colors ${
                        active
                          ? 'border-brand bg-card shadow-surface'
                          : 'border-border bg-card hover:border-muted-foreground'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold">چرخهٔ {r.run_id}</span>
                        <span className="rounded-full bg-success/15 px-2.5 py-0.5 text-xs font-bold text-success">
                          موفق
                        </span>
                      </div>
                      <dl className="mt-3 space-y-1.5 text-sm text-muted-foreground">
                        <div className="flex justify-between gap-2">
                          <dt>تاریخ</dt>
                          <dd className="text-foreground">{jalaliDate(r.started_at)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt>مدت</dt>
                          <dd className="text-foreground">{durationFa(r)}</dd>
                        </div>
                        {typeof r.stats?.commits === 'number' && (
                          <div className="flex justify-between gap-2">
                            <dt>کامیت‌ها</dt>
                            <dd className="text-foreground">{faDigits(r.stats.commits)}</dd>
                          </div>
                        )}
                      </dl>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          {/* گزارش پنج‌محوری */}
          {selected && (
            <article
              key={selected.id}
              className="rounded-xl border border-border bg-card p-6 shadow-surface md:p-8"
              aria-label={`گزارش چرخهٔ ${selected.run_id}`}
            >
              {/* سربرگ گزارش: تیم، تاریخ شمسی، ساعت تهران */}
              <header className="border-b border-border pb-6">
                <h2 className="text-xl font-bold md:text-2xl">گزارش چرخهٔ {selected.run_id}</h2>
                <div className="mt-4 grid gap-4 sm:grid-cols-3">
                  <div>
                    <p className="text-xs text-muted-foreground">تیم‌ها</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {selected.teams.map((t) => (
                        <span
                          key={t}
                          className="rounded-full bg-secondary px-2.5 py-0.5 text-xs text-secondary-foreground"
                        >
                          {TEAM_LABELS[t]}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">تاریخ شمسی</p>
                    <p className="mt-1 font-bold">{jalaliDate(selected.started_at)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">ساعت تهران</p>
                    <p className="mt-1 font-bold" dir="rtl">
                      {tehranTime(selected.started_at)} تا {selected.finished_at ? tehranTime(selected.finished_at) : 'در حال اجرا'}
                    </p>
                  </div>
                </div>
              </header>

              {reportEmpty ? (
                <p className="mt-6 rounded-lg bg-muted p-4 text-sm text-muted-foreground">
                  گزارش پنج‌محوری این چرخه هنوز ثبت نشده است.
                </p>
              ) : (
                <>
                  {/* پنج محور */}
                  <ol className="mt-6 space-y-5">
                    {AXIS_TITLES.map((axis, i) => (
                      <li
                        key={axis.key}
                        className="rounded-lg border border-border bg-background p-5"
                      >
                        <div className="flex items-center gap-3">
                          <span
                            aria-hidden="true"
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand text-base font-bold text-brand-foreground"
                          >
                            {faDigits(i + 1)}
                          </span>
                          <h3 className="text-lg font-bold">{axis.title}</h3>
                        </div>
                        <p className="mt-3 leading-8 text-foreground">{selected.report[axis.key]}</p>
                      </li>
                    ))}
                  </ol>

                  {/* پاراگراف جمع‌بندی */}
                  <section
                    aria-label="در کل چی شد"
                    className="mt-6 rounded-lg border border-brand/40 bg-brand/5 p-5"
                  >
                    <h3 className="text-lg font-bold text-brand">در کل چی شد؟</h3>
                    <p className="mt-3 leading-8 text-foreground">{selected.report.summary}</p>
                  </section>
                </>
              )}
            </article>
          )}
        </div>
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* حالت‌های بارگذاری و خالی                                            */
/* ------------------------------------------------------------------ */

function LoadingState() {
  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]" aria-busy="true">
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
      <div className="h-96 animate-pulse rounded-xl bg-muted" />
      <span className="sr-only">در حال بارگذاری گزارش‌ها…</span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-border bg-card p-10 text-center">
      <p className="text-lg font-bold">هنوز چرخهٔ موفقی ثبت نشده است</p>
      <p className="mt-2 text-sm text-muted-foreground">
        وقتی اولین چرخه با موفقیت تمام شود، گزارش پنج‌محوری آن همین‌جا نمایش داده می‌شود.
      </p>
    </div>
  );
}
