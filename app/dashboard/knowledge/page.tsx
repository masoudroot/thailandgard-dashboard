'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import {
  BookOpen,
  ChevronLeft,
  Clock,
  FileText,
  FolderOpen,
  GraduationCap,
  Star,
  Plus,
  Pencil,
  Trash2,
  RefreshCw,
  Zap,
  MoreVertical,
  Rss,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import NotConnected from '@/components/NotConnected';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/Select';
import { SearchInput } from '@/components/ui/search-input';
import { Switch } from '@/components/ui/Switch';
import { Stat } from '@/components/ui/stat';
import { Dialog } from '@/components/ui/dialog';
import { AlertDialog } from '@/components/ui/alert-dialog';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Tooltip } from '@/components/ui/tooltip';
import { Pagination } from '@/components/ui/pagination';
import { DropdownMenu } from '@/components/ui/dropdown-menu';
import { Collapsible } from '@/components/ui/collapsible';
import { ToastProvider, useToast } from '@/components/ui/toast';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { faNum } from '@/lib/format';
import { formatJalali, toJalali } from '@/lib/jalali';
import { TEAMS, type TeamName } from '@/lib/types';
import { TEAM_META } from '@/lib/team-meta';

/* ================= بخش ۱: نمای دانش (محتوای فعلی صفحه) ================= */

/** آمار یک تیم از GET /api/knowledge */
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

function KnowledgeOverview() {
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

  if (failed) {
    return <NotConnected onRetry={retry} retrying={retrying} />;
  }

  if (stats === null) {
    return (
      <div
        role="status"
        aria-label="در حال بارگذاری دانش تیم‌ها"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (totalCount === 0) {
    return (
      <EmptyState
        icon={BookOpen}
        title="هنوز دانشی ثبت نشده"
        description="برای هیچ‌کدام از تیم‌ها هنوز دانشی ثبت نشده است؛ با افزودن اولین دانش، این‌جا پر می‌شود."
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {TEAMS.map((team) => (
        <TeamCard key={team} team={team} stats={stats.get(team)} />
      ))}
    </div>
  );
}

/* ================= بخش ۲: منابع دانش ================= */

/** رکورد منبع (قرارداد docs/knowledge-ui-design.md بخش ۹) */
interface Source {
  id: string;
  name: string;
  url: string;
  team: string;
  type: 'doc' | 'blog' | 'competitor' | 'research';
  authority: 1 | 2 | 3;
  refresh_interval: 'daily' | 'weekly' | 'monthly' | 'manual';
  is_active: boolean;
  last_fetched_at: string | null;
  last_test_ok: boolean | null;
  records_count: number;
  stale?: boolean;
}

const TYPE_LABEL: Record<Source['type'], string> = {
  doc: 'داک رسمی',
  blog: 'بلاگ تخصصی',
  competitor: 'رقیب',
  research: 'پژوهشی',
};

const REFRESH_LABEL: Record<Source['refresh_interval'], string> = {
  daily: 'روزانه',
  weekly: 'هفتگی',
  monthly: 'ماهانه',
  manual: 'دستی',
};

const AUTHORITY_DESC: Record<number, string> = {
  1: 'منبع رسمی؛ بالاترین اعتبار',
  2: 'بلاگ متخصص؛ اعتبار متوسط',
  3: 'سایر منابع؛ اعتبار پایه',
};

const PAGE_SIZE = 20;

/** تاریخ شمسی نسبی («۳ روز پیش») */
function relativeJalali(value: string | null): string {
  if (!value) return 'هرگز';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'امروز';
  if (days === 1) return 'دیروز';
  return `${faNum(days)} روز پیش`;
}

/** تاریخ شمسی کامل برای تول‌تیپ */
function fullJalali(value: string | null): string {
  if (!value) return 'بازخوانی نشده';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  const j = toJalali(d);
  return `${faNum(j.jd)} ${['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'][j.jm - 1]} ${faNum(j.jy)}`;
}

/** URL کوتاه‌شده برای نمایش */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname.length > 1 ? '…' : '');
  } catch {
    return url.length > 40 ? url.slice(0, 40) + '…' : url;
  }
}

async function fetchSources(): Promise<Source[] | null> {
  try {
    const res = await fetch('/api/knowledge/sources', { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    if (!json || json.ok === false) return null;
    const list = (json as { data?: { sources?: unknown } }).data?.sources;
    if (!Array.isArray(list)) return null;
    return list as Source[];
  } catch {
    return null;
  }
}

async function fetchSourceStats(): Promise<{ active: number; records: number; stale: number; avgFreshDays: number } | null> {
  try {
    const res = await fetch('/api/knowledge/sources/stats', { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    if (!json || json.ok === false) return null;
    return (json as { data?: { active: number; records: number; stale: number; avgFreshDays: number } }).data ?? null;
  } catch {
    return null;
  }
}

function SourceStats({ refreshKey }: { refreshKey: number }) {
  const [stats, setStats] = useState<{ active: number; records: number; stale: number; avgFreshDays: number } | null>(null);

  useEffect(() => {
    let alive = true;
    fetchSourceStats().then((s) => {
      if (alive) setStats(s);
    });
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  const cards = [
    { label: 'کل منابع فعال', value: stats ? faNum(stats.active) : '—' },
    { label: 'رکوردهای دانش', value: stats ? faNum(stats.records) : '—' },
    {
      label: 'نیازمند بازخوانی',
      value: stats ? faNum(stats.stale) : '—',
      warn: stats !== null && stats.stale > 0,
    },
    {
      label: 'میانگین تازگی',
      value: stats ? `${faNum(stats.avgFreshDays)} روز` : '—',
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((c) => (
        <div
          key={c.label}
          className={`rounded-xl border border-border bg-card p-4 ${c.warn ? 'border-warning/50' : ''}`}
        >
          <p className="text-xs text-muted-foreground">{c.label}</p>
          <p className={`mt-1 text-xl font-bold tabular-nums sm:text-2xl ${c.warn ? 'text-warning' : 'text-foreground'}`}>
            {c.value}
          </p>
        </div>
      ))}
    </div>
  );
}

interface SourceFormValues {
  name: string;
  url: string;
  team: string;
  type: Source['type'];
  authority: string;
  refresh_interval: Source['refresh_interval'];
  notes: string;
  is_active: boolean;
}

const EMPTY_FORM: SourceFormValues = {
  name: '',
  url: '',
  team: '',
  type: 'blog',
  authority: '2',
  refresh_interval: 'weekly',
  notes: '',
  is_active: true,
};

function SourceDialog({
  open,
  onOpenChange,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: Source | null;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<SourceFormValues>(EMPTY_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof SourceFormValues, string>>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    if (initial) {
      setForm({
        name: initial.name,
        url: initial.url,
        team: initial.team,
        type: initial.type,
        authority: String(initial.authority),
        refresh_interval: initial.refresh_interval,
        notes: '',
        is_active: initial.is_active,
      });
    } else {
      setForm(EMPTY_FORM);
    }
  }, [open, initial]);

  const set = <K extends keyof SourceFormValues>(key: K, value: SourceFormValues[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const validate = (): boolean => {
    const e: Partial<Record<keyof SourceFormValues, string>> = {};
    if (!form.name.trim()) e.name = 'نام منبع را بنویسید.';
    if (!form.url.trim()) {
      e.url = 'نشانی منبع را بنویسید.';
    } else {
      try {
        const u = new URL(form.url.trim());
        if (!['http:', 'https:'].includes(u.protocol)) e.url = 'نشانی باید با http یا https شروع شود.';
      } catch {
        e.url = 'نشانی معتبر نیست؛ دوباره بررسی کنید.';
      }
    }
    if (!form.team) e.team = 'تیم را انتخاب کنید.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const save = async () => {
    if (!validate() || saving) return;
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        url: form.url.trim(),
        team: form.team,
        type: form.type,
        authority: Number(form.authority),
        refresh_interval: form.refresh_interval,
        notes: form.notes.trim() || undefined,
        is_active: form.is_active,
      };
      const res = await fetch(
        initial ? `/api/knowledge/sources/${initial.id}` : '/api/knowledge/sources',
        {
          method: initial ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw new Error('save failed');
      toast({ title: initial ? 'منبع به‌روز شد' : 'منبع ذخیره شد', variant: 'success' });
      onOpenChange(false);
      onSaved();
    } catch {
      toast({ title: 'ذخیره نشد', description: 'مشکلی پیش آمد؛ دوباره تلاش کنید.', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={initial ? 'ویرایش منبع' : 'افزودن منبع'}
      description={initial ? 'مشخصات منبع را به‌روز کنید.' : 'یک منبع آموزشی یا دانشی برای تیم ثبت کنید.'}
      footer={
        <>
          <Button variant="default" disabled={saving} onClick={save}>
            {saving ? 'در حال ذخیره…' : initial ? 'ذخیره تغییرات' : 'ذخیره منبع'}
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            انصراف
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="src-name" className="mb-1.5 block text-sm font-medium">نام منبع</label>
          <Input
            id="src-name"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="مثلاً داک رسمی Next.js"
            error={errors.name}
          />
        </div>
        <div>
          <label htmlFor="src-url" className="mb-1.5 block text-sm font-medium">نشانی</label>
          <Input
            id="src-url"
            dir="ltr"
            value={form.url}
            onChange={(e) => set('url', e.target.value)}
            placeholder="https://…"
            error={errors.url}
            className="text-left"
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="src-team" className="mb-1.5 block text-sm font-medium">تیم</label>
            <Select
              id="src-team"
              value={form.team}
              onChange={(e) => set('team', e.target.value)}
              options={TEAMS.map((t) => ({ value: t, label: TEAM_META[t].faName }))}
              placeholder="انتخاب تیم"
            />
            {errors.team && <p className="mt-1 text-xs text-destructive">{errors.team}</p>}
          </div>
          <div>
            <label htmlFor="src-type" className="mb-1.5 block text-sm font-medium">نوع منبع</label>
            <Select
              id="src-type"
              value={form.type}
              onChange={(e) => set('type', e.target.value as Source['type'])}
              options={[
                { value: 'doc', label: 'داک رسمی' },
                { value: 'blog', label: 'بلاگ تخصصی' },
                { value: 'competitor', label: 'رقیب' },
                { value: 'research', label: 'مقاله پژوهشی' },
              ]}
            />
          </div>
        </div>
        <div>
          <span id="src-authority-label" className="mb-1.5 block text-sm font-medium">درجه اعتبار</span>
          <SegmentedControl
            aria-label="درجه اعتبار"
            value={form.authority}
            onChange={(v) => set('authority', v)}
            options={[
              { value: '1', label: '۱' },
              { value: '2', label: '۲' },
              { value: '3', label: '۳' },
            ]}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">{AUTHORITY_DESC[Number(form.authority)]}</p>
        </div>
        <div>
          <label htmlFor="src-refresh" className="mb-1.5 block text-sm font-medium">تناوب بازخوانی</label>
          <Select
            id="src-refresh"
            value={form.refresh_interval}
            onChange={(e) => set('refresh_interval', e.target.value as Source['refresh_interval'])}
            options={[
              { value: 'daily', label: 'روزانه' },
              { value: 'weekly', label: 'هفتگی' },
              { value: 'monthly', label: 'ماهانه' },
              { value: 'manual', label: 'دستی' },
            ]}
          />
        </div>
        <div>
          <label htmlFor="src-notes" className="mb-1.5 block text-sm font-medium">توضیح <span className="font-normal text-muted-foreground">(اختیاری)</span></label>
          <Textarea
            id="src-notes"
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
            placeholder="چرا این منبع برای تیم مفید است؟"
            rows={2}
          />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
          <span className="text-sm font-medium">فعال</span>
          <Switch checked={form.is_active} onCheckedChange={(v) => set('is_active', v)} aria-label="فعال بودن منبع" />
        </div>
      </div>
    </Dialog>
  );
}

function SourceRowActions({
  source,
  onEdit,
  onDelete,
  onTest,
  onRefresh,
  testing,
  refreshing,
}: {
  source: Source;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  onRefresh: () => void;
  testing: boolean;
  refreshing: boolean;
}) {
  const iconBtn =
    'flex size-9 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <>
      {/* دسکتاپ: دکمه‌های آیکونی */}
      <div className="hidden items-center gap-1 lg:flex">
        <Tooltip content="تست اتصال">
          <button type="button" aria-label="تست اتصال" className={iconBtn} onClick={onTest} disabled={testing || refreshing}>
            {testing ? <RefreshCw size={16} className="animate-spin" /> : <Zap size={16} />}
          </button>
        </Tooltip>
        <Tooltip content="بازخوانی دستی">
          <button type="button" aria-label="بازخوانی دستی" className={iconBtn} onClick={onRefresh} disabled={testing || refreshing}>
            {refreshing ? <RefreshCw size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          </button>
        </Tooltip>
        <Tooltip content="ویرایش">
          <button type="button" aria-label="ویرایش" className={iconBtn} onClick={onEdit} disabled={testing || refreshing}>
            <Pencil size={16} />
          </button>
        </Tooltip>
        <Tooltip content="حذف">
          <button type="button" aria-label="حذف" className={iconBtn} onClick={onDelete} disabled={testing || refreshing}>
            <Trash2 size={16} />
          </button>
        </Tooltip>
      </div>
      {/* موبایل: منوی سه‌نقطه */}
      <div className="lg:hidden">
        <DropdownMenu
          align="end"
          trigger={
            <button type="button" aria-label="عملیات منبع" className={iconBtn}>
              <MoreVertical size={16} />
            </button>
          }
          items={[
            { label: 'تست اتصال', icon: Zap, onSelect: onTest, disabled: testing || refreshing },
            { label: 'بازخوانی دستی', icon: RefreshCw, onSelect: onRefresh, disabled: testing || refreshing },
            { label: 'ویرایش', icon: Pencil, onSelect: onEdit, disabled: testing || refreshing },
            { type: 'separator' },
            { label: 'حذف', icon: Trash2, danger: true, onSelect: onDelete, disabled: testing || refreshing },
          ]}
        />
      </div>
    </>
  );
}

function SourceTable({
  sources,
  onToggle,
  onEdit,
  onDelete,
  onTest,
  onRefresh,
  testingId,
  refreshingId,
}: {
  sources: Source[];
  onToggle: (s: Source) => void;
  onEdit: (s: Source) => void;
  onDelete: (s: Source) => void;
  onTest: (s: Source) => void;
  onRefresh: (s: Source) => void;
  testingId: string | null;
  refreshingId: string | null;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>منبع</TableHead>
          <TableHead>تیم</TableHead>
          <TableHead>نوع</TableHead>
          <TableHead>اعتبار</TableHead>
          <TableHead>آخرین بازخوانی</TableHead>
          <TableHead className="tabular-nums">رکوردها</TableHead>
          <TableHead>وضعیت</TableHead>
          <TableHead><span className="sr-only">عملیات</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sources.map((s) => (
          <TableRow key={s.id} className={s.stale ? 'border-r-2 border-r-warning' : ''}>
            <TableCell>
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-foreground hover:text-brand hover:underline"
              >
                {s.name}
              </a>
              <p dir="ltr" className="mt-0.5 truncate text-xs text-muted-foreground text-right">
                {shortUrl(s.url)}
              </p>
              {s.last_test_ok === false && (
                <Badge variant="warning" className="mt-1">آخرین تست: ناموفق</Badge>
              )}
              {s.last_test_ok === true && (
                <Badge variant="success" className="mt-1">آخرین تست: موفق</Badge>
              )}
            </TableCell>
            <TableCell>
              <Badge>{TEAM_META[s.team as TeamName]?.faName ?? s.team}</Badge>
            </TableCell>
            <TableCell>
              <Badge variant="secondary">{TYPE_LABEL[s.type] ?? s.type}</Badge>
            </TableCell>
            <TableCell>
              <Badge variant={s.authority === 1 ? 'brand' : 'secondary'}>
                درجه {faNum(s.authority)}
              </Badge>
            </TableCell>
            <TableCell>
              <Tooltip content={fullJalali(s.last_fetched_at)}>
                <span className="cursor-default text-sm">{relativeJalali(s.last_fetched_at)}</span>
              </Tooltip>
            </TableCell>
            <TableCell className="tabular-nums">
              <span className="tabular-nums">{faNum(s.records_count)}</span>
            </TableCell>
            <TableCell>
              <Switch
                checked={s.is_active}
                onCheckedChange={() => onToggle(s)}
                aria-label={`فعال بودن منبع ${s.name}`}
              />
            </TableCell>
            <TableCell>
              <SourceRowActions
                source={s}
                onEdit={() => onEdit(s)}
                onDelete={() => onDelete(s)}
                onTest={() => onTest(s)}
                onRefresh={() => onRefresh(s)}
                testing={testingId === s.id}
                refreshing={refreshingId === s.id}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SourceMobileCard({
  source,
  onToggle,
  onEdit,
  onDelete,
  onTest,
  onRefresh,
  testing,
  refreshing,
}: {
  source: Source;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  onRefresh: () => void;
  testing: boolean;
  refreshing: boolean;
}) {
  const meta = TEAM_META[source.team as TeamName];
  return (
    <div className={`rounded-xl border border-border bg-card p-4 ${source.stale ? 'border-r-2 border-r-warning' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-foreground hover:text-brand hover:underline"
          >
            {source.name}
          </a>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge>{meta?.faName ?? source.team}</Badge>
            <Badge variant="secondary">{TYPE_LABEL[source.type] ?? source.type}</Badge>
            <Badge variant={source.authority === 1 ? 'brand' : 'secondary'}>
              درجه {faNum(source.authority)}
            </Badge>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Switch checked={source.is_active} onCheckedChange={onToggle} aria-label={`فعال بودن منبع ${source.name}`} />
          <SourceRowActions
            source={source}
            onEdit={onEdit}
            onDelete={onDelete}
            onTest={onTest}
            onRefresh={onRefresh}
            testing={testing}
            refreshing={refreshing}
          />
        </div>
      </div>
      <Collapsible trigger="جزئیات" openLabel="بستن">
        <dl className="mt-1 space-y-1.5 rounded-lg bg-muted/60 p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-xs text-muted-foreground">نشانی</dt>
              <dd dir="ltr" className="truncate text-xs">{shortUrl(source.url)}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-xs text-muted-foreground">آخرین بازخوانی</dt>
              <dd className="text-xs">{relativeJalali(source.last_fetched_at)}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-xs text-muted-foreground">رکوردها</dt>
              <dd className="text-xs tabular-nums">{faNum(source.records_count)}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-xs text-muted-foreground">تناوب</dt>
              <dd className="text-xs">{REFRESH_LABEL[source.refresh_interval]}</dd>
            </div>
          </dl>
      </Collapsible>
    </div>
  );
}

function SourcesTab({ registerAdd }: { registerAdd: (fn: () => void) => void }) {
  const { toast } = useToast();
  const [sources, setSources] = useState<Source[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const [teamFilter, setTeamFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Source | null>(null);
  const [deleting, setDeleting] = useState<Source | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  const reload = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    fetchSources().then((list) => {
      if (!alive) return;
      if (list === null) setFailed(true);
      else setSources(list);
    });
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  const filtered = (sources ?? []).filter((s) => {
    if (teamFilter && s.team !== teamFilter) return false;
    if (typeFilter && s.type !== typeFilter) return false;
    if (statusFilter === 'active' && !s.is_active) return false;
    if (statusFilter === 'inactive' && s.is_active) return false;
    if (statusFilter === 'stale' && !s.stale) return false;
    if (query) {
      const q = query.trim();
      if (q && !s.name.includes(q) && !s.url.includes(q)) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [teamFilter, typeFilter, statusFilter, query]);

  const toggleActive = async (s: Source) => {
    const prev = s.is_active;
    setSources((list) => list?.map((x) => (x.id === s.id ? { ...x, is_active: !prev } : x)) ?? null);
    try {
      const res = await fetch(`/api/knowledge/sources/${s.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !prev }),
      });
      if (!res.ok) throw new Error('toggle failed');
      toast({ title: !prev ? 'منبع فعال شد' : 'منبع غیرفعال شد', variant: 'success' });
    } catch {
      setSources((list) => list?.map((x) => (x.id === s.id ? { ...x, is_active: prev } : x)) ?? null);
      toast({ title: 'تغییر وضعیت نشد', description: 'دوباره تلاش کنید.', variant: 'error' });
    }
  };

  const testConnection = async (s: Source) => {
    setTestingId(s.id);
    try {
      const started = Date.now();
      const res = await fetch(`/api/knowledge/sources/${s.id}/test`, { method: 'POST' });
      const ms = Date.now() - started;
      if (!res.ok) throw new Error('test failed');
      toast({ title: 'اتصال برقرار شد', description: `${faNum(ms)} میلی‌ثانیه`, variant: 'success' });
    } catch {
      toast({ title: 'به این نشانی نرسیدیم', description: 'دوباره تلاش کنید.', variant: 'error' });
    } finally {
      setTestingId(null);
    }
  };

  const refreshSource = async (s: Source) => {
    setRefreshingId(s.id);
    try {
      const res = await fetch(`/api/knowledge/sources/${s.id}/refresh`, { method: 'POST' });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error('refresh failed');
      const count = (json as { data?: { new_records?: number } })?.data?.new_records ?? 0;
      toast({
        title: count > 0 ? `${faNum(count)} رکورد تازه استخراج شد` : 'رکورد تازه‌ای نبود',
        variant: 'success',
      });
      reload();
    } catch {
      toast({ title: 'بازخوانی ناموفق بود', description: 'دوباره تلاش کنید.', variant: 'error' });
    } finally {
      setRefreshingId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      const res = await fetch(`/api/knowledge/sources/${deleting.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('delete failed');
      toast({ title: 'منبع حذف شد', variant: 'success' });
      reload();
    } catch {
      toast({ title: 'حذف نشد', description: 'دوباره تلاش کنید.', variant: 'error' });
    } finally {
      setDeleting(null);
    }
  };

  const openAdd = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  useEffect(() => {
    registerAdd(openAdd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failed) {
    return (
      <EmptyState
        icon={Rss}
        title="مدیریت منابع هنوز راه‌اندازی نشده"
        description="API منابع دانش هنوز ساخته نشده است؛ به‌زودی این بخش فعال می‌شود."
        action={
          <Button variant="outline" size="sm" onClick={reload}>
            تلاش دوباره
          </Button>
        }
      />
    );
  }

  if (sources === null) {
    return (
      <div className="space-y-4" role="status" aria-label="در حال بارگذاری منابع">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-12 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SourceStats refreshKey={refreshKey} />

      {/* فیلترها */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          value={teamFilter}
          onChange={(e) => setTeamFilter(e.target.value)}
          options={[{ value: '', label: 'همه تیم‌ها' }, ...TEAMS.map((t) => ({ value: t, label: TEAM_META[t].faName }))]}
          aria-label="فیلتر تیم"
        />
        <Select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          options={[
            { value: '', label: 'همه نوع‌ها' },
            { value: 'doc', label: 'داک رسمی' },
            { value: 'blog', label: 'بلاگ تخصصی' },
            { value: 'competitor', label: 'رقیب' },
            { value: 'research', label: 'مقاله پژوهشی' },
          ]}
          aria-label="فیلتر نوع منبع"
        />
        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          options={[
            { value: '', label: 'همه وضعیت‌ها' },
            { value: 'active', label: 'فعال' },
            { value: 'inactive', label: 'غیرفعال' },
            { value: 'stale', label: 'نیازمند بازخوانی' },
          ]}
          aria-label="فیلتر وضعیت"
        />
        <SearchInput
          value={query}
          onChange={setQuery}
          onSearch={setQuery}
          placeholder="جست‌وجو در نام و نشانی…"
          aria-label="جست‌وجو در منابع"
        />
      </div>

      {/* جدول دسکتاپ / کارت‌های موبایل */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={Rss}
          title="هنوز منبعی ثبت نشده"
          description="با افزودن اولین منبع، ساب‌ایجنت دانش هر تیم از چرخهٔ بعد شروع به خواندن می‌کند."
          action={
            <Button variant="default" size="sm" onClick={openAdd}>
              <Plus size={16} />
              افزودن منبع
            </Button>
          }
        />
      ) : (
        <>
          <div className="hidden lg:block">
            <SourceTable
              sources={pageItems}
              onToggle={toggleActive}
              onEdit={(s) => { setEditing(s); setDialogOpen(true); }}
              onDelete={(s) => setDeleting(s)}
              onTest={testConnection}
              onRefresh={refreshSource}
              testingId={testingId}
              refreshingId={refreshingId}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:hidden">
            {pageItems.map((s) => (
              <SourceMobileCard
                key={s.id}
                source={s}
                onToggle={() => toggleActive(s)}
                onEdit={() => { setEditing(s); setDialogOpen(true); }}
                onDelete={() => setDeleting(s)}
                onTest={() => testConnection(s)}
                onRefresh={() => refreshSource(s)}
                testing={testingId === s.id}
                refreshing={refreshingId === s.id}
              />
            ))}
          </div>
          {totalPages > 1 && (
            <div className="flex justify-center">
              <Pagination page={page} total={totalPages} onChange={setPage} />
            </div>
          )}
        </>
      )}

      {/* دیالوگ افزودن / ویرایش */}
      <SourceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initial={editing}
        onSaved={reload}
      />

      {/* تأیید حذف */}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(o) => { if (!o) setDeleting(null); }}
        title={deleting ? `منبع «${deleting.name}» حذف شود؟` : 'حذف منبع'}
        description="رکوردهای دانش استخراج‌شده از این منبع حذف نمی‌شوند؛ فقط بازخوانی‌های بعدی متوقف می‌شود."
        confirmText="حذف منبع"
        cancelText="انصراف"
        destructive
        onConfirm={confirmDelete}
      />
    </div>
  );
}

/* ================= صفحه اصلی ================= */

function KnowledgePageInner() {
  const [tab, setTab] = useState('overview');
  const addRef = useRef<(() => void) | undefined>(undefined);

  return (
    <div>
      <PageHeader
        icon={BookOpen}
        title="مدیریت دانش"
        subtitle="دانش و منابع آموزشی هر تیم."
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/dashboard/knowledge/report"
              className="inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-border bg-card px-5 text-sm font-semibold text-foreground hover:bg-accent"
            >
              <GraduationCap size={16} strokeWidth={2} aria-hidden="true" />
              گزارش مربی
            </Link>
            <Button
              variant="brand"
              onClick={() => {
                if (tab === 'sources') addRef.current?.();
                else setTab('sources');
              }}
            >
              <Plus size={16} />
              افزودن منبع
            </Button>
          </div>
        }
      />

      <Tabs value={tab} defaultValue="overview" onValueChange={setTab} variant="underline">
        <TabsList aria-label="بخش‌های دانش">
          <TabsTrigger value="overview">نمای دانش</TabsTrigger>
          <TabsTrigger value="sources">منابع دانش</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <KnowledgeOverview />
        </TabsContent>
        <TabsContent value="sources">
          <SourcesTab registerAdd={(fn) => { addRef.current = fn; }} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function KnowledgePage() {
  return (
    <ToastProvider position="bottom-start" max={3}>
      <KnowledgePageInner />
    </ToastProvider>
  );
}
