-- Migration: debug_sessions table for the «دستیار فنی» section (Team 4)
-- Project: thailandgard-dashboard (Next.js agentic dashboard)
--
-- One row per debugging session started from /dashboard/debug:
--   bug_desc:  شرح باگ از زبان مسعود
--   diagnosis: تشخیص ساخت‌یافتهٔ ۴ نقشه (jsonb) به‌علاوهٔ زمینهٔ واقعی جمع‌شده
--   status:    open | analyzed | applied | needs_info
-- No mock data is ever written here: rows are created only from real sessions.

create table if not exists public.debug_sessions (
  id          uuid        primary key default gen_random_uuid(),
  bug_desc    text        not null,
  diagnosis   jsonb       not null default '{}'::jsonb,
  status      text        not null default 'open',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.debug_sessions is 'Debug assistant sessions: bug description, structured 4-role diagnosis, lifecycle status.';

create index if not exists idx_debug_sessions_created_at
  on public.debug_sessions (created_at desc);

alter table public.debug_sessions enable row level security;

create policy "service_role full access"
  on public.debug_sessions
  for all
  to service_role
  using (true)
  with check (true);
