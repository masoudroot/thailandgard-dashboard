-- دانش تیم‌های داشبورد تایلندگرد (تیم ۱: معماری داده)
-- قرارداد: ~/workspace/thailandgard-dashboard/KNOWLEDGE_CONTRACT.md
-- فقط DDL؛ بدون تغییر داده.

-- دسته‌بندی‌های هر تیم (درختی)
create table if not exists knowledge_categories (
  id uuid primary key default gen_random_uuid(),
  team text not null,
  name text not null,
  parent_id uuid references knowledge_categories(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists knowledge_categories_team_idx on knowledge_categories(team);

-- دانش هر تیم
create table if not exists team_knowledge (
  id uuid primary key default gen_random_uuid(),
  team text not null,
  title text not null,
  content text not null,
  category_id uuid references knowledge_categories(id) on delete set null,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists team_knowledge_team_idx on team_knowledge(team);
create index if not exists team_knowledge_cat_idx on team_knowledge(category_id);

-- ستون‌های تازه روی knowledge_chunks (جدول از قبل هست؛ vector 1536)
alter table knowledge_chunks add column if not exists team text;
alter table knowledge_chunks add column if not exists knowledge_id uuid references team_knowledge(id) on delete cascade;
create index if not exists knowledge_chunks_team_idx on knowledge_chunks(team);

-- تاریخچه نسخه‌ها
create table if not exists knowledge_history (
  id uuid primary key default gen_random_uuid(),
  knowledge_id uuid not null references team_knowledge(id) on delete cascade,
  team text not null,
  title text not null,
  content text not null,
  action text not null, -- 'create' | 'update' | 'delete'
  created_at timestamptz not null default now()
);
create index if not exists knowledge_history_kid_idx on knowledge_history(knowledge_id);
