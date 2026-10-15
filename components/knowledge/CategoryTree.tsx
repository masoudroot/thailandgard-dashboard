'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronLeft, FileText, FolderOpen } from 'lucide-react';
import { faNum } from '../TeamCard';
import EmptyState from '../EmptyState';

/** آیتم دانش؛ همان شکل `GET /api/knowledge/[team]` */
export interface KnowledgeTreeItem {
  id: string;
  title: string;
  snippet: string;
  source: string | null;
  updated_at: string;
}

/** دسته؛ همان شکل `GET /api/knowledge/[team]` */
export interface KnowledgeTreeCategory {
  id: string;
  name: string;
  parent_id: string | null;
  items: KnowledgeTreeItem[];
}

export interface CategoryTreeProps {
  /** دسته‌های تخت تیم؛ خود کامپوننت درخت می‌سازد */
  categories: KnowledgeTreeCategory[];
  /** شناسه دسته انتخاب‌شده (هایلایت) */
  selectedCategoryId?: string | null;
  /** با کلیک روی دسته فراخوانی می‌شود */
  onSelectCategory?: (categoryId: string | null) => void;
  /** با کلیک روی آیتم دانش فراخوانی می‌شود */
  onSelectItem?: (itemId: string) => void;
  className?: string;
}

interface TreeNode {
  category: KnowledgeTreeCategory;
  children: TreeNode[];
}

/** تورفتگی راست‌به‌چپ؛ از عمق ۳ به بعد ثابت می‌ماند */
const INDENT_CLASS: Record<number, string> = {
  0: '',
  1: 'ps-4',
  2: 'ps-8',
  3: 'ps-12',
};

/** ساخت درخت از لیست تخت؛ یتیم‌ها و والد گمشده ریشه می‌شوند */
function buildTree(categories: KnowledgeTreeCategory[]): TreeNode[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const childrenOf = new Map<string, TreeNode[]>();
  const nodes = new Map(categories.map((c) => [c.id, { category: c, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];
  for (const c of categories) {
    const node = nodes.get(c.id)!;
    const parentId = c.parent_id && byId.has(c.parent_id) && c.parent_id !== c.id ? c.parent_id : null;
    if (parentId) {
      const list = childrenOf.get(parentId) ?? [];
      list.push(node);
      childrenOf.set(parentId, list);
    } else {
      roots.push(node);
    }
  }
  childrenOf.forEach((list, id) => {
    const node = nodes.get(id);
    if (node) node.children = list;
  });
  return roots;
}

/** تعداد دانش دسته با زیرشاخه‌ها */
function countItems(node: TreeNode): number {
  return (
    node.category.items.length +
    node.children.reduce((sum, child) => sum + countItems(child), 0)
  );
}

/**
 * درخت دسته‌های دانش یک تیم: والد ← فرزندان با تورفتگی راست‌به‌چپ،
 * تعداد دانش هر دسته و باز/بسته شدن. آیتم‌های هر دسته‌ی باز، زیرش لیست می‌شود.
 */
export default function CategoryTree({
  categories,
  selectedCategoryId = null,
  onSelectCategory,
  onSelectItem,
  className = '',
}: CategoryTreeProps) {
  const roots = useMemo(() => buildTree(categories), [categories]);

  // پیش‌فرض: دسته‌های ریشه بازند
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(roots.map((r) => r.category.id)),
  );

  const totalItems = useMemo(
    () => roots.reduce((sum, r) => sum + countItems(r), 0),
    [roots],
  );

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCategoryClick = (id: string) => {
    toggle(id);
    onSelectCategory?.(id);
  };

  const renderNode = (node: TreeNode, depth: number, visited: Set<string>): React.ReactNode => {
    if (visited.has(node.category.id)) return null;
    const nextVisited = new Set(visited);
    nextVisited.add(node.category.id);

    const { category } = node;
    const isOpen = expanded.has(category.id);
    const isSelected = selectedCategoryId === category.id;
    const hasChildren = node.children.length > 0;
    const itemCount = countItems(node);
    const indent = INDENT_CLASS[Math.min(depth, 3)] ?? '';

    return (
      <div key={category.id}>
        <button
          type="button"
          onClick={() => handleCategoryClick(category.id)}
          aria-expanded={hasChildren || category.items.length > 0 ? isOpen : undefined}
          aria-label={isOpen ? `بستن دسته ${category.name}` : `باز کردن دسته ${category.name}`}
          className={`flex min-h-11 w-full items-center gap-2 px-4 py-2 text-start transition-colors duration-150 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${indent} ${
            isSelected ? 'bg-muted' : ''
          }`}
        >
          <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground">
            {hasChildren || category.items.length > 0 ? (
              isOpen ? (
                <ChevronDown size={18} strokeWidth={2} />
              ) : (
                <ChevronLeft size={18} strokeWidth={2} />
              )
            ) : (
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-bold leading-7 text-card-foreground">
            {category.name}
          </span>
          <span
            aria-label={`${faNum(itemCount)} دانش`}
            className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs leading-5 text-muted-foreground tabular-nums"
          >
            {faNum(itemCount)}
          </span>
        </button>

        {isOpen && (
          <div>
            {node.children.map((child) => renderNode(child, depth + 1, nextVisited))}
            {category.items.length > 0 && (
              <ul className={INDENT_CLASS[Math.min(depth + 1, 3)] ?? ''}>
                {category.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => onSelectItem?.(item.id)}
                      className="flex w-full items-start gap-2 px-4 py-2.5 text-start transition-colors duration-150 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <FileText
                        size={16}
                        strokeWidth={1.5}
                        aria-hidden="true"
                        className="mt-1.5 shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium leading-7 text-card-foreground">
                          {item.title}
                        </span>
                        {item.snippet && (
                          <span className="block truncate text-xs leading-6 text-muted-foreground">
                            {item.snippet}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    );
  };

  if (categories.length === 0) {
    return (
      <EmptyState
        icon={FolderOpen}
        title="هنوز دسته‌ای ساخته نشده است"
        description="دسته‌بندی‌های دانش این تیم از بخش مدیریت دانش اضافه می‌شود."
      />
    );
  }

  return (
    <section
      aria-label="درخت دسته‌های دانش"
      className={`overflow-hidden rounded-xl border border-border bg-card ${className}`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-bold leading-7 text-card-foreground">دسته‌ها</h2>
        <span className="text-xs leading-6 text-muted-foreground tabular-nums">
          {faNum(totalItems)} دانش
        </span>
      </div>
      <div className="py-1">{roots.map((root) => renderNode(root, 0, new Set()))}</div>
    </section>
  );
}
