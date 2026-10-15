# آماده‌سازی دیپلوی داشبورد روی Prisma Compute

سند آماده‌سازی (نه دیپلوی واقعی). دیپلوی واقعی فقط با دستور صریح مسعود.
الگو: دیپلوی سایت اصلی (`masoudroot/thailandgard` → Prisma Compute، منطقه `ap-southeast-1`).

## چه ساخته شد

| فایل | نقش |
|---|---|
| `prisma-compute/module.ts` | ماژول ریشه‌ی کامپوزر (پروویژن سرویس `web`) |
| `prisma-compute/service.ts` | تعریف سرویس Next.js با `output: 'standalone'` |
| `prisma.config.ts` | کانفیگ CLI پریزما (منطقه سنگاپور، مثل سایت اصلی) |
| `next.config.js` | `output: 'standalone'` اضافه شد (اجباری برای Compute) |
| `.github/workflows/prisma-deploy.yml` | ورک‌فلو دیپلوی (push به master ← پروداکشن، بقیه ← پریویو) |
| `package.json` | `@vercel/functions` حذف شد (در کد استفاده نمی‌شد)؛ `prisma` و `@prisma/composer*` اضافه شدند |

## چرا این کار امن است

- ورکر چرخه (`cycle-worker.yml`) روی GitHub Actions می‌ماند؛ به هاست داشبورد وابسته نیست.
- کرون VPS که `workflow_dispatch` می‌زند، به هاست داشبورد وابسته نیست.
- میان‌افزار (edge) و روت‌های API روی سرور standalone نکست کار می‌کنند.
- Prisma Compute سرور Node دائمی است؛ محدودیت تایم‌اوت serverless ورسل را ندارد (برای روت‌های طولانی LLM بهتر است).

## تفاوت‌های رفتاری نسبت به ورسل

1. **`app/api/settings/supabase/save/route.ts`**: ذخیره‌ی خودکار متغیرها در ورسل (با `VERCEL_API_TOKEN`) دیگر کار نمی‌کند؛ به‌صورت خودکار به «راهنمای دستی» برمی‌گردد. اگر این قابلیت برای پریزما هم لازم شد، باید با Management API پریزما بازنویسی شود.
2. **دامین**: دامین فعلی `thailandgard-dashboard.vercel.app` می‌ماند یا دامین تازه در کنسول پریزما ست می‌شود (تصمیم با مسعود).
3. **پریویوها**: هر برنچ غیر از master پریویوی جدا می‌سازد (مثل سایت اصلی).

## چک‌لیست دیپلوی (به ترتیب)

- [ ] ۱. در کنسول پریزما (Prisma Cloud) پروژه‌ی تازه بسازید یا ریپوی `masoudroot/thailandgard-dashboard` را به پروژه وصل کنید (اتصال ریپو = احراز OIDC خودکار، بدون سکرت).
- [ ] ۲. اگر اتصال ریپو انجام نشد: service token بسازید و به اسم `PRISMA_SERVICE_TOKEN` در GitHub Actions secrets بگذارید، و خط مربوطه را در ورک‌فلو از کامنت دربیاورید.
- [ ] ۳. متغیرهای محیطی را در کنسول پریزما (Project → Environment) برای PRODUCTION و PREVIEW ست کنید. فهرست کامل:
  - `SUPABASE_URL` ← `https://lilmfiyzeeinmifhxdhj.supabase.co`
  - `SUPABASE_SERVICE_ROLE_KEY` ← (از داشبورد سوپابیس ← Project Settings ← API)
  - `TELEGRAM_BOT_TOKEN` و `TELEGRAM_CHAT_ID`
  - `SITE_GITHUB_TOKEN` و `SITE_GITHUB_REPO` (دسترسی نوشتن به ریپوی سایت)
  - `ADMIN_PASSWORD` (هش مورد انتظار لاگین داشبورد)
  - `GITHUB_TOKEN` و `GITHUB_REPO` (تریگر ورکر، اگر لازم است)
  - `NAVASAN_API_KEY` (نرخ ارز)
  - `RATES_CRON_SECRET` (اگر روت کرون نرخ‌ها فعال است)
- [ ] ۴. `npm run build` را لوکال/CI بزنید و مطمئن شوید `.next/standalone` ساخته می‌شود.
- [ ] ۵. یک push تستی به برنچی غیر از master بزنید؛ پریویوی پریزما باید سبز شود.
- [ ] ۶. `GET /api/health` و `GET /api/manager/status` روی URL پریویو را چک کنید (داده باید تازه باشد، نه مثل ورسل کهنه).
- [ ] ۷. لاگین داشبورد (`/login`) را با رمز مدیر تست کنید.
- [ ] ۸. با دستور مسعود: push به master ← پروداکشن روی پریزما.
- [ ] ۹. (اختیاری) دامین `thailandgard-dashboard.vercel.app` را نگه دارید یا دامین تازه در پریزما ست کنید؛ بعد پروژه‌ی ورسل را pause/delete کنید تا دو هاست موازی نماند.
- [ ] ۱۰. واچ‌داگ (`dashboard-manager-watchdog`) را به URL تازه اشاره بدهید.

## بلوکرهای شناخته‌شده

- کلید `SUPABASE_SERVICE_ROLE_KEY` پروژه‌ی واقعی در دسترس نیست؛ بدون آن، APIهای مدیریتی داشبورد کار نمی‌کنند. مسعود باید از داشبورد سوپابیس بدهد.
- اتصال ریپو در کنسول پریزما یا `PRISMA_SERVICE_TOKEN` لازم است؛ هیچ‌کدام هنوز ست نشده.
