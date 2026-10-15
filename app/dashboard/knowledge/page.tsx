'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  BookOpen,
  ChevronLeft,
  Clock,
  FileText,
  FolderOpen,
  GraduationCap,
  Star,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import EmptyState from '@/components/EmptyState';
import NotConnected from '@/components/NotConnected';
import { Skeleton } from '@/components/Skeleton';
import { faNum } from '@/lib/format';
import { formatJalali } from '@/lib/jalali';
import { TEAMS, type TeamName } from '@/lib/types';
import { TEAM_META } from '@/lib/team-meta';

/** آمار یک تیم از GET /api/knowledge (قرارداد: teams: [{ team, faName, count, categoryCount, lastUpdated, score }]) */
interface TeamStats {
  team: string;
  count?: number;
  categoryCount?: number;
  lastUpdated?: string | null;
  score?: number | null;
}

function isTeamStats(value: unknown): value is TeamStats {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.team === 'string' &&
    (TEAMS as string[]).includes(v.team) &&
    (v.count === undefined || typeof v.count === 'number') &&
    (v.categoryCount === undefined || typeof v.categoryCount === 'number') &&
    (v.lastUpdated === undefined || v.lastUpdated === null || typeof v.lastUpdated === 'string') &&
    (v.score === undefined || v.score === null || typeof v.score === 'number')
  );
}

function normalize(payload: unknown): Map<TeamName, TeamStats> | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = (payload as { data?: unknown }).data;
  const list = (data as { teams?: unknown } | undefined)?.teams;
  if (!Array.isArray(list)) return null;
  const map = new Map<TeamName, TeamStats>();
  for (const item of list) {
    if (isTeamStats(item)) map.set(item.team as TeamName, item);
  }
  return map;
}

async function tryFetch(): Promise<Map<TeamName, TeamStats> | null> {
  try {
    const res = await fetch('/api/knowledge', { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    if (!json || (json as { ok?: boolean }).ok === false) return null;
    return normalize(json);
  } catch {
    return null;
  }
}

/** تاریخ شمسی آخرین به‌روزرسانی؛ رشتهٔ نامعتبر یا خالی → «-» */
function jalaliDate(value: string | null | undefined): string {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return formatJalali(d);
}

function TeamCard({ team, stats }: { team: TeamName; stats?: TeamStats }) {
  const meta = TEAM_META[team];
  const count = stats?.count ?? 0;
  const categoryCount = stats?.categoryCount ?? 0;
  const score = stats?.score;

  return (
    <Link
      href={`/dashboard/knowledge/${team}`}
      aria-label={`دانش تیم ${meta.faName}`}
      className="group flex flex-col rounded-xl border border-border bg-card p-5 shadow-surface transition-colors duration-200 hover:border-brand/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold leading-7 text-foreground">
            {meta.faName}
          </h2>
          <p className="mt-1 line-clamp-2 text-sm leading-7 text-muted-foreground">
            {meta.mission}
          </p>
        </div>
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand transition-transform duration-200 group-hover:scale-105 motion-reduce:transition-none"
        >
          <BookOpen size={20} strokeWidth={1.75} />
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-2 rounded-lg bg-muted/60 p-3">
        <div>
          <dt className="flex items-center gap-1 text-xs leading-5 text-muted-foreground">
            <FileText size={13} aria-hidden="true" />
            دانش
          </dt>
          <dd className="mt-1 text-lg font-bold leading-7 tabular-nums text-foreground">
            {faNum(count)}
          </dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-xs leading-5 text-muted-foreground">
            <FolderOpen size={13} aria-hidden="true" />
            دسته
          </dt>
          <dd className="mt-1 text-lg font-bold leading-7 tabular-nums text-foreground">
            {faNum(categoryCount)}
          </dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-xs leading-5 text-muted-foreground">
            <Star size={13} aria-hidden="true" />
            امتیاز
          </dt>
          <dd className="mt-1 text-lg font-bold leading-7 tabular-nums text-foreground">
            {score === null || score === undefined ? '-' : faNum(score)}
          </dd>
        </div>
      </dl>

      <div className="mt-4 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs leading-5 text-muted-foreground">
          <Clock size={14} aria-hidden="true" className="shrink-0" />
          <span className="truncate">
            آخرین به‌روزرسانی: {jalaliDate(stats?.lastUpdated)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-0.5 text-sm font-medium text-brand">
          مشاهده
          <ChevronLeft
            size={16}
            aria-hidden="true"
            className="transition-transform duration-200 group-hover:-translate-x-0.5 motion-reduce:transition-none"
          />
        </span>
      </div>
    </Link>
  );
}

function CardSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="flex flex-col rounded-xl border border-border bg-card p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-5 w-24 rounded" />
          <Skeleton className="h-4 w-full rounded" />
        </div>
        <Skeleton className="h-10 w-10 shrink-0 rounded-xl" />
      </div>
      <Skeleton className="mt-4 h-16 w-full rounded-lg" />
      <div className="mt-4 flex items-center justify-between">
        <Skeleton className="h-4 w-32 rounded" />
        <Skeleton className="h-4 w-16 rounded" />
      </div>
    </div>
  );
}

export default function KnowledgeOverviewPage() {
  const [stats, setStats] = useState<Map<TeamName, TeamStats> | null>(null);
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    tryFetch().then((map) => {
      if (!alive) return;
      setRetrying(false);
      if (map === null) setFailed(true);
      else setStats(map);
    });
    return () => {
      alive = false;
    };
  }, [attempt]);

  const retry = () => {
    setRetrying(true);
    setAttempt((a) => a + 1);
  };

  const totalCount = stats
    ? TEAMS.reduce((sum, t) => sum + (stats.get(t)?.count ?? 0), 0)
    : null;

  return (
    <div>
      <PageHeader
        icon={BookOpen}
        title="دانش تیم‌ها"
        subtitle="دانش ثبت‌شدهٔ ۱۵ تیم در یک نگاه؛ برای دیدن جزئیات هر تیم روی کارتش بزنید."
        actions={
          /* لینک گزارش مربی (تیم ۱۵): ارزیابی دوره‌ای کیفیت دانش تیم‌ها */
          <Link
            href="/dashboard/knowledge/report"
            className="inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-border bg-card px-5 text-sm font-semibold text-foreground hover:bg-accent"
          >
            <GraduationCap size={16} strokeWidth={2} aria-hidden="true" />
            گزارش مربی
          </Link>
        }
      />

      {failed ? (
        <NotConnected onRetry={retry} retrying={retrying} />
      ) : stats === null ? (
        <div
          role="status"
          aria-label="در حال بارگذاری دانش تیم‌ها"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : totalCount === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="هنوز دانشی ثبت نشده"
          description="برای هیچ‌کدام از تیم‌ها هنوز دانشی ثبت نشده است؛ با افزودن اولین دانش، این‌جا پر می‌شود."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {TEAMS.map((team) => (
            <TeamCard key={team} team={team} stats={stats.get(team)} />
          ))}
        </div>
      )}
    </div>
  );
}
