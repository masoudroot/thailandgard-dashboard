"use client";

import * as React from "react";
import { ValueLabelCombobox } from "../ui/value-label-combobox";
import { Field } from "../ui/Input";
import { fetchCategories, type KnowledgeCategory } from "./categories";

export type CategoryPickerProps = {
  /** slug تیم؛ دسته‌ها از API تیم ۱۱ برای همین تیم خوانده می‌شوند. */
  team: string;
  /** id دستهٔ انتخاب‌شده؛ تهی یعنی «بدون دسته». */
  value: string | null;
  onChange: (id: string | null) => void;
  label?: string;
  hint?: string;
  error?: string;
  disabled?: boolean;
  /**
   * id دسته‌ای که نباید انتخاب شود (به‌همراه زیرمجموعه‌هایش)؛
   * برای جلوگیری از چرخه هنگام ویرایش والد.
   */
  excludeId?: string | null;
  /** برچسب گزینهٔ تهی. */
  emptyLabel?: string;
};

function excludedIds(
  categories: KnowledgeCategory[],
  rootId: string | null | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!rootId) return out;
  const childrenOf = new Map<string, string[]>();
  for (const c of categories) {
    if (c.parent_id) {
      const list = childrenOf.get(c.parent_id) ?? [];
      list.push(c.id);
      childrenOf.set(c.parent_id, list);
    }
  }
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (out.has(id)) continue;
    out.add(id);
    for (const child of childrenOf.get(id) ?? []) stack.push(child);
  }
  return out;
}

function indentedName(name: string, depth: number): string {
  // عمق با پیشوند «↳» در هر سطح نشان داده می‌شود تا سلسله‌مراتب دیده شود.
  return depth === 0 ? name : `${"↳ ".repeat(depth)}${name}`;
}

/**
 * سلکت انتخاب دسته با نمایش سلسله‌مراتب (درخت اندنت‌شده).
 * دسته‌ها را خودش از `/api/knowledge/categories` می‌خواند.
 */
export function CategoryPicker({
  team,
  value,
  onChange,
  label = "دسته",
  hint,
  error,
  disabled,
  excludeId,
  emptyLabel = "بدون دسته",
}: CategoryPickerProps) {
  const [categories, setCategories] = React.useState<KnowledgeCategory[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    fetchCategories(team)
      .then((list) => {
        if (alive) setCategories(list);
      })
      .catch((e: Error) => {
        if (alive) setLoadError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [team]);

  const depthOf = React.useMemo(() => {
    const depth = new Map<string, number>();
    const byId = new Map(categories.map((c) => [c.id, c]));
    for (const c of categories) {
      let d = 0;
      let cur = c.parent_id;
      const seen = new Set<string>();
      while (cur && byId.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        d += 1;
        cur = byId.get(cur)?.parent_id ?? null;
      }
      depth.set(c.id, d);
    }
    return depth;
  }, [categories]);

  const hidden = React.useMemo(() => excludedIds(categories, excludeId), [categories, excludeId]);

  const ordered = React.useMemo(() => {
    const byId = new Map(categories.map((c) => [c.id, c]));
    const roots = categories.filter((c) => !c.parent_id || !byId.has(c.parent_id));
    const out: KnowledgeCategory[] = [];
    const walk = (c: KnowledgeCategory) => {
      if (hidden.has(c.id)) return;
      out.push(c);
      for (const child of categories.filter((x) => x.parent_id === c.id)) walk(child);
    };
    for (const r of roots) walk(r);
    // گره‌های یتیمِ خارج از درخت
    for (const c of categories) {
      if (!out.includes(c) && !hidden.has(c.id)) out.push(c);
    }
    return out;
  }, [categories, hidden]);

  const effectiveError = error ?? loadError ?? undefined;

  return (
    <Field label={label} hint={effectiveError ? undefined : hint}>
      <ValueLabelCombobox
        disabled={disabled || loading}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        aria-invalid={effectiveError ? true : undefined}
        options={[
          { value: "", label: emptyLabel },
          ...ordered.map((c) => ({
            value: c.id,
            label: indentedName(c.name, depthOf.get(c.id) ?? 0),
          })),
        ]}
      />
      {effectiveError && (
        <p role="alert" className="text-xs leading-5 text-destructive">
          {effectiveError}
        </p>
      )}
    </Field>
  );
}
