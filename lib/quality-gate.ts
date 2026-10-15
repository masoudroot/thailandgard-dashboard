/**
 * lib/quality-gate.ts : دروازهٔ کیفیت پیش از کامیت
 *
 * کد تولیدشده توسط تیم‌ها پیش از رفتن به ریپوی سایت (thailandgard) از این
 * دروازه رد می‌شود. هر چک مستقل است و نتیجه‌اش فارسی و قابل‌فهم برای تیم است.
 *
 * چرخهٔ تصمیم:
 *   pass    ← همهٔ چک‌ها سبز؛ پچ می‌تواند کامیت شود
 *   retry   ← چک رد شد؛ بازخورد فارسی به تیم برمی‌گردد تا اصلاح کند
 *   escalate ← پس از N تلاش ناموفق؛ به انسان (مسعود) ارجاع می‌شود
 *
 * نکتهٔ صادقانه دربارهٔ تایپ‌چک: چک تایپ‌اسکریپت این دروازه «نحوی» است
 * (خطای سینتکس را می‌گیرد). تایپ‌چک کامل سطح پروژه روی ریپوی سایت انجام
 * می‌شود چون به کل زمینهٔ پروژه (ایمپورت‌ها، node_modules) نیاز دارد و این‌جا
 * در دسترس نیست.
 */

import * as ts from 'typescript';
import type { PatchFile } from './github';

/** یک چک منفرد دروازه. */
export interface QualityCheck {
  /** نام فارسی چک، مثل «ساختار مسیر». */
  name: string;
  /** رد شد یا نه. */
  passed: boolean;
  /** پیام فارسی قابل‌فهم برای تیم. */
  message: string;
  /** فایل مربوطه، اگر چک فایل‌محور باشد. */
  file?: string;
}

/** نتیجهٔ کامل دروازه. */
export interface QualityGateResult {
  passed: boolean;
  checks: QualityCheck[];
}

/** تصمیم دروازه بر اساس نتیجه و شمار تلاش‌ها. */
export type GateDecision = 'pass' | 'retry' | 'escalate';

/** حداکثر تلاش تیم برای اصلاح پیش از ارجاع به انسان. */
export const MAX_GATE_ATTEMPTS = 3;

/** حداکثر تعداد فایل در یک پچ. */
const MAX_FILES = 10;
/** حداکثر حجم هر فایل (بایت). */
const MAX_FILE_BYTES = 200_000;
/** حداکثر حجم کل پچ (بایت). */
const MAX_TOTAL_BYTES = 1_000_000;

/** پسوندهای متنی مجازی که تیم‌ها می‌توانند تولید کنند. */
const ALLOWED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.css',
  '.json',
  '.md',
  '.mdx',
  '.html',
  '.svg',
]);

/** الگوهای ممنوعه در مسیر فایل. */
const FORBIDDEN_PATH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\.\./, reason: 'مسیر نباید شامل «..» باشد' },
  { pattern: /(^|\/)\.git(\/|$)/, reason: 'دسترسی به ‎.git ممنوع است' },
  { pattern: /(^|\/)\.env(\.|$)/, reason: 'فایل‌های ‎.env ممنوع‌اند' },
  { pattern: /(^|\/)node_modules(\/|$)/, reason: 'node_modules ممنوع است' },
  { pattern: /(^|\/)\.next(\/|$)/, reason: 'خروجی بیلد (.next) ممنوع است' },
];

/** خط تیرهٔ بلند؛ مطلقاً ممنوع در هر خروجی. */
const EM_DASH = '—';

/**
 * چک ۱: ساختار مسیر فایل‌ها.
 * - تعداد فایل حداکثر MAX_FILES
 * - مسیر نسبی، بدون .. و بدون الگوهای ممنوعه
 * - پسوند مجاز
 */
export function checkPaths(files: PatchFile[]): QualityCheck[] {
  const checks: QualityCheck[] = [];

  if (!Array.isArray(files) || files.length === 0) {
    return [
      {
        name: 'ساختار مسیر',
        passed: false,
        message: 'پچ خالی است؛ دست‌کم یک فایل لازم است.',
      },
    ];
  }

  if (files.length > MAX_FILES) {
    checks.push({
      name: 'ساختار مسیر',
      passed: false,
      message: `تعداد فایل‌ها ${toFa(files.length)} است؛ حداکثر ${toFa(MAX_FILES)} فایل در هر پچ مجاز است. پچ را کوچک‌تر کن.`,
    });
    return checks;
  }

  const seen = new Set<string>();
  for (const f of files) {
    const rawPath = typeof f.path === 'string' ? f.path.trim() : '';
    const path = rawPath.replace(/^\/+/, '');

    if (!path) {
      checks.push({ name: 'ساختار مسیر', passed: false, message: 'یک فایل مسیر خالی دارد.', file: rawPath });
      continue;
    }
    if (seen.has(path)) {
      checks.push({ name: 'ساختار مسیر', passed: false, message: `فایل «${path}» تکراری است.`, file: path });
      continue;
    }
    seen.add(path);

    for (const { pattern, reason } of FORBIDDEN_PATH_PATTERNS) {
      if (pattern.test(path)) {
        checks.push({ name: 'ساختار مسیر', passed: false, message: `مسیر «${path}» غیرمجاز است: ${reason}.`, file: path });
      }
    }

    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    if (!path.includes('.') || !ALLOWED_EXTENSIONS.has(ext)) {
      checks.push({
        name: 'ساختار مسیر',
        passed: false,
        message: `پسوند فایل «${path}» مجاز نیست. پسوندهای مجاز: ${Array.from(ALLOWED_EXTENSIONS).join('، ')}.`,
        file: path,
      });
    }

    if (typeof f.content !== 'string') {
      checks.push({ name: 'ساختار مسیر', passed: false, message: `محتوای فایل «${path}» متن نیست.`, file: path });
    }
  }

  if (checks.length === 0) {
    checks.push({
      name: 'ساختار مسیر',
      passed: true,
      message: `${toFa(files.length)} فایل؛ همهٔ مسیرها معتبرند.`,
    });
  }
  return checks;
}

/**
 * چک ۲: حجم فایل‌ها.
 * - هر فایل حداکثر MAX_FILE_BYTES
 * - مجموع حداکثر MAX_TOTAL_BYTES
 */
export function checkSizes(files: PatchFile[]): QualityCheck[] {
  const checks: QualityCheck[] = [];
  let total = 0;

  for (const f of files) {
    if (typeof f.content !== 'string') continue;
    const bytes = Buffer.byteLength(f.content, 'utf-8');
    total += bytes;
    if (bytes > MAX_FILE_BYTES) {
      checks.push({
        name: 'حجم فایل',
        passed: false,
        message: `فایل «${f.path}» ${toFa(Math.round(bytes / 1024))} کیلوبایت است؛ سقف هر فایل ${toFa(MAX_FILE_BYTES / 1000)} کیلوبایت است. فایل را بشکن یا خلاصه کن.`,
        file: f.path,
      });
    }
  }

  if (total > MAX_TOTAL_BYTES) {
    checks.push({
      name: 'حجم فایل',
      passed: false,
      message: `حجم کل پچ ${toFa(Math.round(total / 1024))} کیلوبایت است؛ سقف ${toFa(MAX_TOTAL_BYTES / 1000)} کیلوبایت است.`,
    });
  }

  if (checks.length === 0) {
    checks.push({
      name: 'حجم فایل',
      passed: true,
      message: `حجم کل ${toFa(Math.round(total / 1024))} کیلوبایت؛ در سقف مجاز.`,
    });
  }
  return checks;
}

/**
 * چک ۳: فارسی؛ نبود خط تیرهٔ بلند (U+2014) در هیچ فایلی.
 */
export function checkEmDash(files: PatchFile[]): QualityCheck[] {
  const checks: QualityCheck[] = [];

  for (const f of files) {
    if (typeof f.content !== 'string') continue;
    const idx = f.content.indexOf(EM_DASH);
    if (idx !== -1) {
      const line = f.content.slice(0, idx).split('\n').length;
      checks.push({
        name: 'فارسی (خط تیرهٔ بلند)',
        passed: false,
        message: `فایل «${f.path}» در خط ${toFa(line)} خط تیرهٔ بلند (—) دارد که مطلقاً ممنوع است. با «-» یا «:» جایگزین کن.`,
        file: f.path,
      });
    }
  }

  if (checks.length === 0) {
    checks.push({
      name: 'فارسی (خط تیرهٔ بلند)',
      passed: true,
      message: 'هیچ خط تیرهٔ بلندی پیدا نشد.',
    });
  }
  return checks;
}

/**
 * چک ۴: تایپ‌اسکریپت؛ خطای نحوی فایل‌های .ts و .tsx.
 * از transpileModule با reportDiagnostics استفاده می‌شود تا فقط خطای واقعی
 * سینتکس گرفته شود، نه خطای «ماژول پیدا نشد» که به زمینهٔ کامل پروژه نیاز دارد.
 */
export function checkTypeScript(files: PatchFile[]): QualityCheck[] {
  const checks: QualityCheck[] = [];
  let tsFileCount = 0;

  for (const f of files) {
    if (typeof f.content !== 'string') continue;
    const lower = f.path.toLowerCase();
    const isTs = lower.endsWith('.ts') || lower.endsWith('.tsx');
    if (!isTs) continue;
    tsFileCount++;

    const isTsx = lower.endsWith('.tsx');
    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    };
    if (isTsx) compilerOptions.jsx = ts.JsxEmit.Preserve;

    const result = ts.transpileModule(f.content, {
      compilerOptions,
      reportDiagnostics: true,
      fileName: f.path,
    });

    const errors = (result.diagnostics ?? []).filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );
    for (const d of errors) {
      const pos = d.file && typeof d.start === 'number'
        ? d.file.getLineAndCharacterOfPosition(d.start)
        : null;
      const where = pos ? ` (خط ${toFa(pos.line + 1)})` : '';
      const text = ts.flattenDiagnosticMessageText(d.messageText, ' ');
      checks.push({
        name: 'تایپ‌اسکریپت (نحو)',
        passed: false,
        message: `فایل «${f.path}»${where}: ${text}`,
        file: f.path,
      });
    }
  }

  if (checks.length === 0) {
    checks.push({
      name: 'تایپ‌اسکریپت (نحو)',
      passed: true,
      message: tsFileCount === 0 ? 'فایل تایپ‌اسکریپتی در پچ نیست.' : `${toFa(tsFileCount)} فایل تایپ‌اسکریپت؛ بدون خطای نحوی.`,
    });
  }
  return checks;
}

/**
 * چک ۵: اعتبار JSON برای فایل‌های .json.
 */
export function checkJson(files: PatchFile[]): QualityCheck[] {
  const checks: QualityCheck[] = [];
  let jsonCount = 0;

  for (const f of files) {
    if (typeof f.content !== 'string') continue;
    if (!f.path.toLowerCase().endsWith('.json')) continue;
    jsonCount++;
    try {
      JSON.parse(f.content);
    } catch (err) {
      checks.push({
        name: 'اعتبار JSON',
        passed: false,
        message: `فایل «${f.path}» JSON معتبر نیست: ${err instanceof Error ? err.message : String(err)}`,
        file: f.path,
      });
    }
  }

  if (checks.length === 0 && jsonCount > 0) {
    checks.push({
      name: 'اعتبار JSON',
      passed: true,
      message: `${toFa(jsonCount)} فایل JSON؛ همه معتبرند.`,
    });
  }
  return checks;
}

/**
 * اجرای همهٔ چک‌های دروازه روی یک پچ.
 */
export function runQualityGate(files: PatchFile[]): QualityGateResult {
  const checks: QualityCheck[] = [
    ...checkPaths(files),
    ...checkSizes(files),
    ...checkEmDash(files),
    ...checkTypeScript(files),
    ...checkJson(files),
  ];
  const passed = checks.every((c) => c.passed);
  return { passed, checks };
}

/**
 * تصمیم دروازه بر اساس نتیجه و شمار تلاش‌های قبلی.
 * - pass: همه سبز
 * - retry: رد شد ولی هنوز تلاش باقی است؛ به تیم برگردد
 * - escalate: سقف تلاش رد شد؛ به انسان ارجاع شود
 */
export function gateDecision(result: QualityGateResult, attemptsSoFar: number): GateDecision {
  if (result.passed) return 'pass';
  if (attemptsSoFar + 1 >= MAX_GATE_ATTEMPTS) return 'escalate';
  return 'retry';
}

/**
 * بازخورد فارسی برای تیم؛ وقتی دروازه رد می‌کند.
 * فقط چک‌های ردشده می‌آیند تا تیم دقیقاً بداند چه را اصلاح کند.
 */
export function formatGateFeedback(result: QualityGateResult, attempt: number): string {
  const failures = result.checks.filter((c) => !c.passed);
  const lines = failures.map((c, i) => `${toFa(i + 1)}. [${c.name}] ${c.message}`);
  return [
    `دروازهٔ کیفیت پچ را رد کرد (تلاش ${toFa(attempt)} از ${toFa(MAX_GATE_ATTEMPTS)}).`,
    ...lines,
    'پچ را اصلاح کن و دوباره بفرست. اگر پس از سقف تلاش هنوز رد شد، به مسعود ارجاع می‌شود.',
  ].join('\n');
}

/**
 * خلاصهٔ فارسی نتیجه برای لاگ و داشبورد.
 */
export function formatGateSummary(result: QualityGateResult): string {
  const total = result.checks.length;
  const failed = result.checks.filter((c) => !c.passed).length;
  if (result.passed) return `دروازهٔ کیفیت: ${toFa(total)} چک، همه سبز.`;
  return `دروازهٔ کیفیت: ${toFa(failed)} چک از ${toFa(total)} رد شد.`;
}

/** تبدیل ارقام لاتین به فارسی برای پیام‌ها. */
function toFa(n: number | string): string {
  return String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
}
