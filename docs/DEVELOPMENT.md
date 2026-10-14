# راهنمای توسعه‌دهنده‌ی داشبورد ایجنتیک تایلندگرد

این راهنما برای کسی است که می‌خواهد روی همین پروژه کار کند: از نصب تا اضافه کردن تیم یا صفحه‌ی تازه.

## نصب و اجرا

```bash
# ۱. نصب وابستگی‌ها
npm install

# ۲. ساخت فایل محیطی
cp .env.example .env.local
# بعد مقدارها را داخل .env.local بگذار؛ نمونه‌ی متغیرها در .env.example هست
```

> ⚠️ قانون اجباری: `.env.local` و هر فایل `.env*` هرگز کامیت نمی‌شود (در `.gitignore` آمده). هیچ سکرتی در گیت نباشد. قبل از هر پوش، `git status` را چک کن.

```bash
# ۳. اجرای مایگریشن دیتابیس (Supabase)
# فایل supabase/migrations/20261014193500_dashboard_schema.sql را
# با supabase CLI یا از SQL Editor داشبورد Supabase اجرا کن

# ۴. اجرای محیط توسعه
npm run dev
```

بعد مرورگر را باز کن: `http://localhost:3000`

### اسکریپت‌های package.json

| اسکریپت | کار |
| --- | --- |
| `npm run dev` | سرور توسعه |
| `npm run build` | بیلد پروداکشن |
| `npm start` | اجرای بیلد پروداکشن |
| `npm run lint` | بررسی ESLint |
| `npm run typecheck` | بررسی تایپ با `tsc --noEmit` |

### متغیرهای محیطی

| متغیر | کاربرد | سمت |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_URL` | آدرس پروژه‌ی سوپابیس | عمومی / سرور |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | کلید anon سوپابیس | عمومی |
| `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_SERVICE_KEY` | کلید سرویس (دسترسی کامل به جدول‌ها) | فقط سرور، هرگز به کلاینت نرود |
| `ADMIN_PASSWORD` | رمز ورود به پنل ادمین | سرور |
| `AUTH_SECRET` | راز سشن و احراز | سرور |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | ربات اعلان‌ها | سرور |
| `LLM_API_KEY` / `LLM_API_BASE` | درگاه مدل زبانی تیم‌ها | سرور |

## ساختار پوشه‌ها

```
thailandgard-dashboard/
├── app/
│   ├── dashboard/        # صفحه‌ها: page، cycles، teams، queue، memory، reports، settings
│   ├── login/            # صفحه‌ی ورود
│   └── api/              # روت هندلرها (auth، cycles، teams، tasks، memory، queue، notify، planning، rag، health)
├── components/           # کامپوننت‌های React داشبورد
├── lib/
│   ├── types.ts          # تنها منبع حقیقت: TEAMS و WAVES
│   ├── orchestrator.ts   # رهبری چرخه
│   ├── teams/            # منطق هر تیم، یک فایل برای هر تیم
│   └── ...               # llm، rag، memory، notify، planning، queue، taskqueue، auth، api
├── supabase/
│   └── migrations/       # مایگریشن‌های SQL
└── docs/                 # همین راهنما
```

## اضافه کردن تیم جدید

تیم‌ها فقط در دو جا تعریف می‌شوند؛ هر دو را باید عوض کرد.

۱. در `lib/types.ts`: نام تیم را به `TeamName`، به آرایه‌ی `TEAMS` و به یکی از موج‌های `WAVES` اضافه کن. قانون: `TEAMS` و `WAVES` تنها منبع حقیقت‌اند؛ هیچ‌جای دیگری فهرست تیم‌ها را سخت‌کد نکن.

۲. یک فایل تازه در `lib/teams/` بساز به اسم همان تیم، مثلاً `lib/teams/newsocial.ts`. ارکستراتور این فایل را داینامیک ایمپورت می‌کند، پس باید یک تابع `runTeam` با این امضا صادر کند:

```ts
import type { TeamInput } from '../orchestrator';
import type { TeamResult } from '../types';

export async function runTeam(input: TeamInput): Promise<TeamResult> {
  // input.cycleId، input.runId، input.ragContext، input.memory، input.previousWavesOutput
  return {
    team: 'newsocial',
    summary: '...',
    blockers: [],
    tasks: [],
    approved: true,
  };
}
```

نکته‌ها:

- ورودی تیم حافظه‌ی ذخیره‌شده‌اش (`input.memory`) و خروجی موج‌های قبلی (`input.previousWavesOutput`) را دارد؛ از آن‌ها استفاده کن.
- اگر می‌خواهی چیزی را برای چرخه‌های بعدی نگه داری، با `lib/memory.ts` در جدول `team_memory` بنویس.
- اگر تیمت وظیفه‌ی پیشنهادی دارد، آرایه‌ی `tasks` را پر کن (عنوان، توضیح، اولویت)؛ وارد صف وظایف می‌شود.
- اگر فایل تیم ساخته نشده باشد، آن تیم `fail` می‌شود ولی چرخه ادامه می‌یابد؛ پس فایل را فراموش نکن.
- بعد از اضافه کردن، `npm run typecheck` را بزن.

## اضافه کردن صفحه‌ی داشبورد

۱. پوشه‌ی تازه‌ای در `app/dashboard/` بساز با یک فایل `page.tsx`؛ مثلاً `app/dashboard/alerts/page.tsx`. مسیر صفحه همان نام پوشه است: `/dashboard/alerts`.

۲. لینک صفحه را در ناوبری داشبورد (`app/dashboard/layout.tsx` یا کامپوننت منو در `components/`) اضافه کن تا دیده شود.

۳. داده را از APIهای همین پروژه بگیر (`/api/cycles`، `/api/tasks` و...) نه مستقیم از سوپابیس؛ کلید سرویس فقط سمت سرور است و در کلاینت نباید استفاده شود.

۴. برای چرخه‌ی شروع و متوقف کردن، از همان اندپوینت‌ها استفاده کن (`POST /api/cycles`).

۵. قرارداد UI: راست‌چین و فارسی؛ کامپوننت‌های موجود در `components/` را اول ببین و همان سبک را نگه دار.

## کار با دیتابیس

- مایگریشن‌های تازه را به‌ترتیب تاریخ در `supabase/migrations/` بگذار و از SQL Editor یا CLI اجرا کن.
- روی جدول‌های پروژه RLS فعال است؛ فقط `service_role` می‌خواند و می‌نویسد. تست محلی هم با همان کلید سرویس کار می‌کند.
- قفل چرخه در جدول `agent_state` با کلید `orchestrator:lock` است؛ اگر چرخه‌ای گیر کرد و خواستی دستی آزادش کنی، همان ردیف را پاک کن.

## چرخه‌ی کار پیشنهادی

۱. شاخه‌ی تازه بساز و تغییر را همان‌جا بزن.
۲. `npm run typecheck` و `npm run lint` را بزن؛ هر دو باید سبز باشند.
۳. با `npm run dev` محلی تست کن؛ برای چرخه‌ی کامل، یک `POST /api/cycles` بزن و صفحه‌ی داشبورد را ببین.
۴. `git status` را چک کن که `.env.local` یا فایل سکرت دیگری استیج نشده باشد؛ بعد کامیت و پوش.
