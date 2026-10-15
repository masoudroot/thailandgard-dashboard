"use client";

import * as React from "react";
import { ChevronDown, FolderPlus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { cx } from "../ui/cx";
import { faNum } from "../../lib/format";
import { CategoryPicker } from "./CategoryPicker";
import {
  buildCategoryTree,
  fetchCategories,
  type CategoryTreeNode,
} from "./categories";

export type CategoryManagerProps = {
  /** slug تیم؛ همهٔ فراخوانی‌ها با همین تیم به API تیم ۱۱ می‌رود. */
  team: string;
};

type DeleteTarget = { id: string; name: string; descendants: number };

function countDescendants(node: CategoryTreeNode): number {
  return node.children.reduce((sum, c) => sum + 1 + countDescendants(c), 0);
}

/**
 * مدیریت دسته‌های دانش یک تیم: نمایش درختی، افزودن (نام + والد اختیاری)، حذف با تأیید.
 * با `/api/knowledge/categories` تیم ۱۱ کار می‌کند؛ اگر API هنوز نیست، خطای فارسی نشان می‌دهد.
 */
export function CategoryManager({ team }: CategoryManagerProps) {
  const [tree, setTree] = React.useState<CategoryTreeNode[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [showAdd, setShowAdd] = React.useState(false);
  const [name, setName] = React.useState("");
  const [parentId, setParentId] = React.useState<string | null>(null);
  const [nameError, setNameError] = React.useState<string | undefined>(undefined);
  const [saving, setSaving] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchCategories(team);
      setTree(buildCategoryTree(list));
    } catch (e) {
      setError(e instanceof Error ? e.message : "بارگذاری دسته‌ها ناموفق بود.");
    } finally {
      setLoading(false);
    }
  }, [team]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const openAdd = () => {
    setName("");
    setParentId(null);
    setNameError(undefined);
    setShowAdd(true);
  };

  const saveCategory = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("نام دسته را بنویسید.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/knowledge/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ team, name: trimmed, parent_id: parentId ?? null }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: { message?: string } }
        | null;
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error?.message || "ساخت دسته ناموفق بود.");
      }
      setShowAdd(false);
      await load();
    } catch (e) {
      setNameError(e instanceof Error ? e.message : "ساخت دسته ناموفق بود.");
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = (node: CategoryTreeNode) => {
    setDeleteTarget({ id: node.id, name: node.name, descendants: countDescendants(node) });
  };

  const runDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/knowledge/categories/${encodeURIComponent(deleteTarget.id)}?team=${encodeURIComponent(team)}`,
        { method: "DELETE", credentials: "same-origin" },
      );
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: { message?: string } }
        | null;
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error?.message || "حذف دسته ناموفق بود.");
      }
      setDeleteTarget(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "حذف دسته ناموفق بود.");
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section aria-label="مدیریت دسته‌های دانش" className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold leading-7 text-foreground">دسته‌بندی‌ها</h2>
        <Button size="sm" onClick={openAdd}>
          <FolderPlus aria-hidden="true" className="h-4 w-4" />
          دستهٔ تازه
        </Button>
      </div>

      {loading && (
        <div className="space-y-2" aria-label="در حال بارگذاری دسته‌ها">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-sm leading-6 text-destructive">{error}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="h-4 w-4" />
            تلاش دوباره
          </Button>
        </div>
      )}

      {!loading && !error && tree.length === 0 && (
        <div className="rounded-md border border-border bg-card p-6 text-center">
          <p className="text-sm leading-6 text-muted-foreground">
            هنوز دسته‌ای ساخته نشده. با دسته‌ها دانش تیم را مرتب نگه دارید.
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={openAdd}>
            <FolderPlus aria-hidden="true" className="h-4 w-4" />
            ساخت اولین دسته
          </Button>
        </div>
      )}

      {!loading && !error && tree.length > 0 && (
        <ul className="space-y-1">
          {tree.map((node) => (
            <TreeNode key={node.id} node={node} depth={0} onDelete={confirmDelete} />
          ))}
        </ul>
      )}

      <Modal
        open={showAdd}
        onClose={() => !saving && setShowAdd(false)}
        title="دستهٔ تازه"
        description="نام فارسی دسته و محل قرارگیری‌اش در درخت را مشخص کنید."
        footer={
          <div className="flex gap-2">
            <Button onClick={() => void saveCategory()} loading={saving}>
              افزودن دسته
            </Button>
            <Button variant="outline" onClick={() => setShowAdd(false)} disabled={saving}>
              انصراف
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Input
            label="نام دسته"
            placeholder="مثلاً بازارشناسی"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(undefined);
            }}
            error={nameError}
            maxLength={80}
            autoFocus
          />
          <CategoryPicker
            team={team}
            label="والد (اختیاری)"
            hint="اگر والد انتخاب نشود، دسته در ریشهٔ درخت می‌نشیند."
            value={parentId}
            onChange={setParentId}
            emptyLabel="بدون والد (ریشه)"
            disabled={saving}
          />
        </div>
      </Modal>

      <Modal
        open={deleteTarget !== null}
        onClose={() => !deleting && setDeleteTarget(null)}
        title="حذف دسته؟"
        size="sm"
        footer={
          <div className="flex gap-2">
            <Button variant="danger" onClick={() => void runDelete()} loading={deleting}>
              حذف دسته
            </Button>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              انصراف
            </Button>
          </div>
        }
      >
        {deleteTarget && (
          <p className="text-sm leading-7 text-muted-foreground">
            دستهٔ «{deleteTarget.name}»
            {deleteTarget.descendants > 0 && (
              <> و {faNum(deleteTarget.descendants)} زیرمجموعهٔ آن </>
            )}{" "}
            حذف می‌شود. این کار قابل بازگشت نیست.
          </p>
        )}
      </Modal>
    </section>
  );
}

function TreeNode({
  node,
  depth,
  onDelete,
}: {
  node: CategoryTreeNode;
  depth: number;
  onDelete: (node: CategoryTreeNode) => void;
}) {
  const [open, setOpen] = React.useState(true);
  const childCount = node.children.length;

  return (
    <li>
      <div
        className={cx(
          "flex min-h-11 items-center gap-2 rounded-md border border-border bg-card px-3 py-2",
          depth > 0 && "border-s-2 border-s-brand/40",
        )}
        style={depth > 0 ? { marginInlineStart: `${depth * 1.25}rem` } : undefined}
      >
        {childCount > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? `بستن زیرمجموعه‌های ${node.name}` : `باز کردن زیرمجموعه‌های ${node.name}`}
            aria-expanded={open}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-soft hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <ChevronDown
              aria-hidden="true"
              className={cx("h-4 w-4 transition-transform", open ? "" : "-rotate-90")}
            />
          </button>
        ) : (
          <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40 ms-2" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-6 text-foreground">
          {node.name}
        </span>
        {childCount > 0 && (
          <span className="shrink-0 text-xs leading-5 text-muted-foreground">
            {faNum(childCount)} زیرمجموعه
          </span>
        )}
        <button
          type="button"
          onClick={() => onDelete(node)}
          aria-label={`حذف دستهٔ ${node.name}`}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-soft hover:bg-destructive/10 hover:text-destructive focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <Trash2 aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
      {open && childCount > 0 && (
        <ul className="mt-1 space-y-1">
          {node.children.map((child) => (
            <TreeNode key={child.id} node={child} depth={depth + 1} onDelete={onDelete} />
          ))}
        </ul>
      )}
    </li>
  );
}
