# سندباکس امن تولید کد توسط تیم‌ها

## پاسخ ۴ سؤال کارت

### ۱. آیا تیم‌ها در GitHub Actions می‌توانند فایل بنویسند؟

بله. هر job روی `ubuntu-latest` یک workspace دارد (`$GITHUB_WORKSPACE`) که ریپو در آن checkout شده و کد Node.js با `fs.writeFileSync` می‌تواند آن‌جا فایل بسازد. اما برای امنیت، تیم‌ها نباید مستقیم به `fs` دست بزنند؛ فقط از تابع `writeTeamCodeFile` در `worker/code-collector.ts` استفاده می‌کنند که محدودیت‌ها را همان لحظه‌ی نوشتن اعمال می‌کند. خروجی هر تیم در `code-output/<team>/` می‌نشیند.

### ۲. خروجی کد چطور از workspace رانر به گیت‌هاب می‌رسد؟

```
code-output/<team>/  (روی دیسک رانر)
        ↓  collectAndCommitTeamCode (بعد از اجرای تیم)
   خواندن بایت واقعی + هش + راستی‌آزمایی
        ↓  فقط اگر منتقد تأیید کرده باشد
   GitHub git-database API → ریپوی masoudroot/thailandgard
        ↓  شاخه‌ی team/<team>/<run-id> (از روی master)
   کامیت + ثبت متادیتا در جدول team_code_files
```

نکته‌ی مهم: پوش مستقیم روی `master` انجام نمی‌شود. کد تیم روی شاخه‌ی جدا می‌نشیند تا انسان (یا تیم qa/inspector در چرخه‌ی بعد) آن را بازبینی و مرج کند. این تصمیم آگاهانه است: خودکارسازی کاملِ مرج روی سایت واقعی بدون بازبینی، ریسک امنیتی دارد.

توکن لازم: `SITE_GITHUB_TOKEN` (یک Fine-grained PAT با دسترسی Contents: Read and write فقط روی ریپوی `thailandgard`). در ورک‌فلو باید به‌صورت secret تعریف شود:
`SITE_GITHUB_TOKEN: ${{ secrets.SITE_GITHUB_TOKEN }}`

### ۳. محدودیت حجم هر تیم

| محدودیت | مقدار |
|---|---|
| حداکثر فایل در هر اجرا | ۱۰ فایل |
| حداکثر حجم هر فایل | ۱۰۰ کیلوبایت |
| حداکثر حجم مجموع | ۵۱۲ کیلوبایت |
| حداکثر خط هر فایل | ۲۰۰۰ خط |
| پسوند مجاز | ts, tsx, js, jsx, css, scss, md, mdx, json, html |

ممنوع: باینری، فایل اجرایی، فایل مخفی (نقطه‌دار)، `node_modules`، `.git`، هر چیز شامل `.env`، و هر مسیری که از سندباکس فرار کند (`..` یا مسیر مطلق). این محدودیت‌ها هم در `writeTeamCodeFile` (هنگام نوشتن) و هم در `collectAndCommitTeamCode` (هنگام جمع‌آوری) اعمال می‌شوند؛ دفاع در دو لایه.

### ۴. چطور مطمئن شویم کد واقعی همان چیزی است که تیم گفته؟ (ضدتوهم)

کالکتور به «حرف» تیم اعتماد نمی‌کند؛ فقط به «بایت» روی دیسک:

1. **خواندن واقعی:** فایل‌ها با `readFileSync` از دیسک خوانده می‌شوند، نه از متن گزارش تیم.
2. **هش SHA-256:** هش هر فایل محاسبه و در جدول `team_code_files` ثبت می‌شود؛ قابل حسابرسی بعدی.
3. **تطبیق مانیفست:** تیم باید در خروجی JSON خودش `produced_files: [{path, sha256}]` اعلام کند. کالکتور هش واقعی را با هش اعلام‌شده مقایسه می‌کند؛ هر عدم تطبیق (فایل ادعاشده‌ی ناموجود، فایل اعلام‌نشده، یا هش متفاوت) کل پوش را لغو می‌کند.
4. **گیت سینتکس:** فایل‌های TS/JS/TSX/JSX با `transpileModule` تایپ‌اسکریپت از نظر نحوی چک می‌شوند؛ فایل دارای خطای نحوی رد می‌شود.
5. **گیت منتقد:** فقط وقتی `approved=true` باشد پوش انجام می‌شود؛ در غیر این صورت فایل‌ها فقط ثبت می‌شوند و روی دیسک می‌مانند.
6. **ثبت کامل:** حتا وقتی پوش انجام نمی‌شود، متادیتای فایل‌ها (مسیر، هش، حجم، خط) در دیتابیس می‌ماند.

## نقطه‌ی اتصال به ورکر

در `worker/cycle-worker.ts`، بعد از `runSingleTeam`:

```ts
import { collectAndCommitTeamCode } from './code-collector';

// بعد از اجرای موفق تیم و مشخص شدن verdict:
const collection = await collectAndCommitTeamCode({
  team,
  runId,
  cycleId,
  approved: teamResult.approved,
  declaredFiles: teamResult.producedFiles, // فیلد جدیدی که تیم‌ها در TeamResult اعلام می‌کنند
});
console.log(`[code-collector] pushed=${collection.pushed} files=${collection.files.length}`);
```

## تغییر لازم در تیم‌ها (کار مهندس دیگر)

تیم‌هایی که باید کد تولید کنند (فعلاً `dev`، بعداً `design` و `seo`) باید:
1. به‌جای `fs` مستقیم، از `writeTeamCodeFile(team, relPath, content)` استفاده کنند.
2. در `TeamResult` فیلد `producedFiles: Array<{path: string; sha256: string}>` را برگردانند (مانیفست برای تطبیق ضدتوهم).

## فایل‌ها

- `worker/code-collector.ts` — پیاده‌سازی کامل (تست عملکردی با dry-run سبز شد)
- `supabase/migrations/20261015210000_team_code_files.sql` — جدول حسابرسی
