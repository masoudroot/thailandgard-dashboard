-- Migration: subagents (live sub-agent tracking + control) and memory_history.
--
-- subagents: one row per pipeline stage (supervisor / workers / critic, ...)
-- inside a team_runs row. The orchestrator creates/updates them from the
-- team's live progress reports; the dashboard shows them and lets the user
-- pause / resume / stop each sub-agent. Control is enforced by the
-- orchestrator at stage boundaries (see lib/orchestrator.ts).
--
-- memory_history: every superseded version of a team_memory entry, so the
-- memory page can show the full history of each record.

create table if not exists public.subagents (
  id          uuid        primary key default gen_random_uuid(),
  team_run_id uuid        not null references public.team_runs(id) on delete cascade,
  team        text        not null,
  label       text        not null,
  status      text        not null default 'pending',
  control     text        not null default 'run',
  current_task text,
  progress    int         not null default 0,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  updated_at  timestamptz not null default now(),
  unique (team_run_id, label)
);

comment on table public.subagents is
  'Pipeline stages (sub-agents) of a team run. control is run|pause|stop, enforced at stage boundaries.';

create index if not exists idx_subagents_team_run_id on public.subagents (team_run_id);

create or replace function public.subagents_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_subagents_touch_updated_at on public.subagents;

create trigger trg_subagents_touch_updated_at
  before update on public.subagents
  for each row
  execute function public.subagents_touch_updated_at();

alter table public.subagents enable row level security;

-- memory_history: superseded versions of team_memory rows.
create table if not exists public.memory_history (
  id            uuid        primary key default gen_random_uuid(),
  team          text        not null,
  key           text        not null,
  value         jsonb,
  superseded_at timestamptz not null default now()
);

comment on table public.memory_history is
  'Previous versions of team_memory entries; written by lib/memory.ts before each upsert.';

create index if not exists idx_memory_history_team_key on public.memory_history (team, key, superseded_at desc);

alter table public.memory_history enable row level security;
