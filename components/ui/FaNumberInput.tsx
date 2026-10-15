"use client";

import * as React from "react";
import { Input, type InputProps } from "./Input";
import { faDigits, cleanNumberInput } from "@/lib/format";

export interface FaNumberInputProps extends Omit<InputProps, "type" | "value" | "onChange" | "inputMode"> {
  /** مقدار لاتینِ تمیز (رشته ارقام). */
  value: string | number;
  /** همیشه با ارقام لاتینِ تمیز صدا زده می‌شود. */
  onChange: (value: string) => void;
  min?: number;
  max?: number;
}

/**
 * ورودی عددی فارسی. ارقام فارسی/عربی/لاتین را می‌پذیرد، همیشه فارسی نمایش
 * می‌دهد و مقدار لاتینِ تمیز تحویل می‌دهد تا Number() و ذخیره درست کار کنند.
 * بر پایهٔ Input رجیستری وایب‌فارسی.
 */
export function FaNumberInput({ value, onChange, min, max, onBlur, ...props }: FaNumberInputProps) {
  const latin = cleanNumberInput(String(value ?? ""));

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    let next = cleanNumberInput(e.target.value);
    // حذف صفرهای اضافی ابتدای عدد (به‌جز خود صفر)
    if (next.length > 1) next = next.replace(/^0+/, "") || "0";
    onChange(next);
  }

  function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    // اعمال سقف کران در خروج از فیلد
    if (latin !== "") {
      const n = Number(latin);
      if (typeof min === "number" && n < min) onChange(String(min));
      else if (typeof max === "number" && n > max) onChange(String(max));
    }
    onBlur?.(e);
  }

  return (
    <Input
      type="text"
      inputMode="numeric"
      dir="ltr"
      autoComplete="off"
      value={faDigits(latin)}
      onChange={handleChange}
      onBlur={handleBlur}
      {...props}
    />
  );
}
