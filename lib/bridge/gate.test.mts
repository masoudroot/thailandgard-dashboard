import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePatch, type PatchFile } from "./gate.ts";

function file(path: string, content = "export const value = 1;\n"): PatchFile {
  return { path, content };
}

/** محتوای نحویِ سالم با حجم تقریبی دلخواه (کیلوبایت) */
function bigContent(kilobytes: number): string {
  return "/*" + "x".repeat(kilobytes * 1024) + "*/\n";
}

test("پچ سالم با پسوندهای مجاز قبول می‌شود", () => {
  const result = validatePatch([
    file("lib/a.ts"),
    file("site/b.tsx", "export function App() {\n  return <div>سلام</div>;\n}\n"),
    file("styles/c.css", ".box {\n  color: red;\n}\n"),
    file("docs/d.md", "# راهنما\n\nمتن\n"),
    file("data/e.json", '{"a": 1}\n'),
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("پچ خالی سالم است", () => {
  const result = validatePatch([]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("مسیر دارای «..» رد می‌شود", () => {
  const result = validatePatch([file("../escape.ts")]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("«..»")), JSON.stringify(result.errors));
});

test("مسیر «..» پنهان‌شده با بک‌اسلش هم رد می‌شود", () => {
  const result = validatePatch([file("..\\escape.ts")]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("«..»")), JSON.stringify(result.errors));
});

test("مسیر مطلق رد می‌شود", () => {
  const result = validatePatch([file("/etc/app.ts")]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("مطلق")), JSON.stringify(result.errors));
});

test("مسیر شروع‌شونده با «.git» رد می‌شود", () => {
  const result = validatePatch([file(".git/hooks/commit.ts")]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes(".git")), JSON.stringify(result.errors));
});

test("فایل «.env» رد می‌شود", () => {
  const result = validatePatch([file(".env"), file("config/.env.local")]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.every((e) => e.includes(".env")), JSON.stringify(result.errors));
});

test("فایل بزرگ‌تر از ۲۵۶ کیلوبایت رد می‌شود", () => {
  const result = validatePatch([file("lib/big.ts", bigContent(257))]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("بیشتر است")), JSON.stringify(result.errors));
});

test("مجموع بیشتر از ۵۰۰ کیلوبایت رد می‌شود", () => {
  const files = Array.from({ length: 6 }, (_, i) => file(`lib/chunk${i}.ts`, bigContent(90)));
  const result = validatePatch(files);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("مجموع")), JSON.stringify(result.errors));
});

test("بیش از ۱۰ فایل رد می‌شود", () => {
  const files = Array.from({ length: 11 }, (_, i) => file(`lib/f${i}.ts`));
  const result = validatePatch(files);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("حداکثر")), JSON.stringify(result.errors));
});

test("پسوندهای غیرمجاز و فایل بدون پسوند رد می‌شوند", () => {
  const result = validatePatch([file("run.sh"), file("app.js"), file("config.yml"), file("README")]);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 4);
  assert.ok(result.errors.every((e) => e.includes("مجاز")), JSON.stringify(result.errors));
});

test("نحوی خراب در ts رد می‌شود", () => {
  const result = validatePatch([file("lib/bad.ts", "const broken = ;\n")]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("نحوی")), JSON.stringify(result.errors));
});

test("نحوی خراب در tsx رد می‌شود", () => {
  const result = validatePatch([file("site/bad.tsx", "export const el = <div>;\n")]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("نحوی")), JSON.stringify(result.errors));
});

test("خطاهای چند فایل یک‌جا جمع می‌شوند", () => {
  const result = validatePatch([file("../a.ts"), file("run.sh"), file("lib/ok.ts")]);
  assert.equal(result.ok, false);
  // «../a.ts»: خطای مسیر + خطای نگهبان امنیتی؛ «run.sh»: پسوند غیرمجاز
  assert.equal(result.errors.length, 3);
});

test("خط تیرهٔ بلند (U+2014) در هر فایلی رد می‌شود", () => {
  const bad = "export const title = 'سلام — دنیا';\n";
  const result = validatePatch([
    file("lib/a.ts", bad),
    file("docs/b.md", "# تیتر — متن\n"),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.every((e) => e.includes("خط تیرهٔ بلند")), JSON.stringify(result.errors));
});

test("فایل JSON خراب رد می‌شود", () => {
  const result = validatePatch([file("data/bad.json", '{"a": 1,\n')]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("معتبر نیست")), JSON.stringify(result.errors));
});

test("فایل JSON سالم قبول می‌شود", () => {
  const result = validatePatch([file("data/ok.json", '{"a": [1, 2]}\n')]);
  assert.equal(result.ok, true);
});

test("رقم فارسی در لیتِرال عددی کد رد می‌شود (با پیام صریح)", () => {
  const bad = "export function Card({ rating = ۴.۸ }: { rating?: number }) {\n  return rating;\n}\n";
  const result = validatePatch([file("site/x.tsx", bad)]);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("رقم فارسی در کد")),
    JSON.stringify(result.errors),
  );
});

test("رقم فارسی داخل رشته‌ها آزاد است", () => {
  const ok =
    "export const priceLabel = '۴٬۸۵۰٬۰۰۰ تومان';\nexport const rating = 4.8;\n";
  const result = validatePatch([file("site/y.ts", ok)]);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("فایل داده‌ای الحاقی تا ۲۵۶KB قبول می‌شود (رشد guides.ts)", () => {
  const content = "/*" + "x".repeat(150 * 1024) + "*/\n";
  const result = validatePatch([{ path: "site/lib/guides.ts", content }]);
  assert.equal(result.ok, true, JSON.stringify(result.errors.slice(0, 2)));
});

test("فایل بزرگ‌تر از ۲۵۶KB همچنان رد می‌شود", () => {
  const content = "/*" + "x".repeat(300 * 1024) + "*/\n";
  const result = validatePatch([{ path: "site/lib/big.ts", content }]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("سقف")), JSON.stringify(result.errors));
});
