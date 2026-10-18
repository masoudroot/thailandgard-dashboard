-- build_queue: منشأ 'tour-manager' به قید source_check (ممیزی B2، ۱۴۰۵/۰۷/۲۶)
--
-- تیم tour-manager (موج ۱) تسک‌هایش را با source='tour-manager' در build_queue می‌نویسد،
-- ولی قید قبلی فقط planner-weekly | critic | manual | leader را می‌پذیرفت.
-- نتیجه: هر insert با source='tour-manager' نقض قید می‌خورد و مکانیزم تنزل
-- enqueueTask (که روی زیررشتهٔ «source» در پیام خطا حساس بود) بی‌صدا فیلدهای
-- source/acceptance/estimate را می‌انداخت؛ هر ۳ تسک اول tour-manager بدون
-- معیار پذیرش و برآورد ثبت شدند. این مایگریشن ریشه را می‌بندد.
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
    check (source is null or source in ('planner-weekly', 'critic', 'manual', 'leader', 'tour-manager'));
end $$;

comment on column public.build_queue.source is
  'منشأ تسک: planner-weekly، critic، manual، leader یا tour-manager.';
