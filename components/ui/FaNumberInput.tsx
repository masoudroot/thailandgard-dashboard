"use client";

import * as React from "react";
import { NumberField } from "./number-field";
import { cleanNumberInput } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface FaNumberInputProps {
  /** مقدار لاتینِ تمیز (رشته ارقام) یا عدد. */
  value: string | number;
  /** همیشه با ارقام لاتینِ تمیز صدا زده می‌شود. */
  onChange: (value: string) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  id?: string;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
  onBlur?: (e: React.FocusEvent<HTMLElement>) => void;
}

/**
 * ورودی عددی فارسی، بر پایهٔ NumberField رجیستری وایب‌فارسی.
 * ارقام فارسی/عربی/لاتین را می‌پذیرد، همیشه فارسی نمایش می‌دهد (با دکمه‌های
 * کم/زیاد رجیستری) و مقدار لاتینِ تمیز تحویل می‌دهد تا Number() و ذخیره درست
 * کار کنند. API با نسخهٔ قبلی سازگار است.
 */
export function FaNumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  id,
  placeholder,
  className,
  onBlur,
  "aria-label": ariaLabel,
}: FaNumberInputProps) {
  const latin = cleanNumberInput(String(value ?? ""));
  const numeric = latin === "" ? 0 : Number(latin);
  const rootRef = React.useRef<HTMLSpanElement>(null);

  // NumberField رجیستری ورودیِ کنترل‌شدهٔ عددی است: همیشه عدد نشان می‌دهد و
  // id/placeholder نمی‌پذیرد. این همگام‌سازی آن‌ها را روی ورودیِ درونی
  // می‌نشاند و حالت «خالی» را هم واقعاً خالی نگه می‌دارد (به‌جای نمایش ۰).
  React.useEffect(() => {
    const input = rootRef.current?.querySelector("input");
    if (!input) return;
    if (id !== undefined) input.id = id;
    if (placeholder !== undefined) input.placeholder = placeholder;
    input.autocomplete = "off";
    if (latin === "") input.value = "";
  });

  function handleChange(n: number) {
    // در لحظهٔ فراخوانی، DOM هنوز متن خام کاربر را دارد (ری‌رندرِ بعدی مقدار
    // نمایشی را می‌سازد)؛ پس پاک‌شدن کامل فیلد را از همین‌جا تشخیص می‌دهیم
    // تا مثل قبل، رشتهٔ خالی به والد برگردد نه «0».
    const raw = rootRef.current?.querySelector("input")?.value;
    if (raw === "" && n === 0) {
      onChange("");
      return;
    }
    onChange(String(n));
  }

  function handleBlur(e: React.FocusEvent<HTMLSpanElement>) {
    // جابه‌جایی فوکوس بین ورودی و دکمه‌های کم/زیاد، «خروج از فیلد» نیست
    if (e.relatedTarget instanceof Node && rootRef.current?.contains(e.relatedTarget)) return;
    onBlur?.(e);
  }

  return (
    <span ref={rootRef} onBlur={handleBlur} className={cn("inline-flex", className)}>
      <NumberField
        value={numeric}
        onChange={handleChange}
        min={min ?? -Infinity}
        max={max ?? Infinity}
        step={step}
        disabled={disabled}
        aria-label={ariaLabel}
      />
    </span>
  );
}
