'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BookOpen } from 'lucide-react';
import { isNavActive } from '@/components/Nav';

const HREF = '/dashboard/knowledge';

/**
 * لینک «دانش» در هدر داشبورد (موبایل و دسکتاپ).
 * ناوبری اصلی در components/Nav.tsx دست نخورده مانده و این لینک
 * فقط از layout داشبورد رندر می‌شود.
 */
export default function KnowledgeNavLink() {
  const pathname = usePathname();
  const active = isNavActive(pathname, HREF);

  return (
    <Link
      href={HREF}
      aria-current={active ? 'page' : undefined}
      className={[
        'flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium leading-6 transition-colors duration-200 motion-reduce:transition-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'bg-brand/10 text-brand'
          : 'text-foreground/80 hover:bg-accent hover:text-foreground',
      ].join(' ')}
    >
      <BookOpen
        className="h-5 w-5"
        strokeWidth={active ? 2 : 1.5}
        aria-hidden="true"
      />
      <span>دانش</span>
    </Link>
  );
}
