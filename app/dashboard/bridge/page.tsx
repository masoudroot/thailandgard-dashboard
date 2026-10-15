'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitPullRequest,
  Hourglass,
  Inbox,
  KeyRound,
  RotateCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import NotConnected from '@/components/NotConnected';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonPanel } from '@/components/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Label } from '@/components/ui/Input';
import { PasswordInput } from '@/components/ui/password-input';
import { Textarea } from '@/components/ui/textarea';
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

const MANAGER_KEY_STORAGE = 'tg-bridge-manager-key';

type TabKey = 'pending' | 'approved' | 'rejected';

const TABS: { key: TabKey; label: string; statuses: BridgePatchStatus[] }[] = [
  { key: 'pending', label: 'در انتظار تأیید', statuses: ['committed'] },
  { key: 'approved', label: 'تأییدشده', statuses: ['approved', 'merged'] },
  { key: 'rejected', label: 'ردشده', statuses: ['rejected'] },
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
  onApprove: () => void;
  onReject: (reason: string) => void;
  acting: boolean;
  confirmApprove: boolean;
  onArmApprove: () => void;
  onDisarmApprove: () => void;
}

function PatchCard(props: PatchCardProps) {
  const { patch, diff, diffOpen, onToggleDiff, acting } = props;
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const gateCount = gateErrorsCount(patch.gate_errors);
  const pending = patch.status === 'committed';

  return (
    <article className="flex flex-col rounded-xl border border-border bg-card p-4 shadow-surface sm:p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {patch.team && <Badge variant="secondary">تیم {patch.team}</Badge>}
        <Badge variant={pending ? 'warning' : patch.status === 'rejected' ? 'destructive' : 'success'}>
          {BRIDGE_STATUS_FA[patch.status] ?? patch.status}
        </Badge>
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
          {patch.status === 'approved' ? 'تأیید و مرج شد' : 'مرج شد'}
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

      {pending && (
        <div className="mt-auto pt-1">
          {rejectOpen ? (
            <div>
              <Label htmlFor={`reject-reason-${patch.id}`} className="mb-2 block text-xs font-medium">
                دلیل رد (الزامی)
              </Label>
              <Textarea
                id={`reject-reason-${patch.id}`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="چرا این پچ رد می‌شود؟"
              />
              <div className="mt-2 flex gap-2">
                <Button
                  variant="destructive"
                  disabled={acting || !reason.trim()}
                  aria-busy={acting || undefined}
                  onClick={() => props.onReject(reason.trim())}
                >
                  {acting ? 'در حال رد…' : 'رد پچ'}
                </Button>
                <Button
                  variant="outline"
                  disabled={acting}
                  onClick={() => {
                    setRejectOpen(false);
                    setReason('');
                  }}
                >
                  انصراف
                </Button>
              </div>
            </div>
          ) : props.confirmApprove ? (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
              <p className="mb-2 text-sm font-semibold">
                این پچ تأیید و بلافاصله به dev مرج می‌شود. مطمئن هستید؟
              </p>
              <div className="flex gap-2">
                <Button variant="default" disabled={acting} aria-busy={acting || undefined} onClick={props.onApprove}>
                  {acting ? 'در حال مرج…' : 'بله، تأیید و مرج کن'}
                </Button>
                <Button variant="outline" disabled={acting} onClick={props.onDisarmApprove}>
                  انصراف
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
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
              <Button
                variant="default"
                className="bg-success text-success-foreground hover:bg-success/90"
                disabled={acting}
                onClick={props.onArmApprove}
              >
                <CheckCircle2 size={16} strokeWidth={2} aria-hidden="true" />
                تأیید و مرج به dev
              </Button>
              <Button
                variant="outline"
                className="border-destructive/30 text-destructive hover:bg-destructive hover:text-white"
                disabled={acting}
                onClick={() => setRejectOpen(true)}
              >
                <XCircle size={16} strokeWidth={2} aria-hidden="true" />
                رد پچ
              </Button>
            </div>
          )}
        </div>
      )}
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
  const [actingId, setActingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [managerKey, setManagerKey] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(MANAGER_KEY_STORAGE);
      if (saved) {
        setManagerKey(saved);
        setKeyInput(saved);
      }
    } catch {
      /* حافظهٔ نشست در دسترس نیست */
    }
  }, []);

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

  function saveKey() {
    const v = keyInput.trim();
    if (!v) {
      showToast('کلید مدیریتی را وارد کنید.', 'err');
      return;
    }
    try {
      sessionStorage.setItem(MANAGER_KEY_STORAGE, v);
    } catch {
      /* ذخیره نشد؛ فقط در همین حافظهٔ کامپوننت می‌ماند */
    }
    setManagerKey(v);
    showToast('کلید مدیریتی برای این نشست ذخیره شد.');
  }

  function clearKey() {
    try {
      sessionStorage.removeItem(MANAGER_KEY_STORAGE);
    } catch {
      /* نادیده */
    }
    setManagerKey(null);
    setKeyInput('');
  }

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

  function needKey(): string | null {
    if (!managerKey) {
      showToast('اول کلید مدیریتی را وارد و ذخیره کنید.', 'err');
      return null;
    }
    return managerKey;
  }

  async function handleApprove(id: string) {
    const key = needKey();
    if (!key) return;
    setActingId(id);
    try {
      const res = await fetch(`/api/bridge/patches/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        credentials: 'same-origin',
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(await readError(res));
      showToast('پچ تأیید و به dev مرج شد.');
      setConfirmId(null);
      setDiffOpenId(null);
      await load();
      setTab('approved');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'تأیید انجام نشد؛ دوباره تلاش کنید.', 'err');
    } finally {
      setActingId(null);
    }
  }

  async function handleReject(id: string, reason: string) {
    const key = needKey();
    if (!key) return;
    setActingId(id);
    try {
      const res = await fetch(`/api/bridge/patches/${encodeURIComponent(id)}/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        credentials: 'same-origin',
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) throw new Error(await readError(res));
      showToast('پچ رد شد.');
      setDiffOpenId(null);
      await load();
      setTab('rejected');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'رد انجام نشد؛ دوباره تلاش کنید.', 'err');
    } finally {
      setActingId(null);
    }
  }

  const activeTab = TABS.find((t) => t.key === tab) ?? TABS[0];
  const visible = patches
    .filter((p) => activeTab.statuses.includes(p.status))
    .sort((a, b) => +new Date(b.created_at ?? 0) - +new Date(a.created_at ?? 0));
  const counts: Record<TabKey, number> = {
    pending: patches.filter((p) => p.status === 'committed').length,
    approved: patches.filter((p) => p.status === 'approved' || p.status === 'merged').length,
    rejected: patches.filter((p) => p.status === 'rejected').length,
  };
  const preparing = patches.filter((p) => p.status === 'proposed' || p.status === 'gated').length;

  return (
    <div dir="rtl" className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <PageHeader
          icon={GitPullRequest}
          title="پل اجرا"
          subtitle="پچ‌های تیم‌ها را بازبینی کنید؛ مرج به dev فقط با تأیید صریح شما انجام می‌شود."
          actions={
            <Button variant="outline" onClick={load} className="flex-1 sm:flex-none">
              <RotateCw size={16} strokeWidth={2} aria-hidden="true" />
              تازه‌سازی
            </Button>
          }
        />

        {/* کلید مدیریتی */}
        <section
          aria-label="کلید مدیریتی"
          className="mb-6 rounded-xl border border-border bg-card p-4 shadow-surface"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Label htmlFor="bridge-manager-key" className="mb-1 block text-sm font-medium">
                کلید مدیریتی
              </Label>
              <PasswordInput
                id="bridge-manager-key"
                dir="ltr"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder="کلید API مدیر داشبورد"
                autoComplete="off"
              />
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                تأیید و رد پچ فقط با کلید مدیریتی انجام می‌شود؛ کلید فقط در همین نشست مرورگر می‌ماند.
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="default" onClick={saveKey}>
                <KeyRound size={16} strokeWidth={2} aria-hidden="true" />
                ذخیره کلید
              </Button>
              {managerKey && (
                <Button variant="outline" onClick={clearKey}>
                  حذف
                </Button>
              )}
            </div>
          </div>
          {managerKey && (
            <p className="mt-2 flex items-center gap-1 text-xs text-success">
              <ShieldCheck size={14} aria-hidden="true" />
              کلید مدیریتی برای این نشست ذخیره شد.
            </p>
          )}
        </section>

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
                {faNum(preparing)} پچ در مرحلهٔ آماده‌سازی است و هنوز قابل تأیید نیست.
              </p>
            )}

            {visible.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title={
                  tab === 'pending'
                    ? 'پچی در انتظار تأیید نیست'
                    : tab === 'approved'
                      ? 'هنوز پچی تأیید نشده است'
                      : 'پچی رد نشده است'
                }
                description={
                  tab === 'pending'
                    ? 'پچ‌های کامیت‌شدهٔ تیم‌ها برای تأیید شما اینجا می‌آیند.'
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
                    onApprove={() => handleApprove(patch.id)}
                    onReject={(reason) => handleReject(patch.id, reason)}
                    acting={actingId === patch.id}
                    confirmApprove={confirmId === patch.id}
                    onArmApprove={() => setConfirmId(patch.id)}
                    onDisarmApprove={() => setConfirmId(null)}
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
