'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ChevronDown,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitPullRequest,
  Hourglass,
  Inbox,
  KeyRound,
  RotateCw,
} from 'lucide-react';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import NotConnected from '@/components/NotConnected';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonPanel } from '@/components/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { faNum } from '@/lib/format';
import {
  BRIDGE_STATUS_FA,
  type BridgeDiff,
  type BridgeDiffFile,
  type BridgePatchStatus,
  type BridgePatchSummary,
} from '@/lib/bridge';

/* ------------------------------------------------------------------ */
/*  ابزارهای کوچک                                                      */
/* ------------------------------------------------------------------ */

type TabKey = 'pending' | 'approved' | 'rejected';

// دستور مسعود: پل کاملاً خودکار است؛ این صفحه فقط مشاهده است، نه تأیید.
const TABS: { key: TabKey; label: string; statuses: BridgePatchStatus[] }[] = [
  { key: 'pending', label: 'در حال پردازش', statuses: ['proposed', 'gated', 'committed', 'needs_review'] },
  { key: 'approved', label: 'مرج‌شده', statuses: ['approved', 'merged'] },
  { key: 'rejected', label: 'ردشده', statuses: ['rejected', 'rolledback'] },
];

const FILE_STATUS_FA: Record<string, string> = {
  added: 'افزوده‌شده',
  modified: 'تغییرکرده',
  removed: 'حذف‌شده',
  renamed: 'تغییرنام‌یافته',
};

function jalaliDate(iso: string | null): string {
  if (!iso) return 'نامشخص';
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(new Date(iso));
  } catch {
    return 'نامشخص';
  }
}

function tehranTime(iso: string | null): string {
  if (!iso) return '';
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

/** حجم پچ با ارقام فارسی، مثل «۲۴ کیلوبایت». */
function faBytes(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return 'نامشخص';
  if (bytes < 1024) return `${faNum(bytes)} بایت`;
  const kb = bytes / 1024;
  const shown = kb >= 100 ? String(Math.round(kb)) : kb.toFixed(1);
  return `${faNum(shown)} کیلوبایت`;
}

/** شمار خطاهای دروازه؛ null یعنی اطلاعی نیست. */
function gateErrorsCount(gate: unknown): number | null {
  if (gate == null) return 0;
  if (Array.isArray(gate)) return gate.length;
  if (typeof gate === 'object') {
    const errs = (gate as Record<string, unknown>).errors;
    if (Array.isArray(errs)) return errs.length;
    return Object.keys(gate as Record<string, unknown>).length;
  }
  return null;
}

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
  return payload?.error?.message ?? `خطا با کد ${faNum(res.status)}`;
}

type LoadState = 'loading' | 'ready' | 'not-connected' | 'unauthorized';

type DiffLoad =
  | { state: 'loading' }
  | { state: 'error' }
  | {
      state: 'ready';
      diff: BridgeDiff | null;
      githubConnected: boolean;
      githubMessage?: string;
    };

interface DetailPayload {
  diff?: BridgeDiff | null;
  github_connected?: boolean;
  github_message?: string;
}

/* ------------------------------------------------------------------ */
/*  نمایش خط‌های diff                                                 */
/* ------------------------------------------------------------------ */

function DiffPatchView({ patch }: { patch: string }) {
  const lines = patch.split('\n');
  return (
    <pre
      dir="ltr"
      className="mt-2 max-h-96 overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-xs leading-5"
    >
      {lines.map((line, i) => {
        const isAdd = line.startsWith('+') && !line.startsWith('+++');
        const isDel = line.startsWith('-') && !line.startsWith('---');
        const isHunk = line.startsWith('@@');
        return (
          <div
            key={i}
            className={
              isAdd
                ? 'bg-success/10 text-success'
                : isDel
                  ? 'bg-destructive/10 text-destructive'
                  : isHunk
                    ? 'text-brand'
                    : 'text-muted-foreground'
            }
          >
            {line === '' ? ' ' : line}
          </div>
        );
      })}
    </pre>
  );
}

function DiffFileRow({ file }: { file: BridgeDiffFile }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg bg-background px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span
          dir="ltr"
          className="min-w-0 flex-1 truncate font-mono text-xs text-foreground"
          title={file.filename}
        >
          {file.filename}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="font-mono text-xs" dir="ltr">
            <span className="text-success">+{faNum(file.additions)}</span>{' '}
            <span className="text-destructive">-{faNum(file.deletions)}</span>
          </span>
          <Badge variant="secondary">{FILE_STATUS_FA[file.status] ?? file.status}</Badge>
          {file.patch && (
            <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              diff
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={`transition-transform ${open ? 'rotate-180' : ''}`}
              />
            </Button>
          )}
        </span>
      </div>
      {open && file.patch && <DiffPatchView patch={file.patch} />}
    </li>
  );
}

function DiffView({ load }: { load: DiffLoad }) {
  if (load.state === 'loading') {
    return <p className="py-2 text-sm text-muted-foreground">در حال خواندن diff از گیت‌هاب…</p>;
  }
  if (load.state === 'error') {
    return (
      <p role="alert" className="py-2 text-sm text-destructive">
        خواندن diff ناموفق بود. دوباره تلاش کنید.
      </p>
    );
  }
  if (!load.githubConnected) {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        {load.githubMessage ?? 'گیت‌هاب متصل نیست؛ diff در دسترس نیست.'}
      </p>
    );
  }
  const diff = load.diff;
  if (!diff) {
    return <p className="py-2 text-sm text-muted-foreground">diffای برای این پچ ثبت نشده است.</p>;
  }
  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">
        مقایسهٔ <code dir="ltr" className="font-mono">{diff.base}</code>
        {' با '}
        <code dir="ltr" className="font-mono">{diff.head}</code>
        {': '}
        {faNum(diff.changed_files)} فایل
        {' ('}
        <span className="text-success">+{faNum(diff.additions)}</span>
        {' / '}
        <span className="text-destructive">-{faNum(diff.deletions)}</span>
        {')'}
        {diff.ahead_by > 0 && (
          <span>
            {'؛ '}
            {faNum(diff.ahead_by)} کامیت جلوتر
          </span>
        )}
        {diff.truncated && <span>؛ فهرست فایل‌ها خلاصه شده است.</span>}
      </p>
      {diff.files.length === 0 ? (
        <p className="text-sm text-muted-foreground">گیت‌هاب فایلی برای این مقایسه ثبت نکرده است.</p>
      ) : (
        <ul className="space-y-1.5">
          {diff.files.map((f) => (
            <DiffFileRow key={f.filename} file={f} />
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  کارت پچ                                                            */
/* ------------------------------------------------------------------ */

interface PatchCardProps {
  patch: BridgePatchSummary;
  diff: DiffLoad | undefined;
  diffOpen: boolean;
  onToggleDiff: () => void;
}

function statusVariant(status: BridgePatchStatus): 'warning' | 'destructive' | 'success' {
  if (status === 'rejected') return 'destructive';
  if (status === 'merged' || status === 'approved' || status === 'rolledback') return 'success';
  return 'warning';
}

function PatchCard(props: PatchCardProps) {
  const { patch, diff, diffOpen, onToggleDiff } = props;
  const gateCount = gateErrorsCount(patch.gate_errors);

  return (
    <article className="flex flex-col rounded-xl border border-border bg-card p-4 shadow-surface sm:p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {patch.team && <Badge variant="secondary">تیم {patch.team}</Badge>}
        <Badge variant={statusVariant(patch.status)}>
          {BRIDGE_STATUS_FA[patch.status] ?? patch.status}
        </Badge>
        {patch.status === 'merged' && patch.decided_by === 'auto' && (
          <Badge variant="secondary">خودکار</Badge>
        )}
        {gateCount != null && (
          <Badge variant="secondary">
            {gateCount === 0 ? 'دروازه: بدون خطا' : `دروازه: ${faNum(gateCount)} خطا`}
          </Badge>
        )}
      </div>

      <h3 className="mb-1 text-base font-bold leading-8">{patch.summary || 'پچ بدون عنوان'}</h3>

      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {patch.branch && (
          <span className="inline-flex items-center gap-1">
            <GitBranch size={13} aria-hidden="true" />
            <code dir="ltr" className="font-mono">{patch.branch}</code>
          </span>
        )}
        <span>{faNum(patch.file_count)} فایل</span>
        <span>{faBytes(patch.total_bytes)}</span>
        {patch.commit_sha && (
          <span>
            کامیت <code dir="ltr" className="font-mono">{patch.commit_sha.slice(0, 7)}</code>
          </span>
        )}
        <span>
          {jalaliDate(patch.created_at)}
          {tehranTime(patch.created_at) ? `، ساعت ${tehranTime(patch.created_at)}` : ''}
        </span>
      </div>

      {patch.file_paths.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {patch.file_paths.slice(0, 8).map((f) => (
            <code
              key={f}
              dir="ltr"
              className="max-w-full truncate rounded bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground"
              title={f}
            >
              {f}
            </code>
          ))}
          {patch.file_paths.length > 8 && (
            <span className="text-xs text-muted-foreground">
              و {faNum(patch.file_paths.length - 8)} فایل دیگر
            </span>
          )}
        </div>
      )}

      {patch.status === 'rejected' && patch.rejection_reason && (
        <p className="mb-3 rounded-lg bg-muted/60 px-3 py-2 text-xs leading-6 text-muted-foreground">
          دلیل رد: {patch.rejection_reason}
        </p>
      )}
      {(patch.status === 'approved' || patch.status === 'merged') && (
        <p className="mb-3 rounded-lg bg-success/10 px-3 py-2 text-xs leading-6 text-card-foreground">
          {patch.decided_by === 'auto' ? 'به‌صورت خودکار مرج شد' : patch.status === 'approved' ? 'تأیید و مرج شد' : 'مرج شد'}
          {patch.decided_at && (
            <span>
              {'؛ '}
              {jalaliDate(patch.decided_at)}
              {tehranTime(patch.decided_at) ? `، ساعت ${tehranTime(patch.decided_at)}` : ''}
            </span>
          )}
          {patch.merge_sha && (
            <span>
              {'؛ مرج '} <code dir="ltr" className="font-mono">{patch.merge_sha.slice(0, 7)}</code>
            </span>
          )}
        </p>
      )}
      {patch.status === 'needs_review' && (
        <p className="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-xs leading-6 text-card-foreground">
          این پچ در دروازه کیفیت رد شد و متوقف ماند؛ چرخه ادامه یافت. برای جزئیات، diff و خطاهای دروازه را ببینید.
        </p>
      )}

      {/* diff */}
      <div className="mb-3 border-t border-border pt-3">
        <Button variant="ghost" size="sm" onClick={onToggleDiff} aria-expanded={diffOpen}>
          <FileDiff size={15} aria-hidden="true" />
          مشاهده diff
          <ChevronDown
            size={15}
            aria-hidden="true"
            className={`transition-transform ${diffOpen ? 'rotate-180' : ''}`}
          />
        </Button>
        {diffOpen && diff && (
          <div className="mt-3">
            <DiffView load={diff} />
          </div>
        )}
      </div>

      {/* مشاهده‌محور: تأیید دستی حذف شده؛ پردازش و مرج خودکار است */}
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        {patch.compare_url && (
          <a
            href={patch.compare_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border px-4 py-2 text-sm font-semibold hover:bg-muted"
          >
            <ExternalLink size={15} aria-hidden="true" />
            مقایسه در گیت‌هاب
          </a>
        )}
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/*  صفحه                                                              */
/* ------------------------------------------------------------------ */

export default function BridgePage() {
  const [tab, setTab] = useState<TabKey>('pending');
  const [patches, setPatches] = useState<BridgePatchSummary[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [diffs, setDiffs] = useState<Record<string, DiffLoad>>({});
  const [diffOpenId, setDiffOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);

  const showToast = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ text, kind });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const res = await fetch('/api/bridge/patches', { cache: 'no-store', credentials: 'same-origin' });
      if (res.status === 401) {
        setLoadState('unauthorized');
        return;
      }
      if (!res.ok) throw new Error(await readError(res));
      const body = await res.json();
      const list = (unwrapPayload(body) ?? []) as BridgePatchSummary[];
      setPatches(Array.isArray(list) ? list : []);
      setLoadState('ready');
    } catch {
      setPatches([]);
      setLoadState('not-connected');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleDiff(id: string) {
    if (diffOpenId === id) {
      setDiffOpenId(null);
      return;
    }
    setDiffOpenId(id);
    if (diffs[id]) return;
    setDiffs((d) => ({ ...d, [id]: { state: 'loading' } }));
    try {
      const res = await fetch(`/api/bridge/patches/${encodeURIComponent(id)}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = await res.json();
      const detail = (unwrapPayload(body) ?? {}) as DetailPayload;
      setDiffs((d) => ({
        ...d,
        [id]: {
          state: 'ready',
          diff: detail.diff ?? null,
          githubConnected: detail.github_connected !== false,
          githubMessage: detail.github_message,
        },
      }));
    } catch {
      setDiffs((d) => ({ ...d, [id]: { state: 'error' } }));
    }
  }

  const activeTab = TABS.find((t) => t.key === tab) ?? TABS[0];
  const visible = patches
    .filter((p) => activeTab.statuses.includes(p.status))
    .sort((a, b) => +new Date(b.created_at ?? 0) - +new Date(a.created_at ?? 0));
  const counts: Record<TabKey, number> = {
    pending: patches.filter((p) =>
      ['proposed', 'gated', 'committed', 'needs_review'].includes(p.status),
    ).length,
    approved: patches.filter((p) => p.status === 'approved' || p.status === 'merged').length,
    rejected: patches.filter((p) => p.status === 'rejected' || p.status === 'rolledback').length,
  };
  const preparing = patches.filter((p) => p.status === 'proposed' || p.status === 'gated').length;

  return (
    <div dir="rtl" className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <PageHeader
          icon={GitPullRequest}
          title="پل اجرا"
          subtitle="پچ‌های تیم‌ها به‌صورت خودکار پردازش و به dev مرج می‌شوند؛ این صفحه فقط برای مشاهده است."
          actions={
            <Button variant="outline" onClick={load} className="flex-1 sm:flex-none">
              <RotateCw size={16} strokeWidth={2} aria-hidden="true" />
              تازه‌سازی
            </Button>
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
            description="برای دیدن پچ‌های پل اجرا دوباره وارد شوید."
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
            {/* تب‌های وضعیت */}
            <nav className="mb-6 flex gap-2 overflow-x-auto pb-2 sm:flex-wrap sm:overflow-visible sm:pb-0" aria-label="فیلتر وضعیت">
              {TABS.map((t) => {
                const active = tab === t.key;
                return (
                  <Button
                    key={t.key}
                    variant={active ? 'default' : 'outline'}
                    className="shrink-0 rounded-full"
                    onClick={() => setTab(t.key)}
                    aria-pressed={active}
                  >
                    {t.label}
                    <span
                      className={`ms-2 inline-block rounded-full px-1.5 text-xs ${active ? 'bg-primary-foreground/25' : 'bg-secondary'}`}
                    >
                      {faNum(counts[t.key])}
                    </span>
                  </Button>
                );
              })}
            </nav>

            {tab === 'pending' && preparing > 0 && (
              <p className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
                <Hourglass size={14} aria-hidden="true" />
                {faNum(preparing)} پچ در مرحلهٔ آماده‌سازی است.
              </p>
            )}

            {visible.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title={
                  tab === 'pending'
                    ? 'پچی در حال پردازش نیست'
                    : tab === 'approved'
                      ? 'هنوز پچی مرج نشده است'
                      : 'پچی رد نشده است'
                }
                description={
                  tab === 'pending'
                    ? 'پچ‌های تیم‌ها به‌صورت خودکار پردازش و به dev مرج می‌شوند.'
                    : undefined
                }
              />
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {visible.map((patch) => (
                  <PatchCard
                    key={patch.id}
                    patch={patch}
                    diff={diffs[patch.id]}
                    diffOpen={diffOpenId === patch.id}
                    onToggleDiff={() => toggleDiff(patch.id)}
                  />
                ))}
              </div>
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
