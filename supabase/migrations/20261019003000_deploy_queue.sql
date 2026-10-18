-- deploy_queue: صف دیپلوی سیستم — ۷۰ اسلات ثابت در ۲۴ ساعت
--
-- دستور مسعود (۱۴۰۵/۰۷/۲۷): پچ‌های تأییدشده به‌جای مرج فوری dev به main،
-- وارد صف دیپلوی می‌شوند؛ هر ~۲۰.۵ دقیقه یک دیپلوی (۷۰ عدد در روز) تا
-- سقف ۱۰۰ دیپلوی روزانه ورسل هیچ‌وقت پر نشود (۳۰ اسلات حاشیه امن).
--
-- مدل:
-- - هر پچ مرج‌شده به dev یک ردیف در صف می‌گیرد (FIFO بر اساس slot_time)
-- - slot_timeها روی گرید ثابت روزانه‌اند: نیمه‌شب UTC + ‎i * (1440/70)‎ دقیقه
-- - پردازشگر آیتم‌های due (slot_time <= now) را به ترتیب برمی‌دارد و
--   mergeDevIntoMainBestEffort را اجرا می‌کند
-- - شکست: retry_count++ و بازگشت به صف با slot_time تازه؛ پس از ۳ تلاش → dead
--
-- این مایگریشن idempotent است: اجرای دوباره خطا نمی‌دهد.

create table if not exists public.deploy_queue (
  id uuid primary key default gen_random_uuid(),
  patch_id uuid not null,
  team text,
  status text not null default 'queued'
    check (status in ('queued', 'deploying', 'deployed', 'failed', 'dead')),
  queued_at timestamptz not null default now(),
  slot_time timestamptz not null,
  deployed_at timestamptz,
  retry_count int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- پردازشگر: آیتم‌های due به ترتیب slot_time
create index if not exists deploy_queue_status_slot_idx
  on public.deploy_queue (status, slot_time)
  where status in ('queued', 'failed');

-- جلوگیری از صف دوبل برای یک پچ فعال
create unique index if not exists deploy_queue_patch_active_uidx
  on public.deploy_queue (patch_id)
  where status in ('queued', 'deploying');

-- آمار روزانه: تعداد دیپلوی‌های امروز
create index if not exists deploy_queue_deployed_at_idx
  on public.deploy_queue (deployed_at)
  where status = 'deployed';

-- updated_at خودکار
create or replace function public.deploy_queue_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists deploy_queue_touch_updated_at on public.deploy_queue;
create trigger deploy_queue_touch_updated_at
  before update on public.deploy_queue
  for each row execute function public.deploy_queue_touch_updated_at();

comment on table public.deploy_queue is
  'صف دیپلوی: ۷۰ اسلات ثابت در روز؛ هر پچ تأییدشده یک اسلات می‌گیرد (FIFO).';
comment on column public.deploy_queue.slot_time is
  'زمان ثابت دیپلوی روی گرید روزانه (نیمه‌شب UTC + i*(1440/70) دقیقه).';
comment on column public.deploy_queue.status is
  'queued: در صف | deploying: در حال دیپلوی | deployed: موفق | failed: ناموفق (برمی‌گردد به صف) | dead: پس از ۳ تلاش ناموفق';
