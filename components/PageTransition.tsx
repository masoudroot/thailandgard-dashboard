"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

/**
 * ترنزیشن بین صفحات داشبورد: با عوض شدن مسیر، محتوا دوباره سوار می‌شود و
 * انیمیشن tg-page-enter (محو و لغزش کوتاه) اجرا می‌شود.
 * لی‌اوت ثابت می‌ماند، فقط محتوای صفحه جان می‌گیرد.
 */
export default function PageTransition({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div key={pathname} className="tg-page-enter">
      {children}
    </div>
  );
}
