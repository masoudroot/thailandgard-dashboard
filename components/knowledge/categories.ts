/**
 * تایپ مشترک دستهٔ دانش یک تیم (مطابق قرارداد پروژه دانش و پاسخ GET /api/knowledge/[team]).
 */
export type KnowledgeCategory = {
  id: string;
  name: string;
  parent_id: string | null;
  created_at?: string;
};

/** گرهٔ درختی: دسته به‌همراه فرزندان مستقیم. */
export type CategoryTreeNode = KnowledgeCategory & {
  children: CategoryTreeNode[];
};

/**
 * فهرست تخت دسته‌ها را به درخت تبدیل می‌کند (ریشه‌ها: parent_id تهی).
 * فرزندهایی که والدشان در فهرست نیست، ریشه حساب می‌شوند (ایمن در برابر دادهٔ ناقص).
 */
export function buildCategoryTree(categories: KnowledgeCategory[]): CategoryTreeNode[] {
  const byId = new Map<string, CategoryTreeNode>();
  for (const c of categories) {
    byId.set(c.id, { ...c, children: [] });
  }
  const roots: CategoryTreeNode[] = [];
  for (const node of Array.from(byId.values())) {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * واکشی دسته‌های یک تیم از API تیم ۱۱.
 * قرارداد: GET /api/knowledge/categories?team=...
 * اگر API هنوز نیست، خطای فارسی برمی‌گرداند (بدون دادهٔ نمایشی).
 */
export async function fetchCategories(team: string): Promise<KnowledgeCategory[]> {
  const res = await fetch(`/api/knowledge/categories?team=${encodeURIComponent(team)}`, {
    credentials: "same-origin",
  });
  const json = (await res.json().catch(() => null)) as
    | { ok: boolean; data?: unknown; error?: { message?: string } }
    | null;
  if (!res.ok || !json?.ok) {
    throw new Error(json?.error?.message || "بارگذاری دسته‌ها ناموفق بود.");
  }
  const data = json.data;
  if (Array.isArray(data)) return data as KnowledgeCategory[];
  if (data && typeof data === "object" && Array.isArray((data as { categories?: unknown }).categories)) {
    return (data as { categories: KnowledgeCategory[] }).categories;
  }
  throw new Error("پاسخ سرور شکل غیرمنتظره‌ای داشت.");
}
