'use client';

import { useEffect, useState } from 'react';
import { TriangleAlert, Users } from 'lucide-react';
import PageHeader from '../../../components/PageHeader';
import TeamCard, { faNum } from '../../../components/TeamCard';
import { SkeletonTeamCard } from '../../../components/Skeleton';
import {
  TEAMS,
  WAVES,
  type TeamName,
  type TeamRun,
  type TeamRunStatus,
} from '../../../lib/types';

const TEAM_META: Record<TeamName, { faName: string; mission: string }> = {
  artdir: { faName: 'طراحی ارشد', mission: 'نگاه کلی و هدایت هنری کل پروژه' },
  branding: { faName: 'برند', mission: 'هویت برند، لحن و شخصیت تایلندگرد' },
  content: { faName: 'محتوا', mission: 'متن‌ها و پیام‌های اصلی صفحه‌ها' },
  seo: { faName: 'سئو', mission: 'بهینه‌سازی فنی و ساختار برای گوگل' },
  analytics: { faName: 'تحلیل', mission: 'داده‌ها، معیارها و سنجش عملکرد' },
  intel: { faName: 'اطلاعات', mission: 'رصد بازار، رقبا و روندها' },
  lead: { faName: 'لید', mission: 'ایده‌های تبدیل بازدیدکننده به درخواست' },
  design: { faName: 'دیزاین', mission: 'چیدمان، ظاهر و تجربه صفحه‌ها' },
  seocontent: { faName: 'محتوای سئو', mission: 'محتوای هدفمند برای رتبه گوگل' },
  vibefarsi: { faName: 'وایب‌فارسی', mission: 'کامپوننت‌های فارسی استاندارد' },
  farsiui: { faName: 'فارسی UI', mission: 'راست‌چین و جزئیات رابط فارسی' },
  'design-ir': { faName: 'دیزاین ایرانی', mission: 'بومی‌سازی طرح برای سلیقه ایرانی' },
  dev: { faName: 'توسعه', mission: 'پیاده‌سازی فنی و کد تمیز' },
  qa: { faName: 'کیفیت', mission: 'آزمون، کنترل کیفیت و رفع ایراد' },
  inspector: { faName: 'بازرس', mission: 'بازبینی نهایی و گزارش سلامت چرخه' },
};

const WAVE_TITLES: Record<number, string> = {
  1: 'موج ۱',
  2: 'موج ۲',
  3: 'موج ۳',
  4: 'موج ۴',
  5: 'موج ۵',
  6: 'موج ۶',
};

const STATUS_ORDER: TeamRunStatus[] = ['success', 'running', 'failed', 'pending', 'skipped'];

/** داده نمایشی؛ وقتی هیچ API در دسترسی نباشد. */
const MOCK_RUNS: TeamRun[] = [
  { id: 'm-01', cycle_id: 'mock', team: 'artdir', wave: 1, status: 'success', started_at: null, finished_at: null, output_summary: 'زبان طراحی نهایی شد و سه مسیر بصری برای صفحه خانه تأیید شد.', llm_calls: 42, error: null },
  { id: 'm-02', cycle_id: 'mock', team: 'branding', wave: 1, status: 'success', started_at: null, finished_at: null, output_summary: 'پالت و لحن برند به‌روزرسانی شد؛ راهنمای یک‌صفحه‌ای تحویل تیم‌ها شد.', llm_calls: 31, error: null },
  { id: 'm-03', cycle_id: 'mock', team: 'content', wave: 1, status: 'running', started_at: null, finished_at: null, output_summary: 'در حال نگارش نسخه دوم تیترهای صفحه تورها.', llm_calls: 57, error: null },
  { id: 'm-04', cycle_id: 'mock', team: 'analytics', wave: 2, status: 'success', started_at: null, finished_at: null, output_summary: 'داشبورد نرخ تبدیل هفتگی ساخته شد؛ افت ۱۲ درصدی صفحه پرداخت شناسایی شد.', llm_calls: 28, error: null },
  { id: 'm-05', cycle_id: 'mock', team: 'intel', wave: 2, status: 'success', started_at: null, finished_at: null, output_summary: 'گزارش رقبای تایلند: سه رقیب قیمت را ۸ تا ۱۵ درصد پایین آوردند.', llm_calls: 35, error: null },
  { id: 'm-06', cycle_id: 'mock', team: 'lead', wave: 2, status: 'pending', started_at: null, finished_at: null, output_summary: null, llm_calls: 0, error: null },
  { id: 'm-07', cycle_id: 'mock', team: 'design', wave: 3, status: 'running', started_at: null, finished_at: null, output_summary: 'در حال بازطراحی بخش هیروی صفحه تورها با کامپوننت‌های وایب‌فارسی.', llm_calls: 64, error: null },
  { id: 'm-08', cycle_id: 'mock', team: 'seo', wave: 3, status: 'success', started_at: null, finished_at: null, output_summary: 'متای ۴۰ صفحه بازنویسی شد؛ نقشه سایت جدید ثبت سرچ کنسول شد.', llm_calls: 49, error: null },
  { id: 'm-09', cycle_id: 'mock', team: 'seocontent', wave: 3, status: 'pending', started_at: null, finished_at: null, output_summary: null, llm_calls: 0, error: null },
  { id: 'm-10', cycle_id: 'mock', team: 'design-ir', wave: 4, status: 'success', started_at: null, finished_at: null, output_summary: 'الگوهای بصری ایرانی برای بنرهای مناسبتی آماده شد.', llm_calls: 26, error: null },
  { id: 'm-11', cycle_id: 'mock', team: 'dev', wave: 4, status: 'failed', started_at: null, finished_at: null, output_summary: 'دیپلوی نیمه‌کاره ماند.', llm_calls: 73, error: 'خطای بیلد در ماژول فرم رزرو؛ نیاز به بازبینی تایپ‌ها.' },
  { id: 'm-12', cycle_id: 'mock', team: 'farsiui', wave: 4, status: 'pending', started_at: null, finished_at: null, output_summary: null, llm_calls: 0, error: null },
  { id: 'm-13', cycle_id: 'mock', team: 'vibefarsi', wave: 5, status: 'success', started_at: null, finished_at: null, output_summary: 'دو کامپوننت جدید کارت تور و فیلتر تاریخ به رجیستری اضافه شد.', llm_calls: 38, error: null },
  { id: 'm-14', cycle_id: 'mock', team: 'qa', wave: 5, status: 'pending', started_at: null, finished_at: null, output_summary: null, llm_calls: 0, error: null },
  { id: 'm-15', cycle_id: 'mock', team: 'inspector', wave: 6, status: 'pending', started_at: null, finished_at: null, output_summary: null, llm_calls: 0, error: null },
];

function isTeamRun(value: unknown): value is TeamRun {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.team === 'string' &&
    (TEAMS as string[]).includes(v.team) &&
    typeof v.status === 'string' &&
    typeof v.llm_calls === 'number'
  );
}

function normalizeRuns(payload: unknown): TeamRun[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = (payload as { data?: unknown }).data;
  const list = Array.isArray(data) ? data : (data as { teams?: unknown })?.teams;
  if (!Array.isArray(list)) return null;
  const runs = list.filter(isTeamRun);
  return runs.length > 0 ? runs : null;
}

async function tryFetch(url: string): Promise<TeamRun[] | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    if (!json || (json as { ok?: boolean }).ok === false) return null;
    return normalizeRuns(json);
  } catch {
    return null;
  }
}

const SUMMARY_LABEL: Record<TeamRunStatus, string> = {
  success: 'موفق',
  running: 'در حال اجرا',
  failed: 'ناموفق',
  pending: 'در انتظار',
  skipped: 'صرف‌نظر شده',
};

export default function TeamsPage() {
  const [runs, setRuns] = useState<TeamRun[] | null>(null);
  const [usingMock, setUsingMock] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const fromStatus = await tryFetch('/api/teams/status');
      if (!alive) return;
      if (fromStatus) {
        setRuns(fromStatus);
        return;
      }
      const fromCycle = await tryFetch('/api/cycles/latest');
      if (!alive) return;
      if (fromCycle) {
        setRuns(fromCycle);
        return;
      }
      setRuns(MOCK_RUNS);
      setUsingMock(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const byTeam = new Map<TeamName, TeamRun>((runs ?? []).map((r) => [r.team, r]));

  const counts = STATUS_ORDER.map((s) => ({
    status: s,
    count: (runs ?? []).filter((r) => r.status === s).length,
  }));
  const totalCalls = (runs ?? []).reduce((sum, r) => sum + (r.llm_calls ?? 0), 0);

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 md:py-8">
        <PageHeader
          icon={Users}
          title="تیم‌های ایجنتیک"
          subtitle={`وضعیت آخرین اجرای ${faNum(15)} تیم در ${faNum(6)} موج`}
          actions={
            usingMock ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs font-medium text-warning">
                <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
                داده نمایشی؛ API در دسترسی نیست
              </span>
            ) : undefined
          }
        />

        {runs === null ? (
          <div className="tg-stagger grid gap-3 sm:grid-cols-2 md:gap-4 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonTeamCard key={i} />
            ))}
          </div>
        ) : (
          <>
            <section className="mb-6 flex flex-wrap items-center gap-2 md:mb-8 md:gap-3">
              {counts.map(({ status, count }) => (
                <span
                  key={status}
                  className="rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground"
                >
                  {SUMMARY_LABEL[status]}: <strong className="text-card-foreground">{faNum(count)}</strong>
                </span>
              ))}
              <span className="rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
                مجموع فراخوانی LLM: <strong className="text-card-foreground">{faNum(totalCalls.toLocaleString('en-US'))}</strong>
              </span>
            </section>

            {WAVES.map(({ wave, teams }) => (
              <section key={wave} className="mb-10">
                <div className="mb-4 flex items-center gap-3">
                  <span className="rounded-lg bg-brand/10 px-3 py-1 text-sm font-bold text-brand">
                    {WAVE_TITLES[wave] ?? `موج ${faNum(wave)}`}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
                <div className="tg-stagger grid gap-3 sm:grid-cols-2 md:gap-4 lg:grid-cols-3">
                  {teams.map((team) => {
                    const meta = TEAM_META[team];
                    const run = byTeam.get(team);
                    return (
                      <TeamCard
                        key={team}
                        team={team}
                        faName={meta.faName}
                        mission={meta.mission}
                        status={run?.status ?? 'pending'}
                        outputSummary={run?.output_summary ?? null}
                        llmCalls={run?.llm_calls ?? 0}
                        error={run?.error ?? null}
                      />
                    );
                  })}
                </div>
              </section>
            ))}
          </>
        )}
      </div>
    </main>
  );
}
