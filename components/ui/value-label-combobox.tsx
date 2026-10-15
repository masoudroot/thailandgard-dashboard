"use client";

import * as React from "react";
import { Combobox } from "./combobox";
import { cn } from "@/lib/utils";
import type { SelectOption } from "./Select";

export interface ValueLabelComboboxProps {
  /** گزینه‌ها با value جدا از label (مثل Select). */
  options: SelectOption[];
  /** value انتخاب‌شده (نه label). */
  value: string;
  /** امضا مثل Select بومی تا هندلرهای موجود دست نخورند. */
  onChange: (e: { target: { value: string } }) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  "aria-invalid"?: boolean | "true" | "false";
}

/**
 * آداپتر کمبوباکس وایب‌فارسی برای جاهایی که گزینه‌ها آبجکت {value,label} هستند.
 * value را به label نگاشت می‌کند و برعکس؛ remount با key باعث می‌شود
 * اگر value از بیرون عوض شد (مثلاً بعد از لود async یا حذف درگاه)،
 * متن نمایشی هم به‌روز شود.
 */
export function ValueLabelCombobox({
  options,
  value,
  onChange,
  placeholder,
  emptyText,
  disabled,
  className,
  "aria-invalid": ariaInvalid,
}: ValueLabelComboboxProps) {
  const labels = React.useMemo(() => options.map((o) => o.label), [options]);
  const shown = options.find((o) => o.value === value)?.label ?? "";

  function handlePick(pickedLabel: string) {
    const opt = options.find((o) => o.label === pickedLabel);
    onChange({ target: { value: opt ? opt.value : "" } });
  }

  const box = (
    <Combobox
      key={value}
      options={labels}
      value={shown}
      onChange={handlePick}
      placeholder={placeholder}
      emptyText={emptyText}
      className={className}
    />
  );

  if (!disabled && ariaInvalid == null) return box;
  return (
    <div
      aria-disabled={disabled || undefined}
      aria-invalid={ariaInvalid || undefined}
      className={cn(disabled && "pointer-events-none opacity-50")}
    >
      {box}
    </div>
  );
}
