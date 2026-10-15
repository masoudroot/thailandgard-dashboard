-- 20261015220000: یکتایی پچ در هر چرخه برای هر تیم
-- یک تیم در یک چرخه فقط یک پچ پیشنهادی می‌تواند ثبت کند؛ ثبت تکراری
-- (مثلاً تلاش مجدد ورکر) با خطای 23505 رد می‌شود و ارکستر ردیف موجود را برمی‌گرداند.
-- افزایشی و idempotent: IF NOT EXISTS.

do $$
begin
  -- اگر از قبل تکراری هست، قدیمی‌ترین را نگه می‌داریم و بقیه را پاک می‌کنیم
  delete from public.bridge_patches a
  using public.bridge_patches b
  where a.id > b.id
    and a.cycle_id is not distinct from b.cycle_id
    and a.team is not distinct from b.team;
exception when others then
  -- جدول هنوز نیست؛ نادیده
  null;
end $$;

alter table public.bridge_patches
  drop constraint if exists bridge_patches_cycle_team_uniq;

alter table public.bridge_patches
  add constraint bridge_patches_cycle_team_uniq
  unique nulls not distinct (cycle_id, team);
