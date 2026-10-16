-- build_queue: منشأ 'leader' به قید source_check (دستور مسعود، ۱۴۰۵/۰۷/۲۴)
--
-- تیم leader (موج ۱) تسک‌هایش را با source='leader' در build_queue می‌نویسد.
-- قید قبلی فقط planner-weekly | critic | manual را می‌پذیرفت.
--
-- این مایگریشن idempotent است: اجرای دوباره خطا نمی‌دهد.

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.build_queue'::regclass
      and conname = 'build_queue_source_check'
  ) then
    alter table public.build_queue
      drop constraint build_queue_source_check;
  end if;
  alter table public.build_queue
    add constraint build_queue_source_check
    check (source is null or source in ('planner-weekly', 'critic', 'manual', 'leader'));
end $$;

comment on column public.build_queue.source is
  'منشأ تسک: planner-weekly، critic، manual یا leader.';
