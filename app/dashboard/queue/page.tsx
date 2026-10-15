'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Ban,
  CheckCircle2,
  Hourglass,
  Inbox,
  KeyRound,
  ListChecks,
  Play,
  Plus,
  RotateCw,
  XCircle,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { TEAMS } from '@/lib/types';
import EmptyState from '@/components/EmptyState';
import NotConnected from '@/components/NotConnected';
import PageHeader from '@/components/PageHeader';
import { SkeletonPanel } from '@/components/Skeleton';
import LoadMore, { useVisibleCount } from '@/components/LoadMore';
import { Switch } from '@/components/ui/Switch';

/* ------------------------------------------------------------------ */
/*  مدل داده (آینهٔ واقعی build_queue + تنظیمات اجرا)                   */
/* ------------------------------------------------------------------ */

type TaskStatus = 'pending' | 'approved' | 'in_progress' | 'done' | 'rejected';
type TaskPriority = 'low' | 'medium' | 'high' | 'critical';
type ExecutionMode = 'now' | 'cycle';

interface BuildTask {
  id: string;
  title: string;
  team: string;
  description: string;
  files_hint: string;
  priority: TaskPriority;
  status: TaskStatus;
  result: string | null;
  created_at: string;
  completed_at: string | null;
}

interface TaskPrefs {
  execution_mode: ExecutionMode;
  parallel: boolean;
}

const STATUSES: { key: TaskStatus; label: string; icon: LucideIcon }[] = [
  { key: 'pending', label: 'در انتظار تأیید', icon: Hourglass },
  { key: 'approved', label: 'آماده اجرا', icon: Play },
  { key: 'in_progress', label: 'در حال انجام', icon: Zap },
  { key: 'done', label: 'انجام‌شده', icon: CheckCircle2 },
  { key: 'rejected', label: 'ردشده', icon: Ban },
];

const PRIORITIES: { key: TaskPriority; label: string }[] = [
  { key: 'low', label: 'کم' },
  { key: 'medium', label: 'متوسط' },
  { key: 'high', label: 'زیاد' },
  { key: 'critical', label: 'بحرانی' },
];

const TEAM_LABELS: Record<string, string> = {
  artdir: 'طراحی ارشد',
  branding: 'برند',
  content: 'محتوا',
  seo: 'سئو',
  analytics: 'تحلیل',
  intel: 'اطلاعات',
  lead: 'لید',
  design: 'دیزاین',
  seocontent: 'محتوای سئو',
  vibefarsi: 'وایب‌فارسی',
  farsiui: 'فارسی UI',
  'design-ir': 'دیزاین ایرانی',
  dev: 'توسعه',
  qa: 'کیفیت',
  inspector: 'بازرس',
};

const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

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

function taskFiles(task: BuildTask): string[] {
  return (task.files_hint ?? '')
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
}

const PRIORITY_STYLE: Record<TaskPriority, string> = {
  critical: 'bg-destructive text-destructive-foreground',
  high: 'bg-warning text-warning-foreground',
  medium: 'bg-brand text-brand-foreground',
  low: 'bg-secondary text-secondary-foreground',
};

const STATUS_BADGE: Record<TaskStatus, string> = {
  pending: 'bg-warning/15 text-warning',
  approved: 'bg-brand/15 text-brand',
  in_progress: 'bg-brand/15 text-brand',
  done: 'bg-success/15 text-success',
  rejected: 'bg-muted text-muted-foreground',
};

/** باز کردن پوشش API: { ok, data } یا دادهٔ خام */
function unwrapPayload(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    return (body as { data: unknown }).data;
  }
  return body;
}

async function readError(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}));
  const payload = unwrapPayload(body) as { error?: { message?: string } | string };
  if (typeof payload?.error === 'string') return payload.error;
  return payload?.error?.message ?? `خطا با کد ${res.status}`;
}

type LoadState = 'loading' | 'ready' | 'not-connected' | 'unauthorized';

/* ------------------------------------------------------------------ */
/*  توضیح بازشونده                                                     */
/* ------------------------------------------------------------------ */

function TaskDescription({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="mb-3">
      <p className={`text-sm leading-7 text-muted-foreground ${open ? '' : 'line-clamp-3'}`}>
        {text}
      </p>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mt-1 inline-flex min-h-11 items-center text-xs font-medium text-brand hover:underline"
      >
        {open ? 'بستن' : 'بیشتر'}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  صفحه                                                              */
/* ------------------------------------------------------------------ */

export default function QueuePage() {
  const [tab, setTab] = useState<TaskStatus>('pending');
  const [tasks, setTasks] = useState<BuildTask[]>([]);
  const [prefs, setPrefs] = useState<Record<string, TaskPrefs>>({});
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [acting, setActing] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const [form, setForm] = useState({
    title: '',
    team: 'dev',
    description: '',
    files: '',
    priority: 'medium' as TaskPriority,
    executionMode: 'cycle' as ExecutionMode,
    parallel: true,
  });

  const showToast = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ text, kind });
    window.setTimeout(() => setToast(null), 3600);
  }, []);

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const res = await fetch('/api/tasks', { cache: 'no-store', credentials: 'same-origin' });
      if (res.status === 401) {
        setLoadState('unauthorized');
        return;
      }
      if (!res.ok) throw new Error(await readError(res));
      const body = await res.json();
      const list = (unwrapPayload(body) ?? []) as BuildTask[];
      setTasks(Array.isArray(list) ? list : []);
      // تنظیمات اجرا (execution_mode / parallel)؛ یک کوئری برای همه
      try {
        const ids = (Array.isArray(list) ? list : []).map((t) => t.id).join(',');
        if (ids) {
          const pr = await fetch(`/api/tasks/prefs?ids=${encodeURIComponent(ids)}`, {
            cache: 'no-store',
            credentials: 'same-origin',
          });
          if (pr.ok) {
            const pb = await pr.json();
            setPrefs((unwrapPayload(pb) ?? {}) as Record<string, TaskPrefs>);
          }
        }
      } catch {
        /* تنظیمات اجرا اختیاری است؛ نبودش صفحه را نمی‌شکند */
      }
      setLoadState('ready');
    } catch {
      // قانون مسعود: به‌جای دادهٔ نمونه، صادقانه «متصل نیست»
      setTasks([]);
      setLoadState('not-connected');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<TaskStatus, number> = {
      pending: 0,
      approved: 0,
      in_progress: 0,
      done: 0,
      rejected: 0,
    };
    for (const t of tasks) {
      if (c[t.status] !== undefined) c[t.status] += 1;
    }
    return c;
  }, [tasks]);

  const visible = useMemo(
    () =>
      tasks
        .filter((t) => t.status === tab)
        .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)),
    [tasks, tab],
  );

  const PAGE_SIZE = 6;
  const { visible: shownCount, hasMore, showMore } = useVisibleCount(visible.length, PAGE_SIZE, tab);
  const shownTasks = visible.slice(0, shownCount);

  async function handleApprove(id: string) {
    setActing(id);
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'approve' }),
      });
      if (!res.ok) throw new Error(await readError(res));
      showToast('کار تأیید شد و آمادهٔ اجراست.');
      await load();
      setTab('approved');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'کار تأیید نشد؛ دوباره تلاش کنید.', 'err');
    } finally {
      setActing(null);
    }
  }

  async function handleReject(id: string) {
    if (!rejectReason.trim()) {
      showToast('دلیل رد را بنویسید.', 'err');
      return;
    }
    setActing(id);
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'reject', reason: rejectReason.trim() }),
      });
      if (!res.ok) throw new Error(await readError(res));
      showToast('کار رد شد.');
      setRejectingId(null);
      setRejectReason('');
      await load();
      setTab('rejected');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'کار رد نشد؛ دوباره تلاش کنید.', 'err');
    } finally {
      setActing(null);
    }
  }

  async function handleRunNow(id: string) {
    setActing(id);
    try {
      const res = await fetch(`/api/tasks/${id}/run`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(await readError(res));
      showToast('اجرا شروع شد؛ نتیجه همین‌جا ثبت می‌شود.');
      await load();
      setTab('in_progress');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'اجرا شروع نشد؛ دوباره تلاش کنید.', 'err');
    } finally {
      setActing(null);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) {
      showToast('عنوان کار را بنویسید.', 'err');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          title: form.title.trim(),
          description: form.description.trim(),
          team: form.team,
          priority: form.priority,
          files: form.files
            .split('\n')
            .map((f) => f.trim())
            .filter(Boolean),
          execution_mode: form.executionMode,
          parallel: form.parallel,
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = await res.json();
      const created = (unwrapPayload(body) ?? {}) as { status?: string };
      setForm({
        title: '',
        team: 'dev',
        description: '',
        files: '',
        priority: 'medium',
        executionMode: 'cycle',
        parallel: true,
      });
      setFormOpen(false);
      await load();
      if (created.status === 'in_progress') {
        setTab('in_progress');
        showToast('کار ثبت و اجرایش شروع شد.');
      } else {
        setTab('pending');
        showToast('کار تازه در «در انتظار تأیید» ثبت شد.');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'کار ثبت نشد؛ دوباره تلاش کنید.', 'err');
    } finally {
      setSubmitting(false);
    }
  }

  const tabMeta = STATUSES.find((s) => s.key === tab);

  return (
    <div dir="rtl" className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <PageHeader
          icon={ListChecks}
          title="صف ساخت"
          subtitle="کارهای پیشنهادی تیم‌ها را بررسی و تأیید کنید، یا کار تازه‌ای ثبت کنید."
          actions={
            <>
              <button
                type="button"
                onClick={load}
                className="tg-btn inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm shadow-control transition hover:bg-accent sm:flex-none"
              >
                <RotateCw size={16} strokeWidth={2} aria-hidden="true" />
                تازه‌سازی
              </button>
              <button
                type="button"
                onClick={() => setFormOpen((v) => !v)}
                aria-expanded={formOpen}
                className="tg-btn inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-control transition hover:opacity-90 sm:flex-none"
              >
                <Plus size={16} strokeWidth={2} aria-hidden="true" />
                {formOpen ? 'بستن فرم' : 'کار جدید'}
              </button>
            </>
          }
        />

        {loadState === 'loading' ? (
          <div className="grid gap-4 md:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <SkeletonPanel key={i} />
            ))}
          </div>
        ) : loadState === 'not-connected' ? (
          <NotConnected onRetry={load} retrying={false} />
        ) : loadState === 'unauthorized' ? (
          <EmptyState
            icon={KeyRound}
            title="ورود شما منقضی شده است"
            description="برای دیدن صف ساخت دوباره وارد شوید."
            action={
              <Link
                href="/login"
                className="inline-flex min-h-11 items-center justify-center rounded-xl bg-primary px-6 py-2 text-sm font-bold text-primary-foreground shadow-control hover:opacity-90"
              >
                ورود دوباره
              </Link>
            }
          />
        ) : (
          <>
            {/* فرم تعریف کار جدید */}
            {formOpen && (
              <section
                aria-label="فرم تعریف کار جدید"
                className="mb-6 rounded-xl border border-border bg-card p-4 shadow-surface sm:p-6"
              >
                <h2 className="text-base font-bold">تعریف کار جدید</h2>
                <form onSubmit={handleCreate} className="mt-4 space-y-6">
                  {/* مشخصات کار */}
                  <fieldset>
                    <legend className="mb-3 text-sm font-semibold text-muted-foreground">
                      مشخصات کار
                    </legend>
                    <div className="grid gap-4 md:grid-cols-2">
                      <label className="block">
                        <span className="mb-1 block text-sm font-medium">عنوان *</span>
                        <input
                          value={form.title}
                          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                          placeholder="مثلاً: بازطراحی بنر هیروی صفحهٔ تورها"
                          className="min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm"
                        />
                      </label>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <label className="block">
                          <span className="mb-1 block text-sm font-medium">تیم مجری *</span>
                          <select
                            value={form.team}
                            onChange={(e) => setForm((f) => ({ ...f, team: e.target.value }))}
                            className="min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm"
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
                            onChange={(e) =>
                              setForm((f) => ({ ...f, priority: e.target.value as TaskPriority }))
                            }
                            className="min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm"
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
                          className="min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm"
                        />
                      </label>
                      <label className="block md:col-span-2">
                        <span className="mb-1 block text-sm font-medium">
                          فایل‌های مرتبط <span className="font-normal text-muted-foreground">(هر خط یک مسیر)</span>
                        </span>
                        <textarea
                          value={form.files}
                          onChange={(e) => setForm((f) => ({ ...f, files: e.target.value }))}
                          rows={2}
                          dir="ltr"
                          placeholder={'site/app/tours/page.tsx\nsite/components/Hero.tsx'}
                          className="min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2.5 font-mono text-sm"
                        />
                      </label>
                    </div>
                  </fieldset>

                  {/* تنظیمات اجرا */}
                  <fieldset className="rounded-xl border border-border bg-muted/40 p-4">
                    <legend className="px-2 text-sm font-semibold text-muted-foreground">
                      تنظیمات اجرا
                    </legend>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div role="radiogroup" aria-label="حالت اجرا هنگام ثبت">
                        <span className="mb-2 block text-sm font-medium">حالت اجرا هنگام ثبت</span>
                        <div className="space-y-2">
                          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 has-[:checked]:border-brand">
                            <input
                              type="radio"
                              name="execution-mode"
                              checked={form.executionMode === 'now'}
                              onChange={() => setForm((f) => ({ ...f, executionMode: 'now' }))}
                              className="h-4 w-4 accent-[var(--brand)]"
                            />
                            <span className="text-sm">
                              <span className="font-semibold">همین الان انجام شود</span>
                              <span className="block text-xs text-muted-foreground">
                                اجرای فوری با ساب‌ایجنت‌ها؛ نتیجه همین‌جا ثبت می‌شود
                              </span>
                            </span>
                          </label>
                          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 has-[:checked]:border-brand">
                            <input
                              type="radio"
                              name="execution-mode"
                              checked={form.executionMode === 'cycle'}
                              onChange={() => setForm((f) => ({ ...f, executionMode: 'cycle' }))}
                              className="h-4 w-4 accent-[var(--brand)]"
                            />
                            <span className="text-sm">
                              <span className="font-semibold">برود در چرخه</span>
                              <span className="block text-xs text-muted-foreground">
                                بعد از تأیید، در اسرع وقت توسط تیم در چرخه انجام می‌شود
                              </span>
                            </span>
                          </label>
                        </div>
                      </div>
                      <div>
                        <span className="mb-2 block text-sm font-medium">نحوهٔ اجرای ساب‌ایجنت‌ها</span>
                        <div className="flex min-h-11 items-center rounded-lg border border-border bg-card px-3 py-2">
                          <Switch
                            checked={form.parallel}
                            onCheckedChange={(v) => setForm((f) => ({ ...f, parallel: v }))}
                            label={form.parallel ? 'موازی: سه مجری هم‌زمان' : 'ترتیبی: مجری‌ها یکی‌یکی'}
                          />
                        </div>
                        <p className="mt-2 text-xs leading-6 text-muted-foreground">
                          در اجرای فوری، مجری‌ها
                          {form.parallel ? ' هم‌زمان' : ' یکی‌یکی'} کار می‌کنند.
                        </p>
                      </div>
                    </div>
                  </fieldset>

                  <div>
                    <button
                      type="submit"
                      disabled={submitting}
                      className="tg-btn min-h-12 w-full rounded-xl bg-primary px-6 py-2 text-sm font-bold text-primary-foreground shadow-control transition hover:opacity-90 disabled:opacity-50 sm:w-auto"
                    >
                      {submitting
                        ? 'در حال ثبت…'
                        : form.executionMode === 'now'
                          ? 'ثبت و اجرای فوری'
                          : 'ثبت در صف تأیید'}
                    </button>
                  </div>
                </form>
              </section>
            )}

            {/* فیلتر وضعیت */}
            <nav
              className="mb-6 flex gap-2 overflow-x-auto pb-2 sm:flex-wrap sm:overflow-visible sm:pb-0"
              aria-label="فیلتر وضعیت"
            >
              {STATUSES.map((s) => {
                const active = tab === s.key;
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setTab(s.key)}
                    aria-pressed={active}
                    className={`tg-btn min-h-11 shrink-0 rounded-full border px-4 py-1.5 text-sm transition ${
                      active
                        ? 'border-primary bg-primary text-primary-foreground shadow-control'
                        : 'border-border bg-card text-foreground hover:bg-accent'
                    }`}
                  >
                    {s.label}
                    <span
                      className={`ms-2 inline-block rounded-full px-1.5 text-xs ${active ? 'bg-primary-foreground/25' : 'bg-secondary'}`}
                    >
                      {faNum(counts[s.key])}
                    </span>
                  </button>
                );
              })}
            </nav>

            {/* لیست کارها */}
            {visible.length === 0 ? (
              (() => {
                const Icon = tabMeta?.icon ?? Inbox;
                return (
                  <EmptyState
                    icon={Icon}
                    title={
                      tab === 'pending'
                        ? 'کاری در انتظار تأیید نیست'
                        : tab === 'approved'
                          ? 'کاری آمادهٔ اجرا نیست'
                          : tab === 'in_progress'
                            ? 'کاری در حال انجام نیست'
                            : tab === 'done'
                              ? 'هنوز کاری به سرانجام نرسیده است'
                              : 'کاری رد نشده است'
                    }
                    description={
                      tab === 'pending'
                        ? 'کارهای پیشنهادی تیم‌ها برای تأیید شما اینجا می‌آیند.'
                        : tab === 'approved'
                          ? 'کارهای تأییدشده اینجا می‌مانند تا در چرخه یا فوری اجرا شوند.'
                          : undefined
                    }
                    tint="bg-muted text-muted-foreground"
                    action={
                      tab === 'pending' ? (
                        <button
                          type="button"
                          onClick={() => setFormOpen(true)}
                          className="tg-btn inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2 text-sm font-bold text-primary-foreground shadow-control transition hover:opacity-90"
                        >
                          <Plus size={16} strokeWidth={2} aria-hidden="true" />
                          تعریف کار جدید
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
                    const priorityLabel =
                      PRIORITIES.find((p) => p.key === task.priority)?.label ?? task.priority;
                    const statusLabel = STATUSES.find((s) => s.key === task.status)?.label ?? task.status;
                    const pref = prefs[task.id];
                    const files = taskFiles(task);
                    const isRejecting = rejectingId === task.id;
                    return (
                      <article
                        key={task.id}
                        className="tg-card flex flex-col rounded-xl border border-border bg-card p-4 shadow-surface sm:p-5"
                      >
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground">
                            تیم {teamLabel(task.team)}
                          </span>
                          <span
                            className={`rounded-full px-3 py-1 text-xs font-medium ${PRIORITY_STYLE[task.priority]}`}
                          >
                            اولویت {priorityLabel}
                          </span>
                          <span className={`rounded-full px-3 py-1 text-xs ${STATUS_BADGE[task.status]}`}>
                            {statusLabel}
                          </span>
                          {pref && (
                            <span className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
                              {pref.execution_mode === 'now' ? 'اجرای فوری' : 'در چرخه'}
                              {' · '}
                              {pref.parallel ? 'موازی' : 'ترتیبی'}
                            </span>
                          )}
                        </div>

                        <h3 className="mb-1 text-base font-bold leading-8">{task.title}</h3>
                        <TaskDescription text={task.description} />

                        {files.length > 0 && (
                          <div className="mb-3 flex flex-wrap gap-1.5">
                            {files.map((f) => (
                              <code
                                key={f}
                                dir="ltr"
                                className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground"
                              >
                                {f}
                              </code>
                            ))}
                          </div>
                        )}

                        {task.status === 'rejected' && task.result && (
                          <p className="mb-3 rounded-lg bg-muted/60 px-3 py-2 text-xs leading-6 text-muted-foreground">
                            دلیل رد: {task.result}
                          </p>
                        )}
                        {task.status === 'done' && task.result && (
                          <p className="mb-3 line-clamp-4 rounded-lg bg-success/10 px-3 py-2 text-xs leading-6 text-card-foreground">
                            {task.result}
                          </p>
                        )}

                        {isRejecting ? (
                          <div className="mt-auto pt-3">
                            <label className="mb-2 block text-xs font-medium text-muted-foreground">
                              دلیل رد (الزامی)
                            </label>
                            <textarea
                              value={rejectReason}
                              onChange={(e) => setRejectReason(e.target.value)}
                              rows={2}
                              placeholder="چرا این کار رد می‌شود؟"
                              className="min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                            />
                            <div className="mt-2 flex gap-2">
                              <button
                                type="button"
                                disabled={acting === task.id}
                                onClick={() => handleReject(task.id)}
                                className="tg-btn min-h-11 rounded-lg bg-destructive px-5 py-1.5 text-sm font-bold text-destructive-foreground shadow-control transition hover:opacity-90 disabled:opacity-50"
                              >
                                {acting === task.id ? 'در حال رد…' : 'رد کار'}
                              </button>
                              <button
                                type="button"
                                disabled={acting === task.id}
                                onClick={() => {
                                  setRejectingId(null);
                                  setRejectReason('');
                                }}
                                className="tg-btn min-h-11 rounded-lg border border-border px-5 py-1.5 text-sm transition hover:bg-accent disabled:opacity-50"
                              >
                                انصراف
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="mt-auto flex items-center justify-between gap-2 pt-3">
                            <span className="text-xs text-muted-foreground">
                              {relativeTime(task.created_at)}
                            </span>
                            <div className="flex gap-2">
                              {task.status === 'pending' && (
                                <>
                                  <button
                                    type="button"
                                    disabled={acting === task.id}
                                    onClick={() => handleApprove(task.id)}
                                    className="tg-btn min-h-11 rounded-lg bg-success px-5 py-1.5 text-sm font-medium text-success-foreground shadow-control transition hover:opacity-90 disabled:opacity-50"
                                  >
                                    {acting === task.id ? 'صبر کنید…' : 'تأیید کار'}
                                  </button>
                                  <button
                                    type="button"
                                    disabled={acting === task.id}
                                    onClick={() => {
                                      setRejectingId(task.id);
                                      setRejectReason('');
                                    }}
                                    className="tg-btn min-h-11 rounded-lg border border-destructive px-5 py-1.5 text-sm text-destructive transition hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
                                  >
                                    رد کار
                                  </button>
                                </>
                              )}
                              {(task.status === 'approved' || task.status === 'pending') && (
                                <button
                                  type="button"
                                  disabled={acting === task.id}
                                  onClick={() => handleRunNow(task.id)}
                                  title="اجرای فوری با ساب‌ایجنت‌ها"
                                  className="tg-btn inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-primary px-5 py-1.5 text-sm font-medium text-primary-foreground shadow-control transition hover:opacity-90 disabled:opacity-50"
                                >
                                  <Zap size={15} strokeWidth={2} aria-hidden="true" />
                                  {acting === task.id ? 'در حال شروع…' : 'همین الان اجرا شود'}
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
                {hasMore && (
                  <LoadMore visible={shownCount} total={visible.length} onShowMore={showMore} />
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* اعلان */}
      {toast && (
        <div
          role="status"
          className={`fixed bottom-6 start-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-xl px-5 py-3 text-sm shadow-surface rtl:translate-x-1/2 ${
            toast.kind === 'ok'
              ? 'bg-success text-success-foreground'
              : 'bg-destructive text-destructive-foreground'
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
