/**
 * دروازه کیفیت پچ.
 *
 * هر پچ پیش از اعمال شدن از این دروازه رد می‌شود. بررسی‌ها:
 * ۱. مسیر امن: فقط مسیر نسبی، بدون «..»، بدون شروع با «.git»، بدون فایل «.env»
 * ۲. محدودیت حجم: حداکثر ۱۰ فایل، هر فایل ۱۰۰ کیلوبایت، مجموع ۵۰۰ کیلوبایت
 * ۳. پسوند مجاز: فقط ts و tsx و css و md و json
 * ۴. نحو پایه ts و tsx با TypeScript compiler API (فقط parse، بدون typecheck)
 *
 * خطاها فارسی‌اند تا مستقیم در گزارش‌ها بنشینند.
 */

import ts from "typescript";
import type { PatchFile } from "../types";
export type { PatchFile } from "../types";

/** نتیجه داوری دروازه */
export interface GateResult {
  ok: boolean;
  /** خطاها به فارسی؛ خالی بودن یعنی پچ سالم است */
  errors: string[];
}

const MAX_FILES = 10;
const MAX_FILE_BYTES = 100 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024;
const ALLOWED_EXTENSIONS = new Set(["ts", "tsx", "css", "md", "json"]);

/** عدد را با ارقام فارسی برمی‌گرداند */
function faNumber(value: number): string {
  return value.toLocaleString("fa-IR");
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
  if (segments.some((s) => s === ".env" || s.startsWith(".env."))) {
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
    }
  }

  if (totalBytes > MAX_TOTAL_BYTES) {
    errors.push(`حجم مجموع فایل‌ها (${faSize(totalBytes)}) از سقف ${faSize(MAX_TOTAL_BYTES)} بیشتر است.`);
  }

  return { ok: errors.length === 0, errors };
}
