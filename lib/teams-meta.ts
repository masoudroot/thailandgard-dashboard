/** نام فارسی و مأموریت یک‌خطی تیم‌ها (مشترک بین صفحه‌های داشبورد). */
import type { TeamName } from './types';

export const TEAM_META: Record<TeamName, { faName: string; mission: string }> = {
  leader: { faName: 'رهبر', mission: 'ساخت بک‌لاگ از داده، تخصیص به سازنده‌ها، چک ساده و یادگیری' },
  artdir: { faName: 'طراحی ارشد', mission: 'نگاه کلی و هدایت هنری کل پروژه' },
  branding: { faName: 'برند', mission: 'هویت برند، لحن و شخصیت تایلندگرد' },
  content: { faName: 'محتوا', mission: 'متن‌ها و پیام‌های اصلی صفحه‌ها' },
  seo: { faName: 'سئو', mission: 'بهینه‌سازی فنی و ساختار برای گوگل' },
  analytics: { faName: 'تحلیل', mission: 'داده‌ها، معیارها و سنجش عملکرد' },
  intel: { faName: 'اطلاعات', mission: 'رصد بازار، رقبا و روندها' },
  lead: { faName: 'لید', mission: 'ایده‌های تبدیل بازدیدکننده به درخواست' },
  design: { faName: 'دیزاین', mission: 'چیدمان، ظاهر و تجربه صفحه‌ها' },
  seocontent: { faName: 'محتوای سئو', mission: 'محتوای هدفمند برای رتبه گوگل' },
  vibefarsi: { faName: 'وایب‌فارسی', mission: 'کامپوننت‌های فارسی استاندارد' },
  farsiui: { faName: 'فارسی UI', mission: 'راست‌چین و جزئیات رابط فارسی' },
  'design-ir': { faName: 'دیزاین ایرانی', mission: 'بومی‌سازی طرح برای سلیقه ایرانی' },
  dev: { faName: 'توسعه', mission: 'پیاده‌سازی فنی و کد تمیز' },
  qa: { faName: 'کیفیت', mission: 'آزمون، کنترل کیفیت و رفع ایراد' },
  inspector: { faName: 'بازرس', mission: 'بازبینی نهایی و گزارش سلامت چرخه' },
};

export function teamFaName(team: TeamName): string {
  return TEAM_META[team]?.faName ?? team;
}
