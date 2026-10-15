# قرارداد پروژه دانش (Knowledge) - داشبورد تایلندگرد

همه ۲۰ تیم باید دقیقاً همین قرارداد را رعایت کنند تا تداخل پیش نیاید.

## تیم‌ها (slug)
`artdir` `branding` `content` `seo` `analytics` `intel` `lead` `design` `seocontent` `vibefarsi` `farsiui` `design-ir` `dev` `qa` `inspector`
نام فارسی و مأموریت هر تیم در `lib/team-meta.ts` (TEAM_META) است.

## اسکیمای دیتابیس (فقط تیم ۱ مایگریشن می‌نویسد و اعمال می‌کند)

```sql
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

-- دسته‌بندی‌های هر تیم (درختی)
create table if not exists knowledge_categories (
  id uuid primary key default gen_random_uuid(),
  team text not null,
  name text not null,
  parent_id uuid references knowledge_categories(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists knowledge_categories_team_idx on knowledge_categories(team);

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
```

نام فایل مایگریشن: `supabase/migrations/20261015140000_team_knowledge.sql`
اعمال روی دیتابیس واقعی با تونل (الگو در `~/TOOLS.md` بخش Supabase) - فقط DDL.

## lib/rag.ts (قرارداد توابع - تیم ۲ و ۳)

```ts
// امبدینگ با resolveEmbeddingConfig() از lib/llm-endpoints.ts (نه env مستقیم)
export async function getEmbedding(text: string): Promise<number[]>
// جست‌وجوی معنایی؛ team اختیاری برای فیلتر؛ خروجی رشته فارسی آماده تزریق به پرامپت
export async function retrieveKnowledge(query: string, team?: string, limit?: number): Promise<string>
// ایندکس کردن یک دانش تازه (چانک‌بندی + امبدینگ + درج در knowledge_chunks)
export async function indexKnowledge(knowledgeId: string, team: string, title: string, content: string): Promise<void>
// حذف ایندکس یک دانش
export async function deleteKnowledgeIndex(knowledgeId: string): Promise<void>
// کانتکست آماده برای تزریق در پرامپت تیم‌ها
export async function getTeamKnowledgeContext(team: string, task: string): Promise<string>
```

## API ها (تیم ۱۱ و ۱۲)

- `GET /api/knowledge` → `{ ok, data: { teams: [{ team, faName, count, categoryCount, lastUpdated, score }] } }`
- `GET /api/knowledge/[team]` → `{ ok, data: { team, faName, mission, categories: [{ id, name, parent_id, items: [{ id, title, snippet, source, updated_at }] }] } }`
- `POST /api/knowledge` → body `{ team, title, content, category_id?, source? }` → ساخت + ثبت history + ایندکس RAG
- `PUT /api/knowledge/[id]` → ویرایش + history + ری‌ایندکس
- `DELETE /api/knowledge/[id]` → حذف + history + حذف ایندکس
- `GET/POST /api/knowledge/categories` → body `{ team, name, parent_id? }`
- `DELETE /api/knowledge/categories/[id]`
- `POST /api/knowledge/search` → body `{ query, team?, limit? }` → `{ ok, data: { results: [{ id, team, title, snippet, score }] } }`

همه با `ok/fail` از `lib/api.ts` و احراز ادمین (میان‌افزار موجود).

## صفحه‌ها (تیم ۵ و ۶)

- `app/dashboard/knowledge/page.tsx` - نمای کلی: کارت هر ۱۵ تیم (نام فارسی، تعداد دانش، امتیاز، آخرین به‌روزرسانی شمسی)
- `app/dashboard/knowledge/[team]/page.tsx` - دانش تیم: درخت دسته‌ها + آیتم‌ها، باکس جست‌وجو، دکمه افزودن
- لینک «دانش» به ناوبری داشبورد اضافه شود (`app/dashboard/layout.tsx`)

## قوانین سراسری
- فارسی، بدون U+2014، هیچ داده نمایشی
- موبایل‌فرست، خلوت، تم گرافیت
- به کد تیم‌های دیگر (`lib/teams/*.ts` جز نقطه اتصال RAG) دست نزن
- `npx tsc --noEmit` و `npm run build` سبز قبل از تحویل
