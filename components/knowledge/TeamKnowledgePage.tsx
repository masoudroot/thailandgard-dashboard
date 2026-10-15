"use client";

import * as React from "react";
import {
  BookOpenText,
  CalendarDays,
  FolderOpen,
  Inbox,
  Link2,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type { TeamName } from "@/lib/types";
import { formatJalali } from "@/lib/jalali";
import { faNum } from "@/lib/format";
import PageHeader from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonLines } from "@/components/Skeleton";
import { Badge, Button, Card, CardContent } from "@/components/ui";
import { Dialog } from "@/components/ui/dialog";
import KnowledgeSearch from "./KnowledgeSearch";
import {
  KnowledgeForm,
  type KnowledgeInitialData,
  type KnowledgeCategoryOption,
} from "./KnowledgeForm";

/** یک آیتم دانش از GET /api/knowledge/[team]؛ category_id از روی والدش پر می‌شود. */
interface ItemView {
  id: string;
  title: string;
  snippet: string;
  source: string | null;
  updated_at: string;
  category_id: string | null;
}

interface CategoryView {
  id: string;
  name: string;
  parent_id: string | null;
  items: ItemView[];
}

interface TeamData {
  categories: CategoryView[];
  uncategorized: ItemView[];
}

interface HistoryVersion {
  action: string;
  content: string;
}

type LoadStatus = "loading" | "error" | "ready";

interface TeamKnowledgePageProps {
  team: TeamName;
  faName: string;
  mission: string;
  /** امتیاز دانش تیم (۰ تا ۱۰۰)؛ null یعنی محاسبه نشد. */
  score: number | null;
}

/**
 * صفحهٔ دانش یک تیم (تیم ۶).
 * داده از GET /api/knowledge/[team]؛ جست‌وجو با KnowledgeSearch،
 * افزودن/ویرایش با KnowledgeForm (تیم ۸)، حذف با تأیید.
 */
export default function TeamKnowledgePage({
  team,
  faName,
  mission,
  score,
}: TeamKnowledgePageProps) {
  const [status, setStatus] = React.useState<LoadStatus>("loading");
  const [data, setData] = React.useState<TeamData>({ categories: [], uncategorized: [] });
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<KnowledgeInitialData | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = React.useState<ItemView | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setStatus("loading");
    setLoadError(null);
    try {
      const res = await fetch(`/api/knowledge/${encodeURIComponent(team)}`);
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        data?: {
          categories?: Array<{
            id: string;
            name: string;
            parent_id: string | null;
            items?: Array<{
              id: string;
              title: string;
              snippet: string;
              source: string | null;
              updated_at: string;
            }>;
          }>;
          uncategorized?: Array<{
            id: string;
            title: string;
            snippet: string;
            source: string | null;
            updated_at: string;
          }>;
        };
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.ok || !json.data) {
        throw new Error(
          json?.error?.message ?? "خواندن دانش تیم ناموفق بود.",
        );
      }
      const categories: CategoryView[] = (json.data.categories ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        parent_id: c.parent_id,
        items: (c.items ?? []).map((it) => ({ ...it, category_id: c.id })),
      }));
      const uncategorized: ItemView[] = (json.data.uncategorized ?? []).map((it) => ({
        ...it,
        category_id: null,
      }));
      setData({ categories, uncategorized });
      setStatus("ready");
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "خواندن دانش تیم ناموفق بود.",
      );
      setStatus("error");
    }
  }, [team]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const categoryOptions: KnowledgeCategoryOption[] = React.useMemo(
    () => data.categories.map((c) => ({ id: c.id, name: c.name })),
    [data.categories],
  );

  const totalItems =
    data.uncategorized.length +
    data.categories.reduce((sum, c) => sum + c.items.length, 0);

  function openAddForm() {
    setEditing(null);
    setFormOpen(true);
  }

  /** ویرایش: متن کامل از جدیدترین نسخهٔ تاریخچه خوانده می‌شود. */
  async function openEditForm(item: ItemView) {
    setEditingId(item.id);
    let content = "";
    try {
      const res = await fetch(
        `/api/knowledge/${encodeURIComponent(item.id)}/history`,
      );
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        data?: { versions?: HistoryVersion[] };
      } | null;
      const versions = json?.ok ? (json.data?.versions ?? []) : [];
      const latest = versions.find(
        (v) => v.action === "create" || v.action === "update",
      );
      content = latest?.content ?? "";
    } catch {
      content = "";
    }
    setEditingId(null);
    setEditing({
      id: item.id,
      title: item.title,
      content,
      category_id: item.category_id,
      source: item.source,
    });
    setFormOpen(true);
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(
        `/api/knowledge/${encodeURIComponent(deleteTarget.id)}`,
        { method: "DELETE" },
      );
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error?.message ?? "حذف دانش ناموفق بود.");
      }
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "حذف دانش ناموفق بود.",
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <PageHeader
        icon={BookOpenText}
        title={`دانش تیم ${faName}`}
        subtitle={mission}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {score !== null && (
              <Badge variant="brand">
                امتیاز دانش {faNum(Math.round(score))} از {faNum(100)}
              </Badge>
            )}
            <Button onClick={openAddForm}>
              <Plus size={18} aria-hidden="true" />
              افزودن دانش
            </Button>
          </div>
        }
      />

      {/* جست‌وجوی معنایی در دانش همین تیم */}
      <div className="mb-6">
        <KnowledgeSearch
          team={team}
          placeholder={`در دانش تیم ${faName} جست‌وجو کنید…`}
        />
      </div>

      {status === "loading" && (
        <div className="space-y-6" aria-label="در حال بارگذاری">
          <SkeletonLines lines={2} />
          <SkeletonLines lines={5} />
          <SkeletonLines lines={4} />
        </div>
      )}

      {status === "error" && (
        <EmptyState
          icon={FolderOpen}
          title="دانش تیم خوانده نشد"
          description={loadError ?? "اتصال را بررسی کنید و دوباره تلاش کنید."}
          action={
            <Button variant="outline" onClick={() => void load()}>
              تلاش دوباره
            </Button>
          }
        />
      )}

      {status === "ready" && totalItems === 0 && (
        <EmptyState
          icon={Inbox}
          title="هنوز دانشی ثبت نشده است"
          description="اولین دانش این تیم را اضافه کنید تا در جست‌وجو و پاسخ‌گویی تیم‌ها به کار رود."
          action={
            <Button onClick={openAddForm}>
              <Plus size={18} aria-hidden="true" />
              افزودن دانش
            </Button>
          }
        />
      )}

      {status === "ready" && totalItems > 0 && (
        <div className="space-y-8">
          {data.categories.map((cat) => (
            <section
              key={cat.id}
              aria-label={cat.name}
              className={cat.parent_id ? "border-s-2 border-border ps-4" : undefined}
            >
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h2
                  className={
                    cat.parent_id
                      ? "text-base font-bold text-foreground"
                      : "text-lg font-bold text-foreground"
                  }
                >
                  {cat.name}
                </h2>
                <Badge variant="secondary">
                  {faNum(cat.items.length)} دانش
                </Badge>
              </div>
              {cat.items.length === 0 ? (
                <p className="text-sm leading-7 text-muted-foreground">
                  هنوز دانشی در این دسته ثبت نشده است.
                </p>
              ) : (
                <div className="space-y-3">
                  {cat.items.map((item) => (
                    <KnowledgeItemCard
                      key={item.id}
                      item={item}
                      editing={editingId === item.id}
                      onEdit={() => void openEditForm(item)}
                      onDelete={() => {
                        setDeleteError(null);
                        setDeleteTarget(item);
                      }}
                    />
                  ))}
                </div>
              )}
            </section>
          ))}

          {data.uncategorized.length > 0 && (
            <section aria-label="بدون دسته">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-bold text-foreground">بدون دسته</h2>
                <Badge variant="secondary">
                  {faNum(data.uncategorized.length)} دانش
                </Badge>
              </div>
              <div className="space-y-3">
                {data.uncategorized.map((item) => (
                  <KnowledgeItemCard
                    key={item.id}
                    item={item}
                    editing={editingId === item.id}
                    onEdit={() => void openEditForm(item)}
                    onDelete={() => {
                      setDeleteError(null);
                      setDeleteTarget(item);
                    }}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* فرم افزودن/ویرایش (تیم ۸) */}
      <KnowledgeForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSaved={() => void load()}
        team={team}
        initialData={editing}
        categories={categoryOptions}
      />

      {/* تأیید حذف */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o && !deleting) setDeleteTarget(null);
        }}
        className="max-w-sm"
        title="این دانش حذف شود؟"
        footer={
          <>
            <Button
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleting}
              aria-busy={deleting || undefined}
            >
              {deleting && (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              )}
              حذف
            </Button>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              انصراف
            </Button>
          </>
        }
      >
        <p className="text-sm leading-7 text-muted-foreground">
          «{deleteTarget?.title}» برای همیشه حذف می‌شود و از جست‌وجو هم بیرون
          می‌رود. این کار قابل بازگشت نیست.
        </p>
        {deleteError && (
          <p role="alert" className="mt-3 text-sm leading-7 text-destructive">
            {deleteError}
          </p>
        )}
      </Dialog>
    </div>
  );
}

function KnowledgeItemCard({
  item,
  editing,
  onEdit,
  onDelete,
}: {
  item: ItemView;
  editing: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 flex-1 text-sm font-bold leading-7 text-card-foreground">
            {item.title}
          </h3>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={onEdit}
              disabled={editing}
              aria-busy={editing || undefined}
              aria-label={`ویرایش ${item.title}`}
              title="ویرایش"
            >
              {editing ? (
                <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              ) : (
                <Pencil size={16} aria-hidden="true" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              aria-label={`حذف ${item.title}`}
              title="حذف"
            >
              <Trash2 size={16} aria-hidden="true" />
            </Button>
          </div>
        </div>
        {item.snippet && (
          <p className="mt-1 text-sm leading-7 text-muted-foreground">
            {item.snippet}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs leading-6 text-muted-foreground">
          {item.source && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <Link2 size={14} aria-hidden="true" className="shrink-0" />
              <span className="max-w-48 truncate" dir="auto">
                {item.source}
              </span>
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <CalendarDays size={14} aria-hidden="true" />
            {formatJalali(new Date(item.updated_at))}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
