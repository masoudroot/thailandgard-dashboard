-- Claim اتمیک تیم: فقط یک ردیف running برای هر (cycle_id, team)
-- این ایندکس جزئی باعث می‌شود دو ورکر هم‌زمان نتوانند یک تیم را claim کنند؛
-- دومی خطای unique violation (23505) می‌گیرد و تابع claimTeam در lib/lock.ts
-- آن را به null تبدیل می‌کند (یعنی «تیم را دیگری برداشت»).
--
-- چرا جزئی (WHERE status='running')؟ چون تاریخچه‌ی اجراهای قبلی (success/failed)
-- باید بماند و فقط نباید دو اجرای «زنده» هم‌زمان برای یک تیم وجود داشته باشد.

create unique index if not exists team_runs_one_running_per_team
  on public.team_runs (cycle_id, team)
  where status = 'running';

comment on index public.team_runs_one_running_per_team is
  'تضمین اتمیک‌بودن claim تیم: فقط یک team_runs با وضعیت running برای هر تیم در هر چرخه';
