'use client';

import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import NotConnected from '@/components/NotConnected';
import PageHeader from '@/components/PageHeader';
import TeamCard from '@/components/TeamCard';
import { SkeletonTeamCard } from '@/components/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { faNum } from '@/lib/format';
import {
  TEAMS,
  WAVES,
  type TeamName,
  type TeamRun,
  type TeamRunStatus,
} from '@/lib/types';
import { TEAM_META, WAVE_TITLES } from '@/lib/team-meta';

const STATUS_ORDER: TeamRunStatus[] = ['success', 'running', 'failed', 'pending', 'skipped'];

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
  /* قانون مسعود: دادهٔ نمایشی ممنوع. لیست خالی یعنی «هنوز رانی ثبت نشده»؛
     همان را صادقانه نشان می‌دهیم، نه عددهای ساختگی. */
  return list.filter(isTeamRun);
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
  stopped: 'متوقف شد',
};

export default function TeamsPage() {
  const [runs, setRuns] = useState<TeamRun[] | null>(null);
  /* قانون مسعود: اگر API در دسترس نباشد، صادقانه «متصل نیست»؛ نه دادهٔ نمایشی. */
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    (async () => {
      const fromStatus = await tryFetch('/api/teams/status');
      if (!alive) return;
      if (fromStatus !== null) {
        setRuns(fromStatus);
        return;
      }
      const fromCycle = await tryFetch('/api/cycles/latest');
      if (!alive) return;
      if (fromCycle !== null) {
        setRuns(fromCycle);
        return;
      }
      setRuns([]);
      setFailed(true);
    })();
    return () => {
      alive = false;
    };
  }, [attempt]);

  const byTeam = new Map<TeamName, TeamRun>((runs ?? []).map((r) => [r.team, r]));

  const counts = STATUS_ORDER.map((s) => ({
    status: s,
    count: (runs ?? []).filter((r) => r.status === s).length,
  }));
  const totalCalls = (runs ?? []).reduce((sum, r) => sum + (r.llm_calls ?? 0), 0);

  return (
    <div className="mx-auto max-w-7xl">
        <PageHeader
          icon={Users}
          title="تیم‌های ایجنتیک"
          subtitle={`وضعیت آخرین اجرای ${faNum(15)} تیم در ${faNum(6)} موج`}
        />

        {runs === null ? (
          <div className="tg-stagger grid gap-4 sm:grid-cols-2 md:gap-5 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonTeamCard key={i} />
            ))}
          </div>
        ) : failed ? (
          <NotConnected
            onRetry={() => {
              setRuns(null);
              setAttempt((n) => n + 1);
            }}
            retrying={false}
          />
        ) : (
          <>
            <section className="mb-8 flex flex-wrap items-center gap-2 md:gap-3" aria-label="جمع‌بندی وضعیت تیم‌ها">
              {counts.map(({ status, count }) => (
                <Badge key={status} variant="secondary">
                  {SUMMARY_LABEL[status]}: <strong>{faNum(count)}</strong>
                </Badge>
              ))}
              <Badge variant="secondary">
                مجموع فراخوانی LLM: <strong>{faNum(totalCalls.toLocaleString('en-US'))}</strong>
              </Badge>
            </section>

            {WAVES.map(({ wave, teams }) => (
              <section key={wave} className="mb-10 last:mb-0">
                <div className="mb-4 flex items-center gap-3">
                  <Badge variant="brand">
                    {WAVE_TITLES[wave] ?? `موج ${faNum(wave)}`}
                  </Badge>
                  <span className="h-px flex-1 bg-border" />
                </div>
                <div className="tg-stagger grid gap-4 sm:grid-cols-2 md:gap-5 lg:grid-cols-3">
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
                        detailHref={`/dashboard/teams/${team}`}
                      />
                    );
                  })}
                </div>
              </section>
            ))}
          </>
        )}
    </div>
  );
}
