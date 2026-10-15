'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  GraduationCap,
  RefreshCw,
  TriangleAlert,
  Trophy,
  WifiOff,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import EmptyState from '@/components/EmptyState';
import { SkeletonPanel } from '@/components/Skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { KnowledgeReport } from '@/app/api/knowledge/report/route';

const faNum = (n: number): string =>
  new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 }).format(n);

type BadgeKind = 'success' | 'warning' | 'destructive' | 'secondary';

function scoreBadge(score: number): { kind: BadgeKind; label: string } {
  if (score >= 70) return { kind: 'success', label: 'خوب' };
  if (score >= 40) return { kind: 'warning', label: 'نیاز به توجه' };
  return { kind: 'destructive', label: 'بحرانی' };
}

function ScoreBar({ score, label }: { score: number; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={score}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className="h-full rounded-full bg-brand transition-all duration-500"
          style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
        />
      </div>
      <span className="shrink-0 text-sm font-bold tabular-nums text-foreground">
        {faNum(score)}
      </span>
    </div>
  );
}

function Suggestions({ items }: { items: string[] }) {
  return (
    <ol className="mt-3 space-y-2">
      {items.map((s, i) => (
        <li key={i} className="flex items-start gap-2 text-sm leading-7 text-muted-foreground">
          <span
            aria-hidden="true"
            className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand"
          />
          <span>
            <span className="font-bold text-foreground">{faNum(i + 1)}. </span>
            {s}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * صفحه گزارش مربی: ارزیابی دوره‌ای کیفیت دانش تیم‌ها.
 *
 * قرارداد با تیم ۵: وقتی app/dashboard/knowledge/page.tsx (نمای کلی دانش)
 * ساخته شد، لینک «گزارش مربی» به /dashboard/knowledge/report را آن‌جا بگذار.
 * لینک برگشت «نمای کلی دانش» این‌جا از قبل آماده است.
 */
export default function KnowledgeReportPage() {
  const [report, setReport] = useState<KnowledgeReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/knowledge/report', { cache: 'no-store' });
      const json = (await res.json()) as
        | { ok: true; data: KnowledgeReport }
        | { ok: false; error?: { message?: string } };
      if (!res.ok || !json.ok) {
        throw new Error(
          (!json.ok && json.error?.message) || 'خواندن گزارش ممکن نشد.',
        );
      }
      setReport(json.data);
    } catch (e) {
      setReport(null);
      setError(e instanceof Error ? e.message : 'خطای ناشناخته.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const backLink = (
    <Link
      href="/dashboard/knowledge"
      className="inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-border bg-card px-5 text-sm font-semibold text-foreground hover:bg-accent"
    >
      <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
      نمای کلی دانش
    </Link>
  );

  return (
    <div>
      <PageHeader
        icon={GraduationCap}
        title="گزارش مربی"
        subtitle="ارزیابی دوره‌ای کیفیت دانش هر تیم، با سه پیشنهاد عملی برای قوی‌تر شدنش"
        actions={backLink}
      />

      {loading && <SkeletonPanel />}

      {!loading && error && (
        <EmptyState
          icon={WifiOff}
          title="گزارش بارگذاری نشد"
          description={error}
          action={
            <Button variant="outline" onClick={load}>
              <RefreshCw size={16} strokeWidth={2} aria-hidden="true" />
              تلاش دوباره
            </Button>
          }
        />
      )}

      {!loading && !error && report && (
        <div className="space-y-6">
          {/* خلاصه کلی */}
          <Card>
            <CardHeader>
              <CardTitle>خلاصه مربی</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-muted-foreground">
                  میانگین کیفیت دانش تیم‌ها
                </span>
                <span className="text-2xl font-bold tabular-nums text-foreground">
                  {faNum(report.summary.averageScore)}
                  <span className="text-sm font-medium text-muted-foreground"> از ۱۰۰</span>
                </span>
              </div>
              <div className="mt-3">
                <ScoreBar
                  score={report.summary.averageScore}
                  label="میانگین کیفیت دانش تیم‌ها"
                />
              </div>
              <p className="mt-4 text-sm leading-7 text-muted-foreground">
                {report.summary.message}
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {report.summary.weakestTeam && (
                  <div className="rounded-lg border border-border bg-background p-4">
                    <div className="flex items-center gap-2">
                      <TriangleAlert
                        size={16}
                        strokeWidth={2}
                        className="shrink-0 text-destructive"
                        aria-hidden="true"
                      />
                      <span className="text-sm font-bold text-foreground">
                        ضعیف‌ترین حلقه: {report.summary.weakestTeam.faName}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-7 text-muted-foreground">
                      {report.summary.weakestTeam.message}
                    </p>
                  </div>
                )}
                {report.summary.strongestTeam && (
                  <div className="rounded-lg border border-border bg-background p-4">
                    <div className="flex items-center gap-2">
                      <Trophy
                        size={16}
                        strokeWidth={2}
                        className="shrink-0 text-brand"
                        aria-hidden="true"
                      />
                      <span className="text-sm font-bold text-foreground">
                        قوی‌ترین حلقه: {report.summary.strongestTeam.faName}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-7 text-muted-foreground">
                      {report.summary.strongestTeam.message}
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* جدول دسکتاپ */}
          <div className="hidden lg:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40 font-bold text-foreground">تیم</TableHead>
                  <TableHead className="w-64 font-bold text-foreground">امتیاز</TableHead>
                  <TableHead className="font-bold text-foreground">
                    سه پیشنهاد مربی
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.teams.map((t) => {
                  const badge = scoreBadge(t.score);
                  return (
                    <TableRow key={t.team} className="align-top">
                      <TableCell>
                        <div className="font-bold text-foreground">{t.faName}</div>
                        <div className="mt-1">
                          {t.hasData ? (
                            <Badge variant={badge.kind}>{badge.label}</Badge>
                          ) : (
                            <Badge variant="secondary">خوانده نشد</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <ScoreBar score={t.score} label={`امتیاز دانش تیم ${t.faName}`} />
                      </TableCell>
                      <TableCell>
                        <Suggestions items={t.topSuggestions} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* کارت‌های موبایل و تبلت */}
          <div className="grid gap-4 lg:hidden">
            {report.teams.map((t) => {
              const badge = scoreBadge(t.score);
              return (
                <Card key={t.team}>
                  <CardHeader>
                    <div className="flex items-center justify-between gap-3">
                      <CardTitle>{t.faName}</CardTitle>
                      {t.hasData ? (
                        <Badge variant={badge.kind}>{badge.label}</Badge>
                      ) : (
                        <Badge variant="secondary">خوانده نشد</Badge>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <ScoreBar score={t.score} label={`امتیاز دانش تیم ${t.faName}`} />
                    <h3 className="mt-4 text-sm font-bold text-foreground">
                      سه پیشنهاد مربی
                    </h3>
                    <Suggestions items={t.topSuggestions} />
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
