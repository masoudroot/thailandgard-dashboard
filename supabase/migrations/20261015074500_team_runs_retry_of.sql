-- Migration: team_runs.retry_of (trace manual retries back to the failed run)
-- Project: thailandgard-dashboard
-- Table team_runs already has an `error` column (see 20261014193500_dashboard_schema.sql);
-- no error-column migration is needed. This only adds retry provenance.

alter table public.team_runs
  add column if not exists retry_of uuid references public.team_runs(id) on delete set null;

create index if not exists idx_team_runs_retry_of on public.team_runs (retry_of);

comment on column public.team_runs.retry_of is
  'When this row is a manual retry, the id of the failed team_runs row it retries.';
