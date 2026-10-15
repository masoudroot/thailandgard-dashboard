-- Migration: document team_runs.status vocabulary (incl. 'rejected')
-- Project: thailandgard-dashboard
--
-- واژگان وضعیت team_runs.status:
--   pending  : هنوز اجرا نشده (ضمنی؛ ردیفی ثبت نشده)
--   running  : در حال اجرا
--   success  : اجرا شد و منتقد تأیید کرد
--   failed   : خطای سیستمی؛ تیم نتوانست اجرا شود (exception، تایم‌اوت، claim رهاشده)
--   rejected : تیم اجرا شد ولی منتقد خروجی را رد کرد (approved=false)
--   skipped  : صرف‌نظر شده
--   stopped  : توسط کاربر متوقف شد
--
-- نکته: هیچ CHECK constraint روی status نیست (راستی شد)؛ پس چیزی برای
-- تغییر نیست. این مایگریشن فقط قرارداد را در کامنت ستون ثبت می‌کند تا
-- واژگان یکتا بماند. کاملاً idempotent است.

comment on column public.team_runs.status is
  'وضعیت اجرای تیم: pending | running | success | failed (خطای سیستمی) | rejected (رد شده توسط منتقد) | skipped | stopped';
