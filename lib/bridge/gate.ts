/**
 * دروازه کیفیت پچ.
 *
 * هر پچ پیش از اعمال شدن از این دروازه رد می‌شود. بررسی‌ها:
 * ۱. مسیر امن: فقط مسیر نسبی، بدون «..»، بدون شروع با «.git»، بدون فایل «.env»
 * ۲. محدودیت حجم: حداکثر ۱۰ فایل، هر فایل ۱۰۰ کیلوبایت، مجموع ۵۰۰ کیلوبایت
 * ۳. پسوند مجاز: فقط ts و tsx و css و md و json
 * ۴. نحو پایه ts و tsx با TypeScript compiler API (فقط parse، بدون typecheck)
 * ۵. اعتبار JSON برای فایل‌های .json
 * ۶. ممنوعیت خط تیرهٔ بلند (U+2014) در همهٔ فایل‌ها (دستور دائمی مدیر)
 * ۷. ممنوعیت ارقام فارسی در موقعیت کدی ts/tsx (داخل رشته‌ها آزاد است)
 *
 * خطاها فارسی‌اند تا مستقیم در گزارش‌ها بنشینند.
 */

import ts from "typescript";
import type { PatchFile } from "../types";
export type { PatchFile } from "../types";
import { validatePaths, scanSecrets } from "../execution-guard";

/** نتیجه داوری دروازه */
export interface GateResult {
  ok: boolean;
  /** خطاها به فارسی؛ خالی بودن یعنی پچ سالم است */
  errors: string[];
}

const MAX_FILES = 10;
/**
 * سقف حجم هر فایل: ۲۵۶ کیلوبایت.
 * (یافتهٔ ممیزی مشکل ۲: فایل‌های داده‌ایِ الحاقی مثل site/lib/guides.ts
 * ذاتاً رشد می‌کنند — هر راهنما ~۶KB — و سقف ۱۰۰KB ظرف چند هفته پچ‌های
 * سالم content را رد می‌کرد. سقف کلی ۵۰۰KB سر جایش است؛ این سقف فقط
 * خروجیِ فراریِ مجری را می‌گیرد، نه فایل داده‌ایِ مشروع را.)
 */
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024;
const ALLOWED_EXTENSIONS = new Set(["ts", "tsx", "css", "md", "json"]);

/** خط تیرهٔ بلند (U+2014) مطلقاً ممنوع است؛ دستور دائمی مدیر. */
const EM_DASH = "—";

/** بررسی ممنوعه‌ها در متن فایل؛ خالی بودن یعنی پاک است. */
function checkForbiddenChars(path: string, content: string): string[] {
  const errors: string[] = [];
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    if (line.includes(EM_DASH)) {
      errors.push(
        `فایل «${path}» در سطر ${faNumber(i + 1)} خط تیرهٔ بلند (—) دارد که مطلقاً ممنوع است. با «-» یا «:» جایگزین کن.`,
      );
    }
  });
  return errors;
}

/** ارقام فارسی؛ در موقعیت کدی (نه داخل رشته) مطلقاً ممنوع‌اند. */
const PERSIAN_DIGITS = /[۰۱۲۳۴۵۶۷۸۹]/;

/**
 * ارقام فارسی در موقعیت کدی (یافتهٔ ممیزی: تیم design مقدار پیش‌فرض
 * `rating = ۴.۸` تولید کرد و گیت فقط «Invalid character» می‌گفت).
 * با اسکنر تایپ‌اسکریپت، رشته‌ها و کامنت‌ها نادیده گرفته می‌شوند؛ ارقام
 * فارسی داخل رشته‌های نمایشی (قیمت و...) آزادند. پیام خطا صریح است تا
 * مجری LLM خودش اصلاح کند. عمداً اسکنر (نه AST) استفاده می‌شود چون فایلِ
 * دارای رقم فارسی معمولاً اصلاً پارس نمی‌شود و AST لیتِرال عددی ندارد.
 */
function checkPersianDigitsInCode(path: string, content: string): string[] {
  const errors: string[] = [];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, content);
  const isStringToken = (kind: ts.SyntaxKind): boolean =>
    kind === ts.SyntaxKind.StringLiteral ||
    kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
    kind === ts.SyntaxKind.TemplateHead ||
    kind === ts.SyntaxKind.TemplateMiddle ||
    kind === ts.SyntaxKind.TemplateTail;
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (!isStringToken(token)) {
      const text = scanner.getTokenText();
      if (PERSIAN_DIGITS.test(text)) {
        const pos = scanner.getTokenStart();
        const line = content.slice(0, pos).split('\n').length;
        errors.push(
          `فایل «${path}» در سطر ${faNumber(line)} رقم فارسی در کد دارد («${text.trim().slice(0, 24)}»)؛ در کد فقط ارقام لاتین مجاز است (ارقام فارسی فقط داخل رشته‌های نمایشی).`,
        );
        break;
      }
    }
    token = scanner.scan();
  }
  return errors;
}

/** اعتبار JSON برای فایل‌های .json. */
function checkJson(path: string, content: string): string[] {
  try {
    JSON.parse(content);
    return [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [`فایل JSON «${path}» معتبر نیست: ${message}`];
  }
}

/** عدد را با ارقام فارسی برمی‌گرداند */
function faNumber(value: number): string {
  return value.toLocaleString("fa-IR");
}

/**
 * الگوهای کد مخرب؛ هر موردی یعنی رد کامل پچ (می‌رود به needs_review).
 * محافظه‌کارانه: فقط الگوهایی که تقریباً همیشه مخرب‌اند.
 */
const DESTRUCTIVE_CODE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /deleteMany\s*\(\s*\{\s*\}\s*\)/, label: 'حذف دسته‌جمعی بدون شرط (deleteMany خالی)' },
  { pattern: /\bDROP\s+TABLE\b/i, label: 'دستور DROP TABLE' },
  { pattern: /\bTRUNCATE\s+TABLE\b/i, label: 'دستور TRUNCATE' },
  { pattern: /rm\s+-rf\s+[/~]/, label: 'حذف بازگشتی سیستم‌فایل (rm -rf)' },
  { pattern: /child_process.*exec.*curl/i, label: 'اجرای دانلود و اجرا از شبکه' },
  { pattern: /eval\s*\(\s*(?!["'`])/, label: 'اجرای کد پویا با eval' },
];

/** اسکن محتوای فایل‌ها برای الگوهای مخرب */
function scanDestructive(files: PatchFile[]): string[] {
  const errors: string[] = [];
  for (const file of files) {
    if (typeof file.content !== 'string') continue;
    for (const d of DESTRUCTIVE_CODE_PATTERNS) {
      if (d.pattern.test(file.content)) {
        errors.push(`الگوی مخرب در «${file.path}» (${d.label})؛ این پچ نیاز به بازبینی انسانی دارد.`);
        break;
      }
    }
  }
  return errors;
}

function faSize(bytes: number): string {
  return `${faNumber(Math.round(bytes / 1024))} کیلوبایت`;
}

/** بک‌اسلش را به اسلش تبدیل می‌کند تا «..» پنهان نماند */
function normalizePath(rawPath: string): string {
  return rawPath.replace(/\\/g, "/").trim();
}

function checkPath(rawPath: string): string | null {
  if (!rawPath || !rawPath.trim()) {
    return "مسیر فایل خالی است.";
  }
  const path = normalizePath(rawPath);
  if (path.includes("\0")) {
    return `مسیر «${rawPath}» کاراکتر نامعتبر دارد.`;
  }
  if (path.startsWith("/") || path.startsWith("//") || /^[a-zA-Z]:/.test(path)) {
    return `مسیر «${rawPath}» مطلق است؛ فقط مسیر نسبی مجاز است.`;
  }
  const segments = path.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) {
    return `مسیر «${rawPath}» معتبر نیست.`;
  }
  if (segments.includes("..")) {
    return `مسیر «${rawPath}» شامل «..» است و مجاز نیست.`;
  }
  if (segments[0].toLowerCase() === ".git") {
    return `مسیر «${rawPath}» با «.git» شروع می‌شود و مجاز نیست.`;
  }
  // بلاک .env با هر ترکیب حروف بزرگ/کوچک (دفاع در عمق)
  if (segments.some((s) => s.toLowerCase() === ".env" || s.toLowerCase().startsWith(".env."))) {
    return `فایل «.env» در مسیر «${rawPath}» مجاز نیست.`;
  }
  return null;
}

function extensionOf(path: string): string {
  const fileName = normalizePath(path).split("/").pop() ?? "";
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) {
    return "";
  }
  return fileName.slice(dot + 1).toLowerCase();
}

/**
 * parseDiagnostics در تایپ عمومی SourceFile نیامده (داخلی است)،
 * ولی پارسر ران‌تایم همیشه آن را می‌سازد؛ پس با یک کستِ ساختاریِ حداقلی می‌خوانیمش.
 */
interface ParsedSourceFile extends ts.SourceFile {
  readonly parseDiagnostics?: readonly ts.DiagnosticWithLocation[];
}

function checkSyntax(path: string, content: string): string[] {
  const scriptKind = path.toLowerCase().endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  let sourceFile: ParsedSourceFile;
  try {
    sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, false, scriptKind) as ParsedSourceFile;
  } catch {
    return [`بررسی نحوی فایل «${path}» ممکن نشد؛ محتوا قابل خواندن نیست.`];
  }
  const diagnostics = sourceFile.parseDiagnostics ?? [];
  return diagnostics.map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `خطای نحوی در «${path}» (سطر ${faNumber(line + 1)}، ستون ${faNumber(character + 1)}): ${message}`;
  });
}

/**
 * پچ را از دروازه کیفیت رد می‌کند.
 * همه خطاها جمع می‌شوند تا فرستنده یک‌جا ببیند چه چیزی ایراد دارد.
 */
export function validatePatch(files: PatchFile[]): GateResult {
  const errors: string[] = [];

  if (!Array.isArray(files)) {
    return { ok: false, errors: ["ورودی دروازه معتبر نیست؛ آرایه‌ای از فایل‌ها انتظار می‌رفت."] };
  }

  if (files.length > MAX_FILES) {
    errors.push(`تعداد فایل‌ها ${faNumber(files.length)} است؛ حداکثر ${faNumber(MAX_FILES)} فایل مجاز است.`);
  }

  let totalBytes = 0;

  for (const file of files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
      errors.push("یکی از فایل‌ها ساختار معتبر ندارد؛ مسیر و محتوا لازم است.");
      continue;
    }

    const size = Buffer.byteLength(file.content, "utf8");
    totalBytes += size;

    const pathError = checkPath(file.path);
    if (pathError) {
      errors.push(pathError);
      continue;
    }

    if (size > MAX_FILE_BYTES) {
      errors.push(`حجم فایل «${file.path}» (${faSize(size)}) از سقف ${faSize(MAX_FILE_BYTES)} بیشتر است.`);
    }

    const ext = extensionOf(file.path);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      if (ext === "") {
        errors.push(`فایل «${file.path}» پسوند ندارد؛ فقط ts و tsx و css و md و json مجازند.`);
      } else {
        errors.push(`پسوند «.${ext}» برای فایل «${file.path}» مجاز نیست؛ فقط ts و tsx و css و md و json مجازند.`);
      }
      continue;
    }

    if (ext === "ts" || ext === "tsx") {
      errors.push(...checkSyntax(file.path, file.content));
      errors.push(...checkPersianDigitsInCode(file.path, file.content));
    }

    if (ext === "json") {
      errors.push(...checkJson(file.path, file.content));
    }

    errors.push(...checkForbiddenChars(file.path, file.content));
  }

  if (totalBytes > MAX_TOTAL_BYTES) {
    errors.push(`حجم مجموع فایل‌ها (${faSize(totalBytes)}) از سقف ${faSize(MAX_TOTAL_BYTES)} بیشتر است.`);
  }

  // نگهبان امنیتی (lib/execution-guard): مسیرهای ممنوعه‌ی زیرساختی
  // (middleware، کانفیگ بیلد، package.json، احراز هویت، ورک‌فلوها، ...)
  try {
    const pathGuard = validatePaths(files.map((f) => ({ path: f.path, content: f.content })));
    for (const issue of pathGuard.errors) {
      errors.push(`نگهبان امنیتی: فایل «${issue.file}»: ${issue.reason}`);
    }
  } catch {
    // اگر نگهبان خطا داد، پچ رد می‌شود (fail-closed)
    errors.push('نگهبان امنیتی نتوانست مسیرها را بررسی کند؛ پچ رد شد.');
  }

  // اسکن سکرت داخل محتوا
  try {
    const secretIssues = scanSecrets(files.map((f) => ({ path: f.path, content: f.content })));
    for (const issue of secretIssues) {
      errors.push(`نگهبان امنیتی: فایل «${issue.file}»: ${issue.reason}`);
    }
  } catch {
    errors.push('نگهبان امنیتی نتوانست سکرت‌ها را بررسی کند؛ پچ رد شد.');
  }

  // اسکن کد مخرب
  errors.push(...scanDestructive(files));

  return { ok: errors.length === 0, errors };
}
