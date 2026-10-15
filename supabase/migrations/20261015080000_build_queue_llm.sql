-- build_queue: انتخاب مدل هوش مصنوعی برای هر کار (دستور مسعود، ۱۴۰۵/۰۷/۲۳)
--
-- هر کار می‌تواند مدل خودش را داشته باشد (از میان endpointهای تعریف‌شده در
-- settings.llm_endpoints)، جدا از «مدل پیش‌فرض تیم» (settings.team_models).
-- اگر هر دو خالی باشند، مجری کار از متغیرهای محیطی استفاده می‌کند.
-- کلید API هرگز اینجا ذخیره نمی‌شود؛ فقط شناسه‌ی endpoint و نام مدل.

alter table public.build_queue
  add column if not exists llm_endpoint_id text;

alter table public.build_queue
  add column if not exists llm_model text;

comment on column public.build_queue.llm_endpoint_id is
  'شناسه‌ی endpoint در settings.llm_endpoints که این کار باید با آن اجرا شود؛ خالی یعنی پیش‌فرض تیم.';
comment on column public.build_queue.llm_model is
  'نام مدل انتخاب‌شده برای این کار؛ خالی یعنی پیش‌فرض تیم.';
