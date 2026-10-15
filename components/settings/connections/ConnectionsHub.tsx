"use client";

import { Plug } from "lucide-react";
import { SupabasePanel } from "./SupabasePanel";
import { TelegramPanel } from "./TelegramPanel";
import { GithubPanel } from "./GithubPanel";
import { LlmPanel } from "./LlmPanel";
import { MarketPanel } from "./MarketPanel";
import { AdminPasswordPanel } from "./AdminPasswordPanel";

/**
 * هاب اتصال‌ها: یک بخش یکپارچه در بالای تنظیمات.
 * هر اتصال یک ردیف آکاردئونی است: یک خط وضعیت + فرم بازشونده + راهنمای جمع‌شونده.
 * «منابع داده بازار» بخش مستقلی پایین‌تر است (پیشنهادهای کاربر، نه اتصال فنی).
 */
export function ConnectionsHub() {
  return (
    <>
      <section aria-labelledby="connections-hub-title" className="mb-6">
        <div className="mb-3 flex items-center gap-2">
          <Plug size={18} strokeWidth={1.75} aria-hidden="true" className="text-brand" />
          <h2 id="connections-hub-title" className="text-base font-bold text-foreground">
            اتصال‌ها
          </h2>
        </div>
        <p className="mb-4 text-xs leading-6 text-muted-foreground">
          همه چیزهایی که داشبورد برای کار کردن لازم دارد، اینجاست.
          هر ردیف را باز کنید، وارد کنید، تست کنید.
        </p>
        <div className="space-y-3">
          <SupabasePanel />
          <TelegramPanel />
          <GithubPanel />
          <LlmPanel />
          <AdminPasswordPanel />
        </div>
      </section>
      <section aria-labelledby="market-sources-title" className="mb-6">
        <MarketPanel />
      </section>
    </>
  );
}
