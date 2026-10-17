-- build_queue: پذیرش 'critical' در قید build_queue_priority_check
--
-- ریشهٔ خطای چرخهٔ run-20261017044522-rq2ho6: تایپ QueuedTask['priority']
-- چهار مقدار low | medium | high | critical را مجاز می‌داند و تیم leader
-- برای «هشدار سفر فوری» اولویت critical می‌سازد، ولی قید دیتابیس فقط
-- high | medium | low را قبول داشت و INSERT با خطای 23514 می‌مرد.
--
-- این مایگریشن idempotent است: اجرای دوباره خطا نمی‌دهد.

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.build_queue'::regclass
      and conname = 'build_queue_priority_check'
  ) then
    alter table public.build_queue
      drop constraint build_queue_priority_check;
  end if;
  alter table public.build_queue
    add constraint build_queue_priority_check
    check (priority in ('high', 'medium', 'low', 'critical'));
end $$;
