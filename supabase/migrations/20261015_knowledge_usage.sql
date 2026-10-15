-- Migration: knowledge usage tracking (team 9)
-- ردیابی استفاده از چانک‌های دانش و امتیاز مفید بودن

-- ۱) امتیاز مفید بودن روی چانک‌ها
alter table public.knowledge_chunks
  add column if not exists usefulness_score int not null default 0;
alter table public.knowledge_chunks
  add column if not exists use_count int not null default 0;
alter table public.knowledge_chunks
  add column if not exists last_used_at timestamptz;

comment on column public.knowledge_chunks.usefulness_score is
  'امتیاز مفید بودن: هر بار که تیم با این دانش خروجی تأییدشده داد +۱، در غیر این صورت −۱';
comment on column public.knowledge_chunks.use_count is
  'تعداد دفعاتی که این چانک در پرامپت تیمی تزریق شده';
comment on column public.knowledge_chunks.last_used_at is
  'آخرین باری که این چانک استفاده شد';

create index if not exists knowledge_chunks_usefulness_idx
  on public.knowledge_chunks (usefulness_score desc);

-- ۲) لاگ چانک‌های استفاده‌شده روی هر اجرای تیم
alter table public.team_runs
  add column if not exists knowledge_chunk_ids uuid[];

comment on column public.team_runs.knowledge_chunk_ids is
  'شناسه‌ی چانک‌های دانشی که در این اجرا در پرامپت تیم تزریق شدند (برای ردیابی مفید بودن)';

-- ۳) به‌روزرسانی RPC برای فیلتر تازگی و مرتب‌سازی با امتیاز مفید بودن
--    (اگر تابع از قبل هست، جایگزین می‌شود)
create or replace function public.match_knowledge_chunks(
  query_embedding vector(1536),
  match_count int default 5,
  filter_team text default null,
  max_age_days int default null
)
returns table (
  id uuid,
  knowledge_id uuid,
  source text,
  team text,
  title text,
  chunk text,
  similarity float,
  usefulness_score int
)
language plpgsql
as $$
begin
  return query
  select
    kc.id,
    kc.knowledge_id,
    kc.source,
    kc.team,
    kc.title,
    kc.chunk,
    1 - (kc.embedding <=> query_embedding) as similarity,
    kc.usefulness_score
  from public.knowledge_chunks kc
  where (filter_team is null or kc.team = filter_team)
    and (max_age_days is null or kc.created_at >= now() - (max_age_days || ' days')::interval)
  order by
    -- ترکیب شباهت معنایی (۷۰٪) و امتیاز مفید بودن (۳۰٪)
    (1 - (kc.embedding <=> query_embedding)) * 0.7
      + (greatest(kc.usefulness_score, 0)::float / 10.0) * 0.3 desc,
    kc.created_at desc
  limit match_count;
end;
$$;
