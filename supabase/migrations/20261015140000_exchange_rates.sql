-- Migration: exchange_rates table for the «نرخ ارز» section
-- Project: thailandgard-dashboard (Next.js agentic dashboard)
--
-- One row per fetch from the Navasan API (4x daily via crons):
--   fetched_at: زمان دریافت نرخ‌ها
--   rates:     کل خروجی خام نوسان (jsonb)؛ هر ارز value/change/timestamp/date
--   source:    منبع داده ('navasan')
-- No mock data is ever written here: rows are created only from real API fetches.

create table if not exists public.exchange_rates (
  id          uuid        primary key default gen_random_uuid(),
  fetched_at  timestamptz not null default now(),
  rates       jsonb       not null default '{}'::jsonb,
  source      text        not null default 'navasan'
);

comment on table public.exchange_rates is 'Exchange rate snapshots from Navasan API (4x daily). Raw JSON per fetch; no mock data.';

create index if not exists idx_exchange_rates_fetched_at
  on public.exchange_rates (fetched_at desc);

alter table public.exchange_rates enable row level security;

create policy "service_role full access"
  on public.exchange_rates
  for all
  to service_role
  using (true)
  with check (true);
