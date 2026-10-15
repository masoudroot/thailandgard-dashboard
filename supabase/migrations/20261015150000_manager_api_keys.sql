-- Migration: manager_api_keys table for the «مدیر داشبورد» (dashboard manager) API
-- Project: thailandgard-dashboard (Next.js agentic dashboard)
--
-- API keys that grant Mirza (the dashboard manager) full programmatic access
-- to /api/manager/* endpoints. Only the SHA-256 hash of each token is stored;
-- the raw token is shown once at creation and never persisted.

create table if not exists public.manager_api_keys (
  id           uuid        primary key default gen_random_uuid(),
  name         text        not null,
  token_hash   text        not null unique,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked      boolean     not null default false
);

comment on table public.manager_api_keys is 'Manager API keys for the autonomous dashboard manager (Mirza). Stores only SHA-256(token); raw tokens are never persisted.';

create index if not exists idx_manager_api_keys_token_hash
  on public.manager_api_keys (token_hash);

alter table public.manager_api_keys enable row level security;

create policy "service_role full access"
  on public.manager_api_keys
  for all
  to service_role
  using (true)
  with check (true);
