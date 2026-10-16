-- build_queue: وضعیت approved در قید status_check + تابع claim اتمیک (قدم ۳، دستور مسعود، ۱۴۰۵/۰۷/۲۴)
--
-- ۱) رفع باگ: کد markTaskApproved (lib/taskqueue.ts) وضعیت «approved» می‌نوشت ولی قید
--    build_queue_status_check این مقدار را نداشت و روی دیتابیس زنده خطای 23514 می‌داد.
--    حالا approved هم جزو مقادیر مجاز است (همه‌ی مقادیر قبلی حفظ شدند).
-- ۲) تابع claim_next_build_task(p_team): قدیمی‌ترین تسک pending یک تیم را اتمیک به
--    in_progress می‌برد و برمی‌گرداند. اگر تیم همین حالا تسک in_progress داشته باشد،
--    همان را برمی‌گرداند (idempotent؛ تسک جدید نمی‌دهد). ترتیب: critical، بعد high،
--    بعد medium، بعد low، و در هر اولویت قدیمی‌ترین.
--    سریال‌سازی claimهای هم‌زمانِ یک تیم با قفل مشورتی (advisory) روی نام تیم انجام
--    می‌شود؛ FOR UPDATE SKIP LOCKED هم از قفل‌شدن روی تسک‌های تیم‌های دیگر جلوگیری می‌کند.
--
-- این مایگریشن idempotent است: اجرای دوباره خطا نمی‌دهد.
-- توجه: روی دیتابیس زنده اجرا نشده؛ فقط فایل ساخته شده است.

-- ۱) قید status_check با approved
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
    check (status = any (array['pending', 'approved', 'in_progress', 'deferred', 'done', 'failed', 'rejected']));
end $$;

-- ۲) تابع claim اتمیک
create or replace function public.claim_next_build_task(p_team text)
returns public.build_queue
language plpgsql
as $$
declare
  claimed public.build_queue;
begin
  -- سریال‌سازی claimهای هم‌زمانِ همین تیم تا پایان تراکنش
  perform pg_advisory_xact_lock(hashtext(p_team));

  -- idempotent: اگر تیم همین حالا تسک in_progress دارد، همان را برگردان
  select * into claimed
  from public.build_queue q
  where q.team = p_team
    and q.status = 'in_progress'
  order by q.created_at asc
  limit 1;

  if not found then
    -- اتمیک: قدیمی‌ترین pending با بالاترین اولویت را claim کن
    update public.build_queue b
    set status = 'in_progress'
    where b.id = (
      select q.id
      from public.build_queue q
      where q.team = p_team
        and q.status = 'pending'
      order by
        case q.priority
          when 'critical' then 0
          when 'high' then 1
          when 'medium' then 2
          when 'low' then 3
          else 4
        end,
        q.created_at asc
      limit 1
      for update skip locked
    )
    returning * into claimed;
  end if;

  return claimed;
end;
$$;

comment on function public.claim_next_build_task(text) is
  'قدیمی‌ترین تسک pending یک تیم را اتمیک به in_progress می‌برد و برمی‌گرداند؛ اگر تیم تسک in_progress داشته باشد همان را برمی‌گرداند.';
