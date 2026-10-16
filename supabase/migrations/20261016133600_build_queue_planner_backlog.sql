-- build_queue: فیلدهای بک‌لاگ planner (قدم ۱، دستور مسعود، ۱۴۰۵/۰۷/۲۴)
--
-- تسک‌های هفتگی planner حالا این فیلدها را دارند:
--   source      منشأ تسک: planner-weekly | critic | manual
--   week_key    کلید هفته، مثل 2026-W42
--   acceptance  معیار قبولی تسک (متن آزاد)
--   estimate    برآورد تلاش: ۱=کم‌ریسک، ۲=متوسط، ۳=سنگین
--   depends_on  وابستگی به تسک دیگر (build_queue.id)، قابل نال
--   dedupe_key  کلید یکتاسازی همراه week_key
-- وضعیت جدید deferred به چرخه‌حیات اضافه شد.
-- قید یکتا روی (week_key, dedupe_key)، فقط وقتی week_key نال نیست.
--
-- این مایگریشن idempotent است: اجرای دوباره خطا نمی‌دهد.

-- ۱) source: منشأ تسک
alter table public.build_queue
  add column if not exists source text;

comment on column public.build_queue.source is
  'منشأ تسک: planner-weekly، critic یا manual.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.build_queue'::regclass
      and conname = 'build_queue_source_check'
  ) then
    alter table public.build_queue
      add constraint build_queue_source_check
      check (source is null or source in ('planner-weekly', 'critic', 'manual'));
  end if;
end $$;

-- ۲) week_key: کلید هفته
alter table public.build_queue
  add column if not exists week_key text;

comment on column public.build_queue.week_key is
  'کلید هفتهٔ planner، مثل 2026-W42؛ تسک‌های غیرهفته‌ای نال می‌مانند.';

-- ۳) acceptance: معیار قبولی تسک
alter table public.build_queue
  add column if not exists acceptance text;

comment on column public.build_queue.acceptance is
  'معیار قبولی تسک؛ متن آزاد.';

-- ۴) estimate: برآورد تلاش
alter table public.build_queue
  add column if not exists estimate integer;

comment on column public.build_queue.estimate is
  'برآورد تلاش: ۱=کم‌ریسک، ۲=متوسط، ۳=سنگین.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.build_queue'::regclass
      and conname = 'build_queue_estimate_check'
  ) then
    alter table public.build_queue
      add constraint build_queue_estimate_check
      check (estimate is null or estimate between 1 and 3);
  end if;
end $$;

-- ۵) depends_on: وابستگی به تسک دیگر
alter table public.build_queue
  add column if not exists depends_on uuid;

comment on column public.build_queue.depends_on is
  'وابستگی به تسک دیگر (build_queue.id)؛ نال یعنی بدون وابستگی.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.build_queue'::regclass
      and conname = 'build_queue_depends_on_fkey'
  ) then
    alter table public.build_queue
      add constraint build_queue_depends_on_fkey
      foreign key (depends_on) references public.build_queue(id) on delete set null;
  end if;
end $$;

-- ۶) dedupe_key: کلید یکتاسازی
alter table public.build_queue
  add column if not exists dedupe_key text;

comment on column public.build_queue.dedupe_key is
  'کلید یکتاسازی؛ همراه week_key یکتا می‌شود (فقط وقتی week_key نال نیست).';

-- ۷) وضعیت deferred در کنار وضعیت‌های موجود
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.build_queue'::regclass
      and conname = 'build_queue_status_check'
  ) then
    alter table public.build_queue
      drop constraint build_queue_status_check;
  end if;

  alter table public.build_queue
    add constraint build_queue_status_check
    check (status = any (array['pending', 'in_progress', 'deferred', 'done', 'failed', 'rejected']));
end $$;

-- ۸) قید یکتای جزئی روی (week_key, dedupe_key)
create unique index if not exists build_queue_week_dedupe_uniq
  on public.build_queue (week_key, dedupe_key)
  where week_key is not null;
