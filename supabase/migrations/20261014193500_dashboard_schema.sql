-- Migration: agentic dashboard schema (cycles, team_runs, notifications, settings)
-- Project: thailandgard-dashboard (Next.js replacement for n8n orchestration of 15 AI teams)
-- Existing tables (reference only, NOT recreated): build_queue, team_memory, agent_state, knowledge_chunks

-- ============================================================================
-- 1) cycles: one row per orchestrated cycle run
-- ============================================================================
create table if not exists public.cycles (
  id          uuid        primary key default gen_random_uuid(),
  run_id      text        not null unique,
  status      text        not null default 'running',
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  stats       jsonb       not null default '{}'::jsonb,
  error       text
);

comment on table public.cycles is 'Orchestration cycle runs. stats holds: teams count, llm calls, total duration.';

-- ============================================================================
-- 2) team_runs: per-team execution within a cycle (15 teams, 3 waves of 5)
-- ============================================================================
create table if not exists public.team_runs (
  id             uuid        primary key default gen_random_uuid(),
  cycle_id       uuid        not null references public.cycles(id) on delete cascade,
  team           text        not null,
  wave           int         not null default 1,
  status         text        not null default 'running',
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  output_summary text,
  llm_calls      int         not null default 0,
  error          text
);

comment on table public.team_runs is 'Per-team run inside a cycle. output_summary is the final brief from the team.';

-- ============================================================================
-- 3) notifications: outbound messages (telegram) from the dashboard
-- ============================================================================
create table if not exists public.notifications (
  id                  uuid        primary key default gen_random_uuid(),
  cycle_id            uuid        references public.cycles(id) on delete cascade,
  team                text        not null,
  message             text        not null,
  channel             text        not null default 'telegram',
  sent_at             timestamptz not null default now(),
  telegram_message_id text,
  status              text        not null default 'sent'
);

comment on table public.notifications is 'Outbound notifications (telegram). cycle_id nullable for non-cycle alerts.';

-- ============================================================================
-- 4) settings: dashboard configuration (models, schedule, thresholds)
-- ============================================================================
create table if not exists public.settings (
  key        text        primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now()
);

comment on table public.settings is 'Dashboard settings: llm models, cron schedule, alert thresholds.';

-- ============================================================================
-- Indexes
-- ============================================================================
create index if not exists idx_team_runs_cycle_id on public.team_runs (cycle_id);
create index if not exists idx_notifications_cycle_id on public.notifications (cycle_id);
-- cycles(run_id): unique constraint above already creates the backing index

-- ============================================================================
-- Row Level Security: enable + permissive policy for service_role only
-- (same pattern as existing tables: RLS on, only service_role can access)
-- ============================================================================
alter table public.cycles        enable row level security;
alter table public.team_runs     enable row level security;
alter table public.notifications enable row level security;
alter table public.settings      enable row level security;

create policy "service_role full access"
  on public.cycles
  for all
  to service_role
  using (true)
  with check (true);

create policy "service_role full access"
  on public.team_runs
  for all
  to service_role
  using (true)
  with check (true);

create policy "service_role full access"
  on public.notifications
  for all
  to service_role
  using (true)
  with check (true);

create policy "service_role full access"
  on public.settings
  for all
  to service_role
  using (true)
  with check (true);
