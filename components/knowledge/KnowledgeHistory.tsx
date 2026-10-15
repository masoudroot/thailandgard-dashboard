"use client";

import * as React from "react";
import { ChevronDown, FileText, History } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { cx } from "@/components/ui/cx";

export type KnowledgeVersion = {
  id: string;
  action: string;
  actionFa: string;
  title: string;
  content: string;
  created_at: string;
  dateFa: string;
};

type HistoryProps = {
  /** شناسهٔ دانشی که تاریخچه‌اش نمایش داده می‌شود. */
  knowledgeId: string;
  /** عنوان فعلی دانش، برای سربرگ مودال. */
  knowledgeTitle?: string;
  open: boolean;
  onClose: () => void;
};

const ACTION_STYLE: Record<string, { dot: string; chip: string }> = {
  create: {
    dot: "bg-success",
    chip: "bg-success/10 text-success ring-1 ring-inset ring-success/25",
  },
  update: {
    dot: "bg-warning",
    chip: "bg-warning/10 text-warning ring-1 ring-inset ring-warning/25",
  },
  delete: {
    dot: "bg-destructive",
    chip: "bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/25",
  },
};

const FALLBACK_STYLE = {
  dot: "bg-muted-foreground",
  chip: "bg-muted text-muted-foreground",
};

/**
 * تاریخچهٔ نسخه‌های یک دانش در مودال.
 * هر نسخه: برچسب عمل، تاریخ شمسی، عنوان آن نسخه، و دکمهٔ «مشاهده متن».
 * فقط خواندن است؛ ثبت نسخه‌ها با تیم ۱۱ است.
 */
export function KnowledgeHistory({
  knowledgeId,
  knowledgeTitle,
  open,
  onClose,
}: HistoryProps) {
  const [versions, setVersions] = React.useState<KnowledgeVersion[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [openVersionId, setOpenVersionId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open || !knowledgeId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setOpenVersionId(null);
    fetch(`/api/knowledge/${encodeURIComponent(knowledgeId)}/history`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as {
          ok?: boolean;
          data?: { versions?: KnowledgeVersion[] };
          error?: { message?: string };
        } | null;
        if (cancelled) return;
        if (!res.ok || !body?.ok) {
          throw new Error(body?.error?.message ?? "خطای خواندن تاریخچه.");
        }
        setVersions(body.data?.versions ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "خطای خواندن تاریخچه.");
          setVersions([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, knowledgeId]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={knowledgeTitle ? `تاریخچهٔ «${knowledgeTitle}»` : "تاریخچهٔ دانش"}
      description="هر ویرایش، یک نسخه ثبت می‌کند؛ متن آن نسخه را هم می‌توانید ببینید."
      size="md"
    >
      {loading && (
        <div className="space-y-3" aria-live="polite">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-lg bg-muted/60"
            />
          ))}
          <p className="sr-only">در حال بارگذاری تاریخچه…</p>
        </div>
      )}

      {!loading && error && (
        <p role="alert" className="text-sm leading-7 text-destructive">
          {error}
        </p>
      )}

      {!loading && !error && versions.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card px-4 py-8 text-center">
          <History className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm leading-7 text-muted-foreground">
            هنوز نسخه‌ای برای این دانش ثبت نشده است.
          </p>
        </div>
      )}

      {!loading && !error && versions.length > 0 && (
        <ol className="relative space-y-0 pe-1">
          {versions.map((v, i) => {
            const style = ACTION_STYLE[v.action] ?? FALLBACK_STYLE;
            const expanded = openVersionId === v.id;
            const versionNo = versions.length - i;
            return (
              <li key={v.id} className="relative pb-5 ps-7 last:pb-0">
                {i < versions.length - 1 && (
                  <span
                    aria-hidden="true"
                    className="absolute end-auto start-[7px] top-7 h-[calc(100%-1.75rem)] w-px bg-border"
                  />
                )}
                <span
                  aria-hidden="true"
                  className={cx(
                    "absolute start-0 top-1.5 h-4 w-4 rounded-full border-2 border-card shadow-overlay",
                    style.dot,
                  )}
                />
                <div className="rounded-lg border border-border bg-card p-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span
                      className={cx(
                        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium leading-6",
                        style.chip,
                      )}
                    >
                      {v.actionFa}
                    </span>
                    <span className="text-xs leading-6 text-muted-foreground">
                      نسخهٔ {versionNo.toLocaleString("fa-IR")}، {v.dateFa}
                    </span>
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-sm font-medium leading-7">
                    {v.title}
                  </p>
                  <button
                    type="button"
                    onClick={() => setOpenVersionId(expanded ? null : v.id)}
                    aria-expanded={expanded}
                    aria-controls={`kh-content-${v.id}`}
                    className="touch-target mt-2 inline-flex items-center gap-1.5 rounded-md text-xs font-medium leading-6 text-primary transition-soft hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <FileText className="h-4 w-4" aria-hidden="true" />
                    {expanded ? "بستن متن" : "مشاهدهٔ متن"}
                    <ChevronDown
                      className={cx(
                        "h-3.5 w-3.5 transition-transform",
                        expanded && "rotate-180",
                      )}
                      aria-hidden="true"
                    />
                  </button>
                  {expanded && (
                    <div
                      id={`kh-content-${v.id}`}
                      className="mt-2 max-h-64 overflow-y-auto rounded-md border border-border bg-muted/40 p-3"
                    >
                      <p className="whitespace-pre-wrap text-sm leading-7 text-foreground">
                        {v.content}
                      </p>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Modal>
  );
}
