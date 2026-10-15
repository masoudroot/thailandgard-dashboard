-- جدول حسابرسی فایل‌های کد تولیدشده توسط تیم‌ها (سندباکس کد).
-- هر فایل با هش SHA-256 واقعی بایت‌های روی دیسک ثبت می‌شود تا قابل راستی‌آزمایی باشد.

create table if not exists team_code_files (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references cycles(id) on delete cascade,
  team text not null,
  run_id text not null,
  path text not null,
  sha256 text not null,
  bytes integer not null,
  lines integer not null,
  target_repo text not null,
  branch text,
  commit_sha text,
  pushed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists team_code_files_cycle_team_idx
  on team_code_files (cycle_id, team);

create index if not exists team_code_files_run_idx
  on team_code_files (run_id);
