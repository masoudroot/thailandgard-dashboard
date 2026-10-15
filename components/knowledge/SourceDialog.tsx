"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button, Dialog, Field, Input, Select, SegmentedControl, Switch, Textarea } from "../ui";
import { TEAM_META } from "@/lib/team-meta";
import type { TeamName } from "@/lib/types";

/** نوع منبع، مطابق check دیتابیس (knowledge_sources.source_type). */
export type SourceType =
  | "official-doc"
  | "expert-blog"
  | "research"
  | "competitor"
  | "course"
  | "community"
  | "other";

/** داده‌ای که دیالوگ هنگام ذخیره برمی‌گرداند. */
export interface SourceFormData {
  id?: string;
  name: string;
  url: string;
  team: TeamName;
  type: SourceType;
  authority: 1 | 2 | 3;
  /** تناوب بازخوانی به ساعت؛ «دستی» یعنی عملاً هرگز خودکار بازخوانی نشود. */
  fetchFrequencyHours: number;
  notes: string;
  isActive: boolean;
}

export interface SourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** در حالت ویرایش پر می‌شود؛ خالی یعنی «افزودن». */
  initial?: SourceFormData | null;
  /** تیم ازپیش‌انتخاب‌شده (مثلاً از صفحه جزئیات تیم). */
  defaultTeam?: TeamName;
  onSave: (data: SourceFormData) => Promise<void>;
  saving?: boolean;
}

const TYPE_OPTIONS: { value: SourceType; label: string }[] = [
  { value: "official-doc", label: "داک رسمی" },
  { value: "expert-blog", label: "بلاگ تخصصی" },
  { value: "research", label: "مقاله پژوهشی" },
  { value: "competitor", label: "رقیب" },
  { value: "course", label: "دوره آموزشی" },
  { value: "community", label: "جامعه / انجمن" },
  { value: "other", label: "سایر" },
];

const REFRESH_OPTIONS: { value: string; label: string; hours: number }[] = [
  { value: "daily", label: "روزانه", hours: 24 },
  { value: "weekly", label: "هفتگی", hours: 168 },
  { value: "monthly", label: "ماهانه", hours: 720 },
  // «دستی» در دیتابیس معادل ندارد (fetch_frequency_hours > 0)؛
  // پس عددی می‌گذاریم که عملاً هرگز خودکار بازخوانی نشود (۱۰ سال).
  { value: "manual", label: "دستی", hours: 87600 },
];

const AUTHORITY_HINTS: Record<1 | 2 | 3, string> = {
  1: "منبع رسمی؛ بالاترین اعتبار",
  2: "بلاگ متخصص و پژوهشی",
  3: "سایر منابع",
};

const TEAM_OPTIONS = (Object.keys(TEAM_META) as TeamName[]).map((t) => ({
  value: t,
  label: TEAM_META[t].faName,
}));

function hoursToRefreshValue(hours: number): string {
  return REFRESH_OPTIONS.find((o) => o.hours === hours)?.value ?? "weekly";
}

function isValidUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const emptyForm = (defaultTeam?: TeamName): Omit<SourceFormData, "id"> => ({
  name: "",
  url: "",
  team: defaultTeam ?? ("" as TeamName),
  type: "expert-blog",
  authority: 2,
  fetchFrequencyHours: 168,
  notes: "",
  isActive: true,
});

export function SourceDialog({
  open,
  onOpenChange,
  initial,
  defaultTeam,
  onSave,
  saving = false,
}: SourceDialogProps) {
  const isEdit = Boolean(initial?.id);
  const [form, setForm] = React.useState<Omit<SourceFormData, "id">>(() => emptyForm(defaultTeam));
  const [errors, setErrors] = React.useState<Partial<Record<"name" | "url" | "team", string>>>({});
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  // هر بار باز شدن دیالوگ، فرم را از نو پر کن (حالت افزودن یا ویرایش).
  React.useEffect(() => {
    if (!open) return;
    if (initial) {
      setForm({
        name: initial.name,
        url: initial.url,
        team: initial.team,
        type: initial.type,
        authority: initial.authority,
        fetchFrequencyHours: initial.fetchFrequencyHours,
        notes: initial.notes,
        isActive: initial.isActive,
      });
    } else {
      setForm(emptyForm(defaultTeam));
    }
    setErrors({});
    setSubmitError(null);
  }, [open, initial, defaultTeam]);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (key === "name" || key === "url" || key === "team") {
      setErrors((e) => ({ ...e, [key]: undefined }));
    }
  };

  const validate = (): boolean => {
    const next: typeof errors = {};
    if (!form.name.trim()) next.name = "نام منبع را بنویس.";
    if (!form.url.trim()) {
      next.url = "نشانی اینترنتی را بنویس.";
    } else if (!isValidUrl(form.url)) {
      next.url = "این نشانی درست به نظر نمی‌رسد؛ باید با http:// یا https:// شروع شود.";
    }
    if (!form.team) next.team = "تیم را انتخاب کن.";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;
    setSubmitError(null);
    try {
      await onSave({
        ...(isEdit && initial?.id ? { id: initial.id } : {}),
        name: form.name.trim(),
        url: form.url.trim(),
        team: form.team,
        type: form.type,
        authority: form.authority,
        fetchFrequencyHours: form.fetchFrequencyHours,
        notes: form.notes.trim(),
        isActive: form.isActive,
      });
      onOpenChange(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "ذخیره نشد؛ دوباره تلاش کن.");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? "ویرایش منبع" : "افزودن منبع"}
      description={
        isEdit
          ? "مشخصات منبع دانش را به‌روزرسانی کن."
          : "یک منبع معتبر برای گردآوری دانش تیم ثبت کن."
      }
      footer={
        <>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            انصراف
          </Button>
          <Button type="submit" form="source-dialog-form" disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {isEdit ? "ذخیره تغییرات" : "ذخیره منبع"}
          </Button>
        </>
      }
    >
      <form id="source-dialog-form" onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
        <Field label="نام منبع" htmlFor="source-name">
          <Input
            id="source-name"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="مثلاً داک رسمی Next.js"
            error={errors.name}
            data-autofocus
          />
        </Field>

        <Field label="نشانی اینترنتی" htmlFor="source-url">
          <Input
            id="source-url"
            dir="ltr"
            inputMode="url"
            value={form.url}
            onChange={(e) => set("url", e.target.value)}
            placeholder="https://example.com/docs"
            error={errors.url}
            className="text-left"
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="تیم" htmlFor="source-team">
            <div className="space-y-1.5">
              <Select
                id="source-team"
                value={form.team}
                onChange={(e) => set("team", e.target.value as TeamName)}
                options={TEAM_OPTIONS}
                placeholder="انتخاب تیم"
                aria-invalid={errors.team ? true : undefined}
                className={errors.team ? "border-destructive/60" : undefined}
              />
              {errors.team && <p className="text-xs text-destructive">{errors.team}</p>}
            </div>
          </Field>

          <Field label="نوع منبع" htmlFor="source-type">
            <Select
              id="source-type"
              value={form.type}
              onChange={(e) => set("type", e.target.value as SourceType)}
              options={TYPE_OPTIONS}
            />
          </Field>
        </div>

        <Field
          label="درجه اعتبار"
          hint={AUTHORITY_HINTS[form.authority]}
        >
          <SegmentedControl
            fullWidth
            aria-label="درجه اعتبار منبع"
            value={String(form.authority)}
            onChange={(v) => set("authority", Number(v) as 1 | 2 | 3)}
            options={[
              { value: "1", label: "۱", "aria-label": "درجه ۱" },
              { value: "2", label: "۲", "aria-label": "درجه ۲" },
              { value: "3", label: "۳", "aria-label": "درجه ۳" },
            ]}
          />
        </Field>

        <Field label="تناوب بازخوانی" htmlFor="source-refresh">
          <Select
            id="source-refresh"
            value={hoursToRefreshValue(form.fetchFrequencyHours)}
            onChange={(e) => {
              const opt = REFRESH_OPTIONS.find((o) => o.value === e.target.value);
              if (opt) set("fetchFrequencyHours", opt.hours);
            }}
            options={REFRESH_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
        </Field>

        <Field label="توضیح" htmlFor="source-notes" hint="اختیاری؛ مثلاً این منبع برای چه چیزی به درد می‌خورد.">
          <Textarea
            id="source-notes"
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            placeholder="توضیح کوتاه…"
            rows={3}
          />
        </Field>

        <div className="flex items-center justify-between gap-3 rounded-field border border-border bg-muted/40 px-3 py-2.5">
          <div>
            <p className="text-sm font-medium">منبع فعال است</p>
            <p className="text-xs text-muted-foreground">منبع غیرفعال بازخوانی نمی‌شود.</p>
          </div>
          <Switch checked={form.isActive} onCheckedChange={(v) => set("isActive", v)} aria-label="فعال بودن منبع" />
        </div>

        {submitError && (
          <p role="alert" className="text-sm text-destructive">
            {submitError}
          </p>
        )}
      </form>
    </Dialog>
  );
}
