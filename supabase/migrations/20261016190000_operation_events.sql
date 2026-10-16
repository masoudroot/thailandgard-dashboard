create table if not exists operation_events (
  id uuid primary key default gen_random_uuid(),
  cycle_id text not null,
  team text not null,
  event_type text not null,  -- prompt_sent | llm_response | critic_decision | error | status_change | cycle_started | cycle_finished | team_started | team_finished
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists operation_events_cycle_team_idx on operation_events (cycle_id, team, created_at);
create index if not exists operation_events_created_idx on operation_events (created_at desc);
alter table operation_events enable row level security;
-- service_role only (no policies = فقط service_role)
