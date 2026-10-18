/**
 * lib/teams/design-dup-guard.ts : نگهبان سفت ضدتکراری تیم design (سطح کد، نه پرامپت)
 *
 * زمینه (یافته): تیم design سه بار پیاپی خواست فایل
 * site/components/tour/thailand-tour-card.tsx را با action برابر create بسازد،
 * در حالی که کارت تور از قبل هست (site/components/site/TourCard.tsx و
 * site/components/tours/tour-card.tsx؛ ریشهٔ گیت: کامیت‌های b5e258f و 624a105
 * در ریپوی سایت که همین تکراری‌های مرده را پاک کردند).
 *
 * چرا نگهبان قبلی نگرفت؟
 * ۱. فهرست API گیت‌هاب در هر خطایی بی‌صدا [] برمی‌گشت و findDuplicate هیچ‌وقت
 *    چیزی برای مقایسه نداشت.
 * ۲. مقایسهٔ ریشهٔ نام فقط «برابری» را می‌گرفت: thailandtourcard با tourcard
 *    یکی نیست، پس گونهٔ پیشونددار (thailand-tour-card در برابر tour-card) رد می‌شد.
 * ۳. دلیل ردِ اعتبارسنجی هیچ‌وقت به پرامپت تلاش بعدی مجری برنمی‌گشت؛ هر سه تلاش
 *    با همان پرامپتِ بدون تغییر، همان اشتباه را تکرار می‌کرد (هدررفت توکن).
 *
 * این ماژول عمداً سبک است (بدون ایمپورت llm/github در سطح ماژول) تا در تست
 * مستقیم قابل فراخوانی باشد.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * ریشهٔ محلی ریپوی سایت برای نگهبان «فایل از قبل هست؟».
 * در پروداکشن (ورسل) این مسیر وجود ندارد و فقط فهرست API گیت‌هاب معیار است.
 * با THAILANDGARD_SITE_DIR می‌شود مسیر دیگری داد (تست و استقرار خاص).
 *
 * چون __dirname در باندل وب‌پک/اجرای مستقیم ممکن است جابه‌جا شود، چند نامزد
 * امتحان می‌شود و اولی که واقعاً دایرکتوری است انتخاب می‌شود؛ اگر هیچ‌کدام
 * نبود، نگهبان محلی بی‌صدا خاموش می‌ماند (fail-safe) و فقط API معیار است.
 */
function resolveSiteDir(): string {
  const envDir = process.env.THAILANDGARD_SITE_DIR?.trim();
  if (envDir) return envDir;
  const home = process.env.HOME?.trim() || '/home/hatch';
  // در ESM خالص __dirname تعریف نیست؛ typeof امن است.
  const here = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  const candidates = [
    path.resolve(here, '..', '..', '..', 'thailandgard', 'site'),
    path.resolve(process.cwd(), '..', 'thailandgard', 'site'),
    path.join(home, 'workspace', 'thailandgard', 'site'),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
      /* نامزد بعدی */
    }
  }
  return candidates[0];
}

export const SITE_LOCAL_DIR: string = resolveSiteDir();

/**
 * کلید قطع اضطراری ساخت کامپوننت تازه.
 * اگر هدررفت «create» ادامه پیدا کرد، با DESIGN_ALLOW_CREATE=false هر
 * action برابر create در همان اعتبارسنجی سرپرست رد می‌شود و فقط modify می‌ماند.
 * پیش‌فرض: true (ساخت تازه فقط با نگهبان سفت زیر).
 */
export const ALLOW_DESIGN_CREATE: boolean = process.env.DESIGN_ALLOW_CREATE !== 'false';

/** کمینهٔ اطلاعاتی که نگهبان از تصمیم سرپرست لازم دارد (بدون وابستگی به design.ts). */
export interface DupCheckComponent {
  filePath: string;
  action: 'create' | 'modify';
}

/** نرمال‌سازی مسیر پچ: trim و حذف اسلش‌های ابتدایی. */
export function normalizeSitePath(p: string): string {
  return String(p ?? '').trim().replace(/^\/+/, '');
}

/**
 * ریشهٔ نام فایل برای تشخیص تکراری: tour-card و TourCard هر دو می‌شوند tourcard.
 * (رفتار قدیمی؛ برای سازگاری نگه داشته شده. مقایسهٔ اصلی، توکنی است.)
 */
export function nameStem(p: string): string {
  const base = (p.split('/').pop() ?? '').replace(/\.tsx?$/, '');
  return base.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]/g, '');
}

/**
 * توکن‌های نام فایل: حروف کوچک، شکسته روی خط‌تیره/آندرلاین/فاصله و مرز camelCase.
 * thailand-tour-card.tsx می‌شود [thailand, tour, card] و TourCard.tsx می‌شود [tour, card].
 */
export function pathTokens(p: string): string[] {
  const base = (p.split('/').pop() ?? '').replace(/\.tsx?$/, '');
  return base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9\u0600-\u06ff]+/g)
    .filter(Boolean);
}

/** آیا ریپوی محلی سایت در دسترس است؟ */
export function isLocalSiteAvailable(): boolean {
  try {
    fs.realpathSync(SITE_LOCAL_DIR);
    return true;
  } catch {
    return false;
  }
}

/**
 * آیا این مسیر (با پیشوند site/) دقیقاً در ریپوی محلی سایت هست؟
 * مسیرهای بیرون از site/ یا حاوی .. همیشه false.
 */
export function localSiteFileExists(siteRelPath: string): boolean {
  const p = normalizeSitePath(siteRelPath);
  if (!p.startsWith('site/')) return false;
  let root: string;
  try {
    root = fs.realpathSync(SITE_LOCAL_DIR);
  } catch {
    return false; // ریپوی محلی در دسترس نیست؛ نگهبان محلی ساکت می‌ماند
  }
  const full = path.resolve(root, p.slice('site/'.length));
  if (full !== root && !full.startsWith(root + path.sep)) return false;
  try {
    return fs.statSync(full).isFile();
  } catch {
    return false;
  }
}

/**
 * فهرست فایل‌های site/components از ریپوی محلی (جایگزین فهرست API وقتی
 * گیت‌هاب در دسترس نیست). خروجی با همان قالب فهرست API: site/components/...
 */
export function listLocalSiteComponents(): string[] {
  const out: string[] = [];
  let root: string;
  try {
    root = fs.realpathSync(SITE_LOCAL_DIR);
  } catch {
    return [];
  }
  const start = path.join(root, 'components');
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, relPath);
      else if (e.isFile() && /\.tsx?$/.test(e.name)) out.push(`site/components/${relPath}`);
    }
  };
  walk(start, '');
  return out;
}

/** پیام استاندارد ردِ ساختِ تکراری؛ عمداً دستوری تا در چرخهٔ اصلاح به LLM برگردد. */
function createRejectedMessage(fp: string, existing: string, why: string): string {
  return (
    `فایل ${fp} ${why}: ${existing}. ` +
    `File already exists. Use modify action, not create. ` +
    `همان فایل موجود را با action برابر modify بهبود بده؛ ساخت دوباره‌اش ممنوع است.`
  );
}

/**
 * نگهبان سفت ضدتکراری برای action برابر create.
 *
 * سه لایه (هر کدام مستقل):
 * ۱. مسیر دقیق در فهرست داده‌شده (API یا محلی)؛
 * ۲. مسیر دقیق در ریپوی محلی سایت (~/workspace/thailandgard/site)؛
 * ۳. توکن‌های نام: اگر همهٔ توکن‌های یک فایل موجود زیرمجموعهٔ توکن‌های نام تازه
 *    باشند، یعنی همان کامپوننت با پیشوند/پسوند تازه (مثل thailand-tour-card در
 *    برابر tour-card یا TourCard)؛ تکراری است. به‌علاوه ریشهٔ نام قدیمی.
 *
 * برمی‌گرداند: null (تازه و مجاز) یا رشتهٔ دلیل رد (دستوری، آمادهٔ تزریق به پرامپت).
 * برای action برابر modify همیشه null (این نگهبان فقط ساخت تازه را می‌پاید).
 */
export function findDuplicate(
  component: DupCheckComponent,
  siteFiles: string[],
): string | null {
  const fp = normalizeSitePath(component.filePath);
  if (!fp) return 'مسیر فایل کامپوننت خالی است';
  if (component.action !== 'create') return null;

  // لایه ۱: مسیر دقیق در فهرست
  for (const f of siteFiles) {
    if (f === fp) {
      return createRejectedMessage(fp, f, 'از قبل وجود دارد');
    }
  }

  // لایه ۲: مسیر دقیق در ریپوی محلی سایت
  if (localSiteFileExists(fp)) {
    return createRejectedMessage(fp, fp, 'در ریپوی سایت از قبل وجود دارد');
  }

  // لایه ۳: مشابهت توکنی زیر site/components
  const newTokens = pathTokens(fp);
  const newSet = new Set(newTokens);
  if (newSet.size > 0) {
    for (const f of siteFiles) {
      if (!/\.tsx?$/.test(f)) continue;
      if (!f.startsWith('site/components/')) continue;
      const oldTokens = pathTokens(f);
      if (oldTokens.length === 0) continue;
      if (oldTokens.every((t) => newSet.has(t))) {
        return (
          `کامپوننت مشابه از قبل وجود دارد: ${f} ` +
          `(توکن‌های «${oldTokens.join('، ')}» زیرمجموعهٔ نام تازه است). ` +
          `File already exists under a variant name. Use modify action, not create. ` +
          `همان فایل ${f} را با action برابر modify بهبود بده؛ ساخت فایل تازه با نام مشابه ممنوع است.`
        );
      }
    }
    // ریشهٔ نام قدیمی (پوشش حالت‌هایی مثل card2 در برابر card-2)
    const stem = nameStem(fp);
    for (const f of siteFiles) {
      if (nameStem(f) === stem) {
        return (
          `کامپوننت مشابه از قبل وجود دارد: ${f} (ریشهٔ نام «${stem}» تکراری است). ` +
          `Use modify action, not create. همان را با action برابر modify بهبود بده.`
        );
      }
    }
  }
  return null;
}
