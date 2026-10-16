/**
 * lib/github-teams.ts - کمک‌کننده‌های مشترک استخراج تیم از پیام کامیت.
 *
 * قرارداد تیم‌ها: پیام کامیت با پیشوند [team] شروع می‌شود، مثل [dev] رفع باگ لاگین.
 * این فایل pure است و هم در سرور (API) و هم در کلاینت (صفحه) قابل استفاده است.
 */

import type { TeamName } from './types';

/** برچسب فارسی تیم‌های شناخته‌شدهٔ داشبورد. */
export const TEAM_FA: Record<TeamName, string> = {
  leader: 'رهبر',
  artdir: 'مدیریت هنری',
  branding: 'برندینگ',
  content: 'محتوا',
  seo: 'سئو',
  analytics: 'تحلیل داده',
  intel: 'هوشمندی',
  lead: 'سرنخ',
  design: 'طراحی',
  seocontent: 'محتوای سئو',
  vibefarsi: 'وایب‌فارسی',
  farsiui: 'رابط فارسی',
  'design-ir': 'طراحی ایرانی',
  dev: 'توسعه',
  qa: 'کنترل کیفیت',
  inspector: 'بازرس',
};

export const ALL_TEAM_SLUGS: TeamName[] = [
  'artdir',
  'branding',
  'content',
  'seo',
  'analytics',
  'intel',
  'lead',
  'design',
  'seocontent',
  'vibefarsi',
  'farsiui',
  'design-ir',
  'dev',
  'qa',
  'inspector',
];

/** برچسب نمایشی یک اسلاگ تیم؛ ناشناخته‌ها همان اسلاگ را نشان می‌دهند. */
export function teamFa(slug: string): string {
  return (TEAM_FA as Record<string, string>)[slug] ?? slug;
}

/**
 * استخراج اسلاگ تیم از ابتدای پیام کامیت.
 * الگو: ‎[slug]‎ در ابتدای خط اول؛ مثل ‎[dev]‎.
 * برمی‌گرداند: اسلاگ کوچک‌شده، یا null اگر پیشوندی نباشد.
 */
export function extractTeamSlug(message: string): string | null {
  const firstLine = message.split('\n', 1)[0].trim();
  const m = /^\[([A-Za-z0-9][\w-]*)\]/.exec(firstLine);
  return m ? m[1].toLowerCase() : null;
}

/** خط اول پیام بدون پیشوند تیم (برای نمایش تمیز عنوان). */
export function titleWithoutPrefix(message: string): string {
  const firstLine = message.split('\n', 1)[0].trim();
  return firstLine.replace(/^\[[A-Za-z0-9][\w-]*\]\s*/, '').trim() || firstLine;
}
