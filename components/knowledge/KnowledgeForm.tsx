"use client";

import * as React from "react";
import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { Modal, Button, Input, Select, Field, Textarea, cx } from "../ui";

export type KnowledgeCategoryOption = {
  id: string;
  name: string;
};

export type KnowledgeInitialData = {
  id: string;
  title: string;
  content: string;
  category_id?: string | null;
  source?: string | null;
};

export type KnowledgeSavedItem = {
  id: string;
  title: string;
  content: string;
  category_id?: string | null;
  source?: string | null;
};

export type CategoryPickerProps = {
  value: string;
  onChange: (categoryId: string) => void;
  disabled?: boolean;
};

export type KnowledgeFormProps = {
  /** مودال باز است یا نه (با صفحهٔ تیم ۶ هماهنگ شده). */
  open: boolean;
  /** بستن مودال. */
  onClose: () => void;
  /** بعد از ذخیرهٔ موفق صدا زده می‌شود (آیتم ذخیره‌شده برمی‌گرداند). */
  onSaved?: (item: KnowledgeSavedItem) => void;
  /** اسلاگ تیم (بدنهٔ POST)؛ در حالت ویرایش استفاده نمی‌شود. */
  team: string;
  /** حالت ویرایش: پر کردن فرم با دادهٔ موجود و PUT به /api/knowledge/[id]. */
  initialData?: KnowledgeInitialData | null;
  /** گزینه‌های دسته برای سلکت ساده؛ تا وقتی CategoryPicker تیم ۷ آمد، این به کار می‌رود. */
  categories?: KnowledgeCategoryOption[];
  /**
   * نقطهٔ اتصال CategoryPicker تیم ۷.
   * اگر داده شد، جای سلکت ساده می‌نشیند.
   */
  categoryPicker?: (props: CategoryPickerProps) => React.ReactNode;
};

const ERR_TITLE = "عنوان را وارد کنید.";
const ERR_CONTENT = "متن دانش را بنویسید.";
const ERR_SERVER = "ذخیره نشد. اتصال را بررسی کنید و دوباره تلاش کنید.";

/**
 * فرم افزودن/ویرایش دانش تیم‌ها.
 *
 * - حالت ساخت: `POST /api/knowledge` با بدنهٔ {team, title, content, category_id?, source?}
 * - حالت ویرایش: `PUT /api/knowledge/[id]` با بدنهٔ {title, content, category_id?, source?}
 * همهٔ پاسخ‌ها با الگوی `ok/fail` قرارداد (`lib/api.ts`) خوانده می‌شوند.
 * فیلد دسته پیش‌فرض سلکت ساده است؛ وقتی CategoryPicker تیم ۷ آماده شد،
 * از prop‏ `categoryPicker` تزریق می‌شود بدون تغییر این کامپوننت.
 */
export function KnowledgeForm({
  open,
  onClose,
  onSaved,
  team,
  initialData = null,
  categories = [],
  categoryPicker,
}: KnowledgeFormProps) {
  const isEdit = initialData != null;

  const [title, setTitle] = React.useState("");
  const [content, setContent] = React.useState("");
  const [categoryId, setCategoryId] = React.useState("");
  const [source, setSource] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [savedFlash, setSavedFlash] = React.useState(false);

  // باز شدن مودال: ریست/پرکردن فرم بر اساس حالت.
  React.useEffect(() => {
    if (!open) return;
    setTitle(initialData?.title ?? "");
    setContent(initialData?.content ?? "");
    setCategoryId(initialData?.category_id ?? "");
    setSource(initialData?.source ?? "");
    setTouched(false);
    setServerError(null);
    setSavedFlash(false);
  }, [open, initialData]);

  const titleError = touched && title.trim() === "" ? ERR_TITLE : undefined;
  const contentError = touched && content.trim() === "" ? ERR_CONTENT : undefined;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    setServerError(null);
    if (title.trim() === "" || content.trim() === "") return;

    setSaving(true);
    try {
      const body = {
        title: title.trim(),
        content: content.trim(),
        category_id: categoryId === "" ? null : categoryId,
        source: source.trim() === "" ? null : source.trim(),
      };
      const url = isEdit
        ? `/api/knowledge/${encodeURIComponent(initialData!.id)}`
        : "/api/knowledge";
      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isEdit ? body : { ...body, team },
        ),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: true; data?: KnowledgeSavedItem }
        | { ok: false; error?: { message?: string } }
        | null;
      if (!json || json.ok !== true) {
        const msg =
          json && json.ok === false && json.error?.message
            ? json.error.message
            : ERR_SERVER;
        setServerError(msg);
        return;
      }
      const saved: KnowledgeSavedItem = {
        id:
          json.data?.id ??
          (isEdit ? initialData!.id : ""),
        title: body.title,
        content: body.content,
        category_id: body.category_id,
        source: body.source,
      };
      setSavedFlash(true);
      onSaved?.(saved);
      // پیام موفقیت کوتاه، بعد مودال بسته می‌شود.
      window.setTimeout(() => {
        if (open) onClose();
      }, 900);
    } catch {
      setServerError(ERR_SERVER);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={isEdit ? "ویرایش دانش" : "افزودن دانش"}
      description={
        isEdit
          ? "تغییرات را اعمال کنید؛ نسخهٔ قبلی در تاریخچه ثبت می‌شود."
          : "دانش تازه‌ای برای این تیم ثبت کنید؛ بعد از ذخیره، در جست‌وجو ایندکس می‌شود."
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            انصراف
          </Button>
          <Button
            type="submit"
            form="knowledge-form"
            disabled={saving}
            aria-busy={saving || undefined}
          >
            {saving && (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            {isEdit ? "ذخیرهٔ تغییرات" : "ثبت دانش"}
          </Button>
        </>
      }
    >
      <form id="knowledge-form" onSubmit={handleSubmit} noValidate>
        <div className="flex flex-col gap-4">
          {savedFlash && (
            <p
              role="status"
              className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm leading-6 text-emerald-700 dark:text-emerald-300"
            >
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              {isEdit ? "تغییرات ذخیره شد." : "دانش ذخیره شد."}
            </p>
          )}
          {serverError && (
            <p
              role="alert"
              className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm leading-6 text-destructive"
            >
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {serverError}
            </p>
          )}

          <Field label="عنوان">
            <Input
              placeholder="مثلاً: تعریف نهایی لحن برند تایلندگرد"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              error={titleError}
              autoComplete="off"
              maxLength={200}
            />
          </Field>

          <div className="w-full">
            <label
              htmlFor="knowledge-content"
              className="mb-1.5 block text-sm font-medium leading-6 text-foreground"
            >
              متن دانش
            </label>
            <Textarea
              id="knowledge-content"
              rows={8}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              aria-invalid={contentError ? true : undefined}
              aria-describedby={contentError ? "knowledge-content-error" : undefined}
              placeholder="متن کامل دانش را این‌جا بنویسید. هر چه دقیق‌تر و ساخت‌یافته‌تر، پاسخ‌های بهتری می‌گیرید."
              className={cx(
                "min-h-40 text-base leading-7 sm:text-sm",
                contentError && "border-destructive focus:border-destructive focus:ring-destructive/30",
              )}
            />
            {contentError && (
              <p
                id="knowledge-content-error"
                role="alert"
                className="mt-1.5 text-xs leading-5 text-destructive"
              >
                {contentError}
              </p>
            )}
            {!contentError && (
              <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                {"می‌توانید چند پاراگراف بنویسید؛ خط‌های خالی حفظ می‌شود."}
              </p>
            )}
          </div>

          {categoryPicker ? (
            <div className="w-full">
              <span className="mb-1.5 block text-sm font-medium leading-6 text-foreground">
                دسته
              </span>
              {categoryPicker({
                value: categoryId,
                onChange: setCategoryId,
                disabled: saving,
              })}
            </div>
          ) : (
            <Field label="دسته (اختیاری)">
              <Select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                disabled={saving}
                placeholder="بدون دسته"
                options={categories.map((c) => ({ value: c.id, label: c.name }))}
              />
            </Field>
          )}

          <Field
            label="منبع (اختیاری)"
            hint="لینک یا توضیح کوتاهی که نشان دهد این دانش از کجا آمده."
          >
            <Input
              placeholder="مثلاً: سند برند، صفحهٔ ۱۲ یا https://…"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              autoComplete="off"
              maxLength={500}
            />
          </Field>
        </div>
      </form>
    </Modal>
  );
}
