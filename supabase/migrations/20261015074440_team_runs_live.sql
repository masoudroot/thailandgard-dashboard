-- Migration: live activity for team_runs (dashboard "فعالیت زنده" page)
--
-- Adds the columns the live-activity page needs:
--   progress      integer 0..100, live progress of the team run
--   current_task  text,     title of the current stage (last reported)
--   updated_at    timestamptz, last write to the row (basis of "last action X ago")
-- plus a trigger that refreshes updated_at on every UPDATE, so the
-- orchestrator heartbeat and progress writes automatically keep it fresh.

alter table public.team_runs
  add column if not exists progress int not null default 0;

alter table public.team_runs
  add column if not exists current_task text;

alter table public.team_runs
  add column if not exists updated_at timestamptz not null default now();

create or replace function public.team_runs_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_team_runs_touch_updated_at on public.team_runs;

create trigger trg_team_runs_touch_updated_at
  before update on public.team_runs
  for each row
  execute function public.team_runs_touch_updated_at();

comment on column public.team_runs.progress is 'Live progress percent (0-100), written by the orchestrator/team modules.';
comment on column public.team_runs.current_task is 'Title of the current stage, last reported by the team module.';
comment on column public.team_runs.updated_at is 'Last write to this row; basis of the "last action X ago" display.';
