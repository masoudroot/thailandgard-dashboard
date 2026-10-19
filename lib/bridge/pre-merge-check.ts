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
import { writeFile, mkdir, access } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const execFileAsync = promisify(execFile);

/** دایرکتوری دائمی برای پیش‌مرج: node_modules بین اجراها کش می‌شود.
 * /tmp فقط ۵۱۲MB دارد و برای npm install تنگ است؛ این مسیر روی دیسک اصلی است. */
const PREMERGE_WORKDIR = join(homedir(), 'workspace', 'thailandgard-dashboard', 'hidden_files', 'premerge');
const PREMERGE_CLONE_DIR = join(PREMERGE_WORKDIR, 'site-clone');

export interface PreMergeCheckResult {
  passed: boolean;
  /** خطاهای تایپ‌اسکریپت (فارسی‌نشده، خام برای دیباگ). */
  errors: string[];
  /** پیام فارسی خلاصه. */
  message: string;
}

/** حداکثر زمان مجاز برای کلون سبک + نصب وابستگی‌ها + tsc + بیلد (میلی‌ثانیه).
 * نصب وابستگی‌ها به‌تنهایی چند دقیقه طول می‌کشد و بیلد Next.js هم زمان‌بر
 * است؛ اگر این سقف تنگ باشد، گیتِ fail-closed همهٔ مرج‌ها را بلاک می‌کند. */
const TIMEOUT_MS = 1_200_000;

/**
 * پچ را روی کلون تازه از ریپوی سایت اعمال و tsc را اجرا می‌کند.
 * @param patchFiles فایل‌های پچ: {path, content}
 * @param siteRepoUrl آدرس گیت ریپوی سایت
 * @param baseBranch شاخه مبنا (معمولاً dev)
 * @param options.build اگر true باشد، پس از tsc یک بیلد کامل Next.js هم اجرا
 *   می‌شود؛ برای گیت dev→main لازم است تا خطاهای روت/بیلد (نه فقط تایپ) دیده شوند.
 */
export async function preMergeTypeCheck(
  patchFiles: Array<{ path: string; content: string }>,
  siteRepoUrl: string,
  baseBranch: string = 'dev',
  options: { build?: boolean } = {},
): Promise<PreMergeCheckResult> {
  // دایرکتوری دائمی: بین اجراها نگه داشته می‌شود تا node_modules کش شود.
  await mkdir(PREMERGE_WORKDIR, { recursive: true });
  const cloneDir = PREMERGE_CLONE_DIR;
  try {
    // ۱. کلون یا به‌روزرسانی: اگر کلون هست، فقط fetch + checkout؛
    //    اگر نیست، کلون سبک.
    const cloneExists = await access(join(cloneDir, '.git')).then(() => true).catch(() => false);
    if (cloneExists) {
      await execFileAsync('git', ['fetch', 'origin', baseBranch, '--depth', '1'], {
        cwd: cloneDir, timeout: TIMEOUT_MS,
      });
      await execFileAsync('git', ['checkout', '-f', `origin/${baseBranch}`], {
        cwd: cloneDir, timeout: TIMEOUT_MS,
      });
      await execFileAsync('git', ['clean', '-fd', 'site/'], {
        cwd: cloneDir, timeout: TIMEOUT_MS,
      });
    } else {
      await execFileAsync(
        'git',
        ['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', baseBranch, siteRepoUrl, cloneDir],
        { timeout: TIMEOUT_MS },
      );
      await execFileAsync('git', ['sparse-checkout', 'set', 'site'], {
        cwd: cloneDir,
        timeout: TIMEOUT_MS,
      });
    }

    const siteDir = join(cloneDir, 'site'); // ریپو thailandgard، پوشه site/

    // ۲. اعمال فایل‌های پچ
    for (const f of patchFiles) {
      // فقط فایل‌های داخل site/ را چک می‌کنیم
      const relPath = f.path.startsWith('site/') ? f.path.slice(5) : f.path;
      const fullPath = join(siteDir, relPath);
      await mkdir(join(fullPath, '..'), { recursive: true });
      await writeFile(fullPath, f.content, 'utf-8');
    }

    // ۳. نصب وابستگی‌ها (فقط اگر node_modules نیست؛ بین اجراها کش می‌شود).
    // خطا دیگر بلعیده نمی‌شود: اگر نصب شکست بخورد، علت در نتیجه برمی‌گردد.
    const nmExists = await access(join(siteDir, 'node_modules')).then(() => true).catch(() => false);
    if (!nmExists) {
      try {
        const { stdout } = await execFileAsync('npm', ['install', '--legacy-peer-deps', '--no-audit', '--no-fund'], {
          cwd: siteDir,
          timeout: TIMEOUT_MS,
        });
        console.log(`[pre-merge] npm install انجام شد: ${String(stdout).split('\n').slice(-2).join(' ').slice(0, 200)}`);
      } catch (err: any) {
        const out = String(err.stdout || '') + String(err.stderr || '');
        const tail = out.split('\n').filter((l) => l.trim()).slice(-5).join(' | ').slice(0, 500);
        return {
          passed: false,
          errors: [tail || 'npm install شکست خورد'],
          message: `نصب وابستگی‌ها ناموفق بود؛ پیش‌مرج انجام نشد: ${tail || 'خطای npm'}`,
        };
      }
      // راستی‌آزمایی: tsc واقعاً نصب شده؟
      const tscExists = await access(join(siteDir, 'node_modules', '.bin', 'tsc')).then(() => true).catch(() => false);
      if (!tscExists) {
        return {
          passed: false,
          errors: ['node_modules/.bin/tsc پیدا نشد'],
          message: 'نصب وابستگی‌ها کامل نشد (tsc پیدا نشد)؛ پیش‌مرج انجام نشد.',
        };
      }
    }

    // ۴. اجرای tsc
    try {
      await execFileAsync('npx', ['tsc', '--noEmit'], { cwd: siteDir, timeout: TIMEOUT_MS });
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

    // ۵. بیلد کامل Next.js (اختیاری): تایپ‌چک خطاهای روت تکراری، ایمپورت
    //    کامپوننت حذف‌شده و خرابی صفحه‌سازی را نمی‌گیرد؛ بیلد واقعی می‌گیرد.
    if (options.build) {
      try {
        await execFileAsync('npm', ['run', 'build'], {
          cwd: siteDir,
          timeout: TIMEOUT_MS,
          env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
        });
        return {
          passed: true,
          errors: [],
          message: 'تایپ‌چک و بیلد Next.js سبز است؛ تغییر آماده مرج به main است.',
        };
      } catch (err: any) {
        const output = String(err.stdout || '') + String(err.stderr || '');
        const lines = output.split('\n').filter((l) => l.trim());
        const errorLines = lines.filter((l) =>
          /error|failed|module not found|cannot find|type error|exited with/i.test(l),
        );
        const picked = (errorLines.length > 0 ? errorLines : lines).slice(-20);
        const tail = picked.slice(-5).join(' | ').slice(0, 800);
        return {
          passed: false,
          errors: picked,
          message: `بیلد Next.js رد شد؛ مرج به main بلاک شد. ${tail || 'خطای بیلد'}`,
        };
      }
    }

    return { passed: true, errors: [], message: 'تایپ‌چک سبز است؛ پچ آماده مرج.' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      errors: [msg],
      message: `بررسی پیش‌مرج انجام نشد: ${msg}`,
    };
  }
  // توجه: دایرکتوری دائمی پاک نمی‌شود تا node_modules کش بماند.
}
