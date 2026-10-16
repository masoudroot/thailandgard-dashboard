/**
 * lib/bridge/pre-merge-check.ts — بررسی تایپ پیش از مرج پچ به dev.
 *
 * مشکل: پچ تیم dev فایل site/lib/utils.ts را بازنویسی کرد و توابع fa/en/faNumber
 * را حذف کرد؛ ۲۰ فایل به آن‌ها وابسته بودند و بیلد شکست. دروازه کیفیت فقط
 * سینتکس را چک می‌کند، نه تایپ کامل پروژه را.
 *
 * راه‌حل: پیش از مرج، پچ روی یک کلون تازه از ریپوی سایت اعمال و tsc اجرا می‌شود.
 * اگر خطا داشت، پچ برمی‌گردد و به تیم بازخورد داده می‌شود.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const execFileAsync = promisify(execFile);

export interface PreMergeCheckResult {
  passed: boolean;
  /** خطاهای تایپ‌اسکریپت (فارسی‌نشده، خام برای دیباگ). */
  errors: string[];
  /** پیام فارسی خلاصه. */
  message: string;
}

/** حداکثر زمان مجاز برای کلون سبک + نصب وابستگی‌ها + tsc (میلی‌ثانیه).
 * نصب وابستگی‌ها به‌تنهایی چند دقیقه طول می‌کشد؛ اگر این سقف تنگ باشد،
 * گیتِ fail-closed همهٔ مرج‌ها را بلاک می‌کند. */
const TIMEOUT_MS = 900_000;

/**
 * پچ را روی کلون تازه از ریپوی سایت اعمال و tsc را اجرا می‌کند.
 * @param patchFiles فایل‌های پچ: {path, content}
 * @param siteRepoUrl آدرس گیت ریپوی سایت
 * @param baseBranch شاخه مبنا (معمولاً dev)
 */
export async function preMergeTypeCheck(
  patchFiles: Array<{ path: string; content: string }>,
  siteRepoUrl: string,
  baseBranch: string = 'dev',
): Promise<PreMergeCheckResult> {
  const workdir = await mkdtemp(join(tmpdir(), 'premerge-'));
  try {
    // ۱. کلون سبک از شاخه مبنا: فقط تاریخچهٔ یک‌کامتی، بدون بلاب‌ها،
    //    و فقط پوشهٔ site (جایی که کد تایپ‌اسکریپت و package.json است).
    //    کلون کامل در عمل از سقف زمانی رد می‌شد و گیتِ fail-closed همهٔ
    //    مرج‌ها را بلاک می‌کرد.
    const cloneDir = workdir + '/site';
    await execFileAsync(
      'git',
      ['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', baseBranch, siteRepoUrl, cloneDir],
      { timeout: TIMEOUT_MS },
    );
    await execFileAsync('git', ['sparse-checkout', 'set', 'site'], {
      cwd: cloneDir,
      timeout: TIMEOUT_MS,
    });

    const siteDir = workdir + '/site/site'; // ریپو thailandgard، پوشه site/

    // ۲. اعمال فایل‌های پچ
    for (const f of patchFiles) {
      // فقط فایل‌های داخل site/ را چک می‌کنیم
      const relPath = f.path.startsWith('site/') ? f.path.slice(5) : f.path;
      const fullPath = join(siteDir, relPath);
      await mkdir(join(fullPath, '..'), { recursive: true });
      await writeFile(fullPath, f.content, 'utf-8');
    }

    // ۳. نصب وابستگی‌ها (اگر node_modules نبود)
    try {
      await execFileAsync('bash', ['-c', 'test -d node_modules || npm install --legacy-peer-deps --no-audit --no-fund 2>&1 | tail -3'], {
        cwd: siteDir,
        timeout: TIMEOUT_MS,
      });
    } catch {
      // اگر نصب شکست خورد، ادامه می‌دهیم؛ tsc شاید با خطای ماژول مواجه شود
    }

    // ۴. اجرای tsc
    try {
      await execFileAsync('npx', ['tsc', '--noEmit'], { cwd: siteDir, timeout: TIMEOUT_MS });
      return { passed: true, errors: [], message: 'تایپ‌چک سبز است؛ پچ آماده مرج.' };
    } catch (err: any) {
      const output = String(err.stdout || '') + String(err.stderr || '');
      const errors = output.split('\n').filter((l) => l.includes('error TS')).slice(0, 20);
      if (errors.length === 0) {
        // tsc خطای تایپی نداد ولی خروجیش غیرصفر بود: یعنی اصلاً درست اجرا نشد
        // (مثلاً نصب وابستگی‌ها ناقص ماند). علت خام می‌ماند تا دیباگ ممکن شود؛
        // پیام «۰ خطا» گمراه‌کننده است پس ساخته نمی‌شود.
        const tail = output.split('\n').filter((l) => l.trim()).slice(-5).join(' | ').slice(0, 500);
        return {
          passed: false,
          errors: [tail || 'خروجی tsc خالی بود'],
          message: `بررسی پیش‌مرج انجام نشد: ${tail || 'tsc اجرا نشد'}`,
        };
      }
      return {
        passed: false,
        errors,
        message: `تایپ‌چک ${errors.length} خطا دارد؛ پچ برمی‌گردد.`,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      errors: [msg],
      message: `بررسی پیش‌مرج انجام نشد: ${msg}`,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}
