-- Migration: separate liveness (heartbeat) from progress on team_runs
--
-- ریشه‌ی باگ «نگهبان هنگ را نمی‌بیند»:
-- تریگر trg_team_runs_touch_updated_at روی «هر» UPDATE ستون updated_at را
-- تازه می‌کرد؛ ضربان ۶۰ ثانیه‌ای ارکستراتور هم ردیف را لمس می‌کرد و
-- updated_at همیشه تازه می‌ماند. نتیجه: تیمی که ضربان می‌زد ولی هیچ
-- پیشرفتی نمی‌کرد، برای واچ‌داگ و ورکر «سالم» دیده می‌شد و قانون
-- «تیم هنگ‌کرده باید در ۱۰ دقیقه شناسایی شود» عملاً نقض می‌شد.
--
-- این مایگریشن دو سیگنال را از هم جدا می‌کند:
--   heartbeat_at  سیگنال «فرایند زنده است» (ضربان هر ۶۰ ثانیه فقط همین را می‌نویسد)
--   updated_at    سیگنال «آخرین پیشرفت واقعی» (تغییر وضعیت/درصد/مرحله/خروجی/خطا)
-- تریگر بازنویسی می‌شود: اگر UPDATE فقط heartbeat_at را عوض کرده باشد،
-- updated_at دست‌نخورده می‌ماند؛ در غیر این صورت مثل قبل تازه می‌شود.
-- (مقایسه‌ی jsonb نسبت به افزودن ستون‌های آینده مقاوم است.)

alter table public.team_runs
  add column if not exists heartbeat_at timestamptz;

create or replace function public.team_runs_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  -- فقط ضربان عوض شده؟ پس پیشرفت جدیدی رخ نداده؛ updated_at را نگه دار.
  if to_jsonb(new) - 'heartbeat_at' - 'updated_at'
     = to_jsonb(old) - 'heartbeat_at' - 'updated_at' then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end;
$$;

-- تریگر از مایگریشن قبلی روی جدول هست؛ فقط تابعش بازنویسی شد.
-- برای اطمینان، دوباره می‌سازیم (idempotent):
drop trigger if exists trg_team_runs_touch_updated_at on public.team_runs;

create trigger trg_team_runs_touch_updated_at
  before update on public.team_runs
  for each row
  execute function public.team_runs_touch_updated_at();

comment on column public.team_runs.heartbeat_at is
  'آخرین ضربان زنده‌بودن فرایند تیم (هر ۶۰ ثانیه)؛ مبنای تشخیص «مرگ فرایند»، نه «پیشرفت».';
comment on column public.team_runs.updated_at is
  'آخرین پیشرفت واقعی ردیف (تغییر وضعیت، درصد، مرحله، خروجی، خطا)؛ ضربانِ خالص آن را تازه نمی‌کند.';
