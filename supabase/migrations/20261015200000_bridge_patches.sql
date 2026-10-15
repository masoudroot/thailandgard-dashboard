-- 20261015200000: bridge_patches — پچ‌های پل بین تیم‌ها
-- جدول کاری پل: هر ردیف یک پچ پیشنهادی یک تیم است که از چرخهٔ پل عبور می‌کند.
-- وضعیت‌ها: proposed → gated → committed → approved → merged؛ یا rejected / rolledback.
-- افزایشی و idempotent: IF NOT EXISTS؛ اجرای دوباره بی‌اثر است.
-- RLS فعال بدون پالیسی: خواندن/نوشتن فقط با service_role از سمت سرور
-- (الگوی جدول‌های داخلی مثل call_clicks و lead_status_history).

create table if not exists public.bridge_patches (
  id          uuid primary key default gen_random_uuid(),
  cycle_id    uuid,
  team        text,
  summary     text,
  files       jsonb not null default '[]'::jsonb,
  status      text not null default 'proposed'
              check (status in ('proposed', 'gated', 'committed', 'approved', 'merged', 'rejected', 'rolledback')),
  branch      text,
  commit_sha  text,
  merge_sha   text,
  gate_errors jsonb,
  decided_by  text,
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_bridge_patches_status on public.bridge_patches (status);
create index if not exists idx_bridge_patches_cycle on public.bridge_patches (cycle_id);

comment on table public.bridge_patches is
  'پچ‌های پل بین تیم‌ها: {path, content} در files، گیت وضعیت با gate_errors';
comment on column public.bridge_patches.files is
  'آرایهٔ JSON از آبجکت‌های {path, content}';

alter table public.bridge_patches enable row level security;
-- عمداً هیچ پالیسی نیست: همهٔ دسترسی‌ها فقط با service_role از سمت سرور انجام می‌شود؛
-- service_role ذاتاً از RLS رد می‌شود و پالیسی جدا نمی‌خواهد.
