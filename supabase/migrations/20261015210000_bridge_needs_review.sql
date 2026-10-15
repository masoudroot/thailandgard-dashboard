-- 20261015210000: وضعیت «needs_review» برای پچ‌های پل
-- وقتی دروازه کیفیت پچ را رد می‌کند، پچ متوقف می‌شود و با وضعیت needs_review
-- (نیاز به بررسی) در داشبورد دیده می‌شود؛ چرخه نمی‌میرد.
-- افزایشی و idempotent: نام constraint استاندارد است؛ اجرای دوباره بی‌اثر.

alter table public.bridge_patches drop constraint if exists bridge_patches_status_check;

alter table public.bridge_patches
  add constraint bridge_patches_status_check
  check (status in (
    'proposed', 'gated', 'committed', 'approved',
    'merged', 'rejected', 'rolledback', 'needs_review'
  ));

comment on column public.bridge_patches.status is
  'proposed → gated → committed → merged (خودکار)؛ needs_review وقتی دروازه قرمز است؛ rejected/rolledback پایانی‌اند.';
