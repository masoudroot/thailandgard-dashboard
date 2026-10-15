-- ============================================================
-- مدیریت دانش تیم‌ها: منابع، متادیتا و ردیابی استفاده (تیم ۲: اسکیما)
-- ============================================================
--
-- این مهاجرت سه نیاز پلن «ساب‌ایجنت دانش» را پوشش می‌دهد:
--
-- ۱) جدول knowledge_sources
--    فهرست منابع آموزشی و دانشی هر تیم (۱۵ تیم طبق KNOWLEDGE_CONTRACT.md).
--    ساب‌ایجنت دانش در شروع نوبت هر تیم، منابع فعال آن تیم را می‌خواند و
--    نکته‌های تازه را استخراج می‌کند. هر منبع این‌ها را دارد:
--      - url: نشانی منبع (به‌همراه team یکتا)
--      - source_type: نوع منبع (official-doc | expert-blog | research |
--        competitor | course | community | other)
--      - authority_tier: درجه اعتبار ۱ تا ۳؛ ۱ یعنی رسمی و بالاترین اعتبار
--        (مثل داک رسمی)، ۳ یعنی اجتماعی و کمترین اعتبار
--      - fetch_frequency_hours: هر چند ساعت یک‌بار بازخوانی شود (پیش‌فرض ۱۶۸ = هفتگی)
--      - last_fetched_at / last_fetch_status / last_fetch_error: وضعیت آخرین بازخوانی
--      - is_active: فعال یا غیرفعال بودن منبع
--
-- ۲) گسترش team_knowledge و knowledge_chunks (متادیتای دانش)
--    متادیتا در سطح «دانش» روی team_knowledge می‌نشیند، نه روی تک‌تک چانک‌ها:
--      - source_id: پیوند به رکورد منبع در knowledge_sources (nullable)
--      - authority_tier: درجه اعتبار ۱ تا ۳ (ارث از منبع یا دستی)
--      - origin: منشأ دانش (source-fetch | critic-lesson | manual | cross-team)؛
--        مهم‌ترین منشأ critic-lesson است: حکمی که منتقد تیم از خطای واقعی گرفته
--      - extracted_at: تاریخ استخراج دانش
--      - related_teams: آرایه‌ای از اسلاگ تیم‌های مرتبط (اشتراک بین‌تیمی)
--      - freshness_status: وضعیت تازگی (fresh | stale | archived)؛ دانش قدیمی
--        خودکار stale می‌شود و برای بازخوانی پرچم می‌خورد
--      - expires_at: تاریخ پیشنهادی بازبینی بعدی
--      - content_hash: هش محتوا برای تشخیص تکراری در خط لوله دریافت
--    روی knowledge_chunks فقط یک ستون سبک اضافه می‌شود:
--      - relevance_score: امتیاز ارتباط دستی چانک (null یعنی بدون امتیاز)
--
-- ۳) جدول knowledge_usage
--    ردیابی اینکه «کدام دانش، در کدام اجرای کدام تیم، در کدام چرخه» استفاده شد.
--    با این جدول می‌فهمیم هر دانش واقعاً به کار آمده یا فقط انبار شده است، و
--    می‌توانیم اثر دانش را روی خروجی تیم‌ها بسنجیم.
--
-- قراردادها:
--   - فقط DDL؛ بدون تغییر داده.
--   - بدون RLS؛ دسترسی فقط از طریق service_role (روال کل پروژه).
--   - همه ارجاع‌ها با on delete مناسب تا حذف آبشاری تمیز بماند.
-- ============================================================

-- ۱) منابع دانش هر تیم
create table if not exists knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  team text not null,
  url text not null,
  title text,
  source_type text not null default 'other'
    check (source_type in ('official-doc', 'expert-blog', 'research', 'competitor', 'course', 'community', 'other')),
  authority_tier smallint not null default 2
    check (authority_tier between 1 and 3),
  fetch_frequency_hours integer not null default 168
    check (fetch_frequency_hours > 0),
  last_fetched_at timestamptz,
  last_fetch_status text
    check (last_fetch_status is null or last_fetch_status in ('ok', 'failed')),
  last_fetch_error text,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team, url)
);
create index if not exists knowledge_sources_team_idx on knowledge_sources(team);
create index if not exists knowledge_sources_team_active_idx on knowledge_sources(team, is_active);

-- ۲) متادیتای دانش روی team_knowledge
alter table team_knowledge add column if not exists source_id uuid
  references knowledge_sources(id) on delete set null;
alter table team_knowledge add column if not exists authority_tier smallint
  check (authority_tier is null or authority_tier between 1 and 3);
alter table team_knowledge add column if not exists origin text not null default 'manual'
  check (origin in ('source-fetch', 'critic-lesson', 'manual', 'cross-team'));
alter table team_knowledge add column if not exists extracted_at timestamptz;
alter table team_knowledge add column if not exists related_teams text[] not null default '{}';
alter table team_knowledge add column if not exists freshness_status text not null default 'fresh'
  check (freshness_status in ('fresh', 'stale', 'archived'));
alter table team_knowledge add column if not exists expires_at timestamptz;
alter table team_knowledge add column if not exists content_hash text;
create index if not exists team_knowledge_source_idx on team_knowledge(source_id);
create index if not exists team_knowledge_freshness_idx on team_knowledge(freshness_status);
create index if not exists team_knowledge_related_teams_idx on team_knowledge using gin (related_teams);
create index if not exists team_knowledge_content_hash_idx on team_knowledge(content_hash);

-- ستون سبک روی چانک‌ها
alter table knowledge_chunks add column if not exists relevance_score real;

-- ۳) ردیابی استفاده دانش در اجراهای تیم‌ها
create table if not exists knowledge_usage (
  id uuid primary key default gen_random_uuid(),
  knowledge_id uuid not null
    references team_knowledge(id) on delete cascade,
  chunk_id uuid
    references knowledge_chunks(id) on delete cascade,
  team_run_id uuid not null
    references team_runs(id) on delete cascade,
  cycle_id uuid not null
    references cycles(id) on delete cascade,
  team text not null,
  used_at timestamptz not null default now()
);
create index if not exists knowledge_usage_knowledge_idx on knowledge_usage(knowledge_id);
create index if not exists knowledge_usage_team_run_idx on knowledge_usage(team_run_id);
create index if not exists knowledge_usage_cycle_idx on knowledge_usage(cycle_id);
create index if not exists knowledge_usage_team_idx on knowledge_usage(team);
