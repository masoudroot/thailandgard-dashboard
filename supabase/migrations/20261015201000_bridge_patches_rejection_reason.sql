-- 20261015201000: ستون دلیل رد برای bridge_patches
-- مسیر تأیید/رد مدیر (مهندس ۶) دلیل رد را ثبت می‌کند؛ این ستون در مایگریشن
-- اولیه نبود. افزایشی و idempotent: IF NOT EXISTS.

alter table public.bridge_patches
  add column if not exists rejection_reason text;

comment on column public.bridge_patches.rejection_reason is
  'دلیل رد پچ، ثبت‌شده توسط مدیر در POST /api/bridge/patches/[id]/reject';
