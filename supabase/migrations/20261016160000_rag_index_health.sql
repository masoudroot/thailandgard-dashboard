-- سلامت مسیر ایندکس دانش (تیم ۳، رفع ریشه‌ای مشکل ۳: «جست‌وجوی معنایی ۷ روز مرده»)
--
-- زمینه: مایگریشن 20261016070000 جدول knowledge_chunks را کامل خالی کرد و وعده‌ی
-- «اسکریپت ری‌ایندکس» داد، ولی آن اسکریپت هرگز ساخته نشد. هم‌زمان همه‌ی مسیرهای
-- فراخوانی indexKnowledge خطا را بی‌صدا می‌بلعیدند (catch خالی در
-- lib/knowledge.ts و lib/knowledge-subagent.ts و warning فقط در پاسخ JSON
-- روت‌های API). نتیجه: ۱۳۵ ران بدون حتی یک چانک ایندکس‌شده و هیچ‌کس نفهمید.
--
-- این مایگریشن زیرساخت «هیچ خطای ایندکسی بی‌صدا نماند» را می‌سازد:
-- ۱. rag_index_health: شمارنده‌ی اتمیک موفقیت/شکست + خطاهای پیاپی (الگوی
--    llm_model_health در مایگریشن 20261015220000).
-- ۲. rag_index_events: تاریخچه‌ی هر رویداد ایندکس (برای دیباگ).
-- ۳. ستون‌های index_status/index_error/index_attempted_at روی team_knowledge:
--    وضعیت ایندکس هر دانش، قابل راستی‌آزمایی در پنل.
-- ۴. تابع record_rag_index_outcome: ثبت اتمیک یک نتیجه (آپسرت شمارنده + درج
--    رویداد + به‌روزرسانی ردیف team_knowledge) در یک تراکنش؛ security definer
--    تا از هر کلاینتی (service_role/anon) قابل صدا زدن باشد.
-- تصمیم هشدار (آستانه‌ی N خطای پیاپی) سمت کد است: lib/rag-index-health.ts.

create table if not exists public.rag_index_health (
  scope text primary key default 'global',
  consecutive_failures integer not null default 0,
  total_failures bigint not null default 0,
  total_successes bigint not null default 0,
  last_error text,
  last_error_at timestamptz,
  last_success_at timestamptz,
  alert_sent_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.rag_index_health is
  'سلامت مسیر ایندکس دانش: شمارنده‌ی اتمیک موفقیت/شکست و خطاهای پیاپی؛ هشدار بعد از N خطای پیاپی (lib/rag-index-health.ts)';

create table if not exists public.rag_index_events (
  id bigserial primary key,
  knowledge_id uuid,
  team text,
  status text not null, -- 'indexed' | 'failed'
  error text,
  source text, -- کدام مسیر فراخوانی: tryIndexKnowledge | knowledge-subagent | critic-knowledge | api/...
  created_at timestamptz not null default now()
);

create index if not exists rag_index_events_created_idx
  on public.rag_index_events (created_at desc);
create index if not exists rag_index_events_status_idx
  on public.rag_index_events (status, created_at desc);

comment on table public.rag_index_events is
  'تاریخچه‌ی هر رویداد ایندکس دانش (موفق/ناموفق) برای دیباگ؛ پاک‌سازی دوره‌ای لازم ندارد (حجم کم)';

-- وضعیت ایندکس روی هر ردیف دانش (قابل نمایش در پنل مدیریت دانش)
alter table public.team_knowledge
  add column if not exists index_status text not null default 'unknown';
alter table public.team_knowledge
  add column if not exists index_error text;
alter table public.team_knowledge
  add column if not exists index_attempted_at timestamptz;

comment on column public.team_knowledge.index_status is
  'وضعیت آخرین تلاش ایندکس معنایی: unknown | indexed | failed';

-- بازپر کردن وضعیت دانش‌های موجود: هر دانشی که چانک دارد، ایندکس‌شده حساب می‌شود
update public.team_knowledge k
set index_status = 'indexed',
    index_attempted_at = kc.first_chunk_at
from (
  select knowledge_id, min(created_at) as first_chunk_at
  from public.knowledge_chunks
  where knowledge_id is not null
  group by knowledge_id
) kc
where kc.knowledge_id = k.id
  and k.index_status = 'unknown';

-- ثبت اتمیک یک نتیجه‌ی ایندکس: آپسرت شمارنده + درج رویداد + به‌روزرسانی ردیف دانش.
-- برمی‌گرداند: خطاهای پیاپی فعلی، جمع شکست‌ها، جمع موفقیت‌ها، زمان آخرین هشدار
-- (کد با همین خروجی تصمیم می‌گیرد هشدار بدهد یا نه).
create or replace function public.record_rag_index_outcome(
  p_scope text,
  p_ok boolean,
  p_error text,
  p_knowledge_id uuid,
  p_team text,
  p_source text
)
returns table (
  consecutive_failures integer,
  total_failures bigint,
  total_successes bigint,
  alert_sent_at timestamptz
)
language plpgsql
security definer
as $$
declare
  v_fails integer;
  v_total_f bigint;
  v_total_s bigint;
  v_alert timestamptz;
begin
  insert into public.rag_index_health (
    scope, consecutive_failures, total_failures, total_successes,
    last_error, last_error_at, last_success_at, updated_at
  )
  values (
    p_scope,
    case when p_ok then 0 else 1 end,
    case when p_ok then 0 else 1 end,
    case when p_ok then 1 else 0 end,
    case when p_ok then null else p_error end,
    case when p_ok then null else now() end,
    case when p_ok then now() else null end,
    now()
  )
  on conflict (scope) do update set
    consecutive_failures = case
      when p_ok then 0
      else public.rag_index_health.consecutive_failures + 1
    end,
    total_failures = public.rag_index_health.total_failures + case when p_ok then 0 else 1 end,
    total_successes = public.rag_index_health.total_successes + case when p_ok then 1 else 0 end,
    last_error = case when p_ok then public.rag_index_health.last_error else p_error end,
    last_error_at = case when p_ok then public.rag_index_health.last_error_at else now() end,
    last_success_at = case when p_ok then now() else public.rag_index_health.last_success_at end,
    updated_at = now()
  returning
    public.rag_index_health.consecutive_failures,
    public.rag_index_health.total_failures,
    public.rag_index_health.total_successes,
    public.rag_index_health.alert_sent_at
  into v_fails, v_total_f, v_total_s, v_alert;

  insert into public.rag_index_events (knowledge_id, team, status, error, source)
  values (
    p_knowledge_id,
    p_team,
    case when p_ok then 'indexed' else 'failed' end,
    case when p_ok then null else left(p_error, 500) end,
    p_source
  );

  if p_knowledge_id is not null then
    update public.team_knowledge
    set index_status = case when p_ok then 'indexed' else 'failed' end,
        index_error = case when p_ok then null else left(p_error, 500) end,
        index_attempted_at = now()
    where id = p_knowledge_id;
  end if;

  return query select v_fails, v_total_f, v_total_s, v_alert;
end;
$$;

comment on function public.record_rag_index_outcome(text, boolean, text, uuid, text, text) is
  'ثبت اتمیک نتیجه‌ی یک تلاش ایندکس دانش (موفق/ناموفق) + به‌روزرسانی شمارنده‌ی سلامت';
