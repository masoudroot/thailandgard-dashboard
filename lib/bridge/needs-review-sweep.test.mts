/**
 * lib/bridge/needs-review-sweep.test.mts: تست منطق خالص جاروی بن‌بست needs_review.
 *
 * فقط decidePatchFate و hashPatchFiles تست می‌شوند (بدون دیتابیس)؛
 * sweepNeedsReviewPatches خودش لایهٔ نازک دیتابیسی است.
 *
 * اجرا: npx tsx --test lib/bridge/needs-review-sweep.test.mts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decidePatchFate,
  hashPatchFiles,
  STALE_DAYS,
  type NeedsReviewRow,
  type MergedCandidate,
  type PatchFile,
} from "./needs-review-sweep.ts";

const NOW = Date.parse("2026-10-18T20:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function row(over: Partial<NeedsReviewRow> = {}): NeedsReviewRow {
  return {
    id: "patch-1",
    team: "content",
    files: [{ path: "site/a.ts", content: "export const x = 1;\n" }],
    gate_errors: ["خطای نحوی در «site/a.ts» (سطر ۱): ..."],
    created_at: iso(NOW - 2 * DAY),
    updated_at: iso(NOW - 2 * HOUR),
    ...over,
  };
}

function merged(over: Partial<MergedCandidate> = {}): MergedCandidate {
  return {
    id: "merged-1",
    team: "content",
    files: [{ path: "site/other.ts", content: "export const y = 2;\n" }],
    created_at: iso(NOW - 1 * DAY),
    ...over,
  };
}

const validFiles: PatchFile[] = [{ path: "site/ok.ts", content: "export const ok = 1;\n" }];

test("پچ کهنه‌تر از STALE_DAYS روز ← stale", () => {
  const r = row({ updated_at: iso(NOW - (STALE_DAYS + 1) * DAY) });
  assert.equal(decidePatchFate(r, [], NOW), "stale");
});

test("پچ تازه با خطای گیتِ واقعی ← leave (نه stale)", () => {
  const r = row({
    files: [{ path: "site/a.ts", content: "export const = ;\n" }],
    gate_errors: ["خطای نحوی واقعی"],
    updated_at: iso(NOW - 1 * HOUR),
  });
  assert.equal(decidePatchFate(r, [], NOW), "leave");
});

test("محتوای یکسان با merged تازه‌تر ← duplicate (بر stale اولویت ندارد، بر بقیه دارد)", () => {
  const files = [{ path: "site/dup.ts", content: "export const d = 1;\n" }];
  const r = row({ files, gate_errors: ["خطا"], updated_at: iso(NOW - 1 * HOUR) });
  const m = merged({ files: [...files].reverse() });
  // ترتیب فایل‌ها نباید روی هش اثر بگذارد
  assert.equal(decidePatchFate(r, [m], NOW), "duplicate");
});

test("تداخل مرج دائمی + merged تازه‌تر روی همان فایل ← superseded", () => {
  const r = row({
    files: [{ path: "site/lib/seo-h1.ts", content: "export const a = 1;\n" }],
    gate_errors: ["تداخل مرج با dev (دائمی): مرج PR ناموفق بود"],
    updated_at: iso(NOW - 1 * HOUR),
  });
  const m = merged({
    files: [{ path: "site/lib/seo-h1.ts", content: "export const a = 2;\n" }],
  });
  assert.equal(decidePatchFate(r, [m], NOW), "superseded");
});

test("تداخل مرج ولی هیچ merged تازه‌تری روی آن فایل نیست ← leave", () => {
  const r = row({
    files: [{ path: "site/lib/seo-h1.ts", content: "export const = ;\n" }],
    gate_errors: ["تداخل مرج با dev (دائمی): مرج PR ناموفق بود"],
    updated_at: iso(NOW - 1 * HOUR),
  });
  assert.equal(decidePatchFate(r, [merged()], NOW), "leave");
});

test("فایل سالم ولی gate_errors قدیمی دارد ← requeue (خودترمیم)", () => {
  const r = row({
    files: validFiles,
    gate_errors: ["خطای قدیمی که دیگر نیست"],
    updated_at: iso(NOW - 1 * HOUR),
  });
  assert.equal(decidePatchFate(r, [], NOW), "requeue");
});

test("محتوای یکسان با merged قدیمی‌تر هم ← duplicate (مرجِ دوباره no-op است)", () => {
  const files = [{ path: "site/dup.ts", content: "export const d = 1;\n" }];
  const r = row({ files, gate_errors: ["خطا"], updated_at: iso(NOW - 1 * HOUR) });
  const m = merged({ files: [...files], created_at: iso(NOW - 5 * DAY) });
  assert.equal(decidePatchFate(r, [m], NOW), "duplicate");
});

test("hashPatchFiles مستقل از ترتیب فایل‌هاست", () => {
  const a: PatchFile[] = [
    { path: "b.ts", content: "2" },
    { path: "a.ts", content: "1" },
  ];
  const b: PatchFile[] = [
    { path: "a.ts", content: "1" },
    { path: "b.ts", content: "2" },
  ];
  assert.equal(hashPatchFiles(a), hashPatchFiles(b));
});

test("hashPatchFiles برای محتوای متفاوت فرق می‌کند", () => {
  const a: PatchFile[] = [{ path: "a.ts", content: "1" }];
  const b: PatchFile[] = [{ path: "a.ts", content: "2" }];
  assert.notEqual(hashPatchFiles(a), hashPatchFiles(b));
});
