'use client';

import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { faNum } from '@/lib/format';
import { Button } from '@/components/ui/Button';

/**
 * هوک «نمایش بیشتر» برای لیست‌های بلند سمت کاربر:
 * visible تعداد آیتم‌های قابل نمایش، hasMore یعنی آیتمِ دیده‌نشده مانده است.
 * resetKey با عوض شدن (مثلاً عوض شدن تب فیلتر) شمارش را به حالت اول برمی‌گرداند.
 */
export function useVisibleCount(total: number, pageSize: number, resetKey?: unknown) {
  const [count, setCount] = useState(pageSize);

  useEffect(() => {
    setCount(pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize, resetKey]);

  const visible = Math.min(count, total);
  return {
    visible,
    hasMore: visible < total,
    showMore: () => setCount((c) => Math.min(c + pageSize, total)),
  };
}

interface LoadMoreProps {
  visible: number;
  total: number;
  onShowMore: () => void;
}

/**
 * دکمهٔ تمیز «نمایش بیشتر» با شمارندهٔ «نمایش X از Y»؛
 * جایگزین صفحه‌بندی شماره‌ای برای لیست‌های سمت کاربر.
 */
export default function LoadMore({ visible, total, onShowMore }: LoadMoreProps) {
  return (
    <div className="mt-6 flex flex-col items-center gap-3">
      <p className="text-xs text-muted-foreground" aria-live="polite">
        نمایش {faNum(visible)} از {faNum(total)}
      </p>
      <Button variant="outline" onClick={onShowMore}>
        <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
        نمایش بیشتر
      </Button>
    </div>
  );
}
