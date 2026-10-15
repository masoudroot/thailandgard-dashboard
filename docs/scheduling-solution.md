# راه‌حل زمان‌بندی چرخه تایلندگرد

## مشکل

زمان‌بندی داخلی گیت‌هاب اکشنز (`schedule: */5 * * * *`) برای workflow `cycle-worker.yml`
اصلاً فایر نمی‌شود. در ۱۲ اجرای اخیر، همه `workflow_dispatch` (دستی) بودند؛
هیچ اجرای `schedule` ثبت نشده است.

### علت ریشه‌ای

گیت‌هاب برای workflowهای تازه‌ساخته‌شده ممکن است ۱ تا ۲ ساعت (و گاهی بیشتر)
تأخیر در فعال‌سازی schedule داشته باشد. این رفتار مستند و شناخته‌شده است،
ولی برای سیستمی که باید بدون دخالت دستی کار کند قابل اتکا نیست.

## راه‌حل: کرون VPS به‌عنوان تریگر اصلی

### معماری

```
کرون VPS (هر ۵ دقیقه)
    ↓ POST /repos/{repo}/actions/workflows/cycle-worker.yml/dispatches
گیت‌هاب اکشنز (worker/cycle-worker.ts)
    ↓ یک تیم در هر اجرا
دیتابیس (قفل ارکستراتور)
```

- **تریگر اصلی**: کرون روی VPS مسعود (`94.237.45.201`)
- **تریگر پشتیبان**: schedule داخلی گیت‌هاب (اگر روزی فعال شود، worker با قفل idempotent است و اجرای تکراری بی‌ضرر است)

### فایل‌ها روی VPS

| فایل | نقش |
|---|---|
| `/opt/thailandgard/trigger-cycle.sh` | اسکریپت تریگر (نصب شد) |
| `/opt/thailandgard/.github-pat` | توکن گیت‌هاب (باید ساخته شود) |
| `/var/log/thailandgard-trigger.log` | لاگ اجراها |

### منطق اسکریپت

1. بررسی وجود فایل PAT
2. استعلام گیت‌هاب: آیا همین حالا یک اجرای `in_progress` هست؟
   - اگر بله → رد می‌شود (صرفه‌جویی در دقیقه گیت‌هاب)
   - اگر نه → `workflow_dispatch` با `ref: master` ارسال می‌شود
3. نتیجه در لاگ ثبت می‌شود

### کرون

```
*/5 * * * * /opt/thailandgard/trigger-cycle.sh
```

### راه‌اندازی (یک‌بار)

**قدم ۱**: ساخت GitHub PAT توسط مسعود:
1. رفتن به https://github.com/settings/tokens?type=beta
2. ساخت Fine-grained PAT با:
   - نام: `thailandgard-cycle-trigger`
   - انقضا: ۱ ساله (یا بدون انقضا)
   - دسترسی به ریپو: فقط `masoudroot/thailandgard-dashboard`
   - مجوز: `Actions` → `Read and write`
3. کپی توکن (فقط یک‌بار نمایش داده می‌شود)

**قدم ۲**: قرار دادن توکن روی VPS:
```bash
echo 'TOKEN' > /opt/thailandgard/.github-pat
chmod 600 /opt/thailandgard/.github-pat
```

**قدم ۳**: فعال‌سازی کرون:
```bash
(crontab -l 2>/dev/null; echo "*/5 * * * * /opt/thailandgard/trigger-cycle.sh") | crontab -
```

### امنیت

- توکن فقط مجوز `actions:write` روی یک ریپو دارد (حداقل دسترسی)
- فایل PAT با `chmod 600` فقط خواندنی برای root است
- توکن در هیچ لاگ یا خروجی نوشته نمی‌شود

### پایش

```bash
# لاگ تریگرها
tail -f /var/log/thailandgard-trigger.log

# بررسی کرون
crontab -l | grep thailandgard
```

### چرا این گزینه؟

| گزینه | ارزیابی |
|---|---|
| تعمیر schedule گیت‌هاب | غیرقابل پیش‌بینی؛ ممکن است خودش درست شود ولی تضمینی نیست |
| cron-job.org | سرویس ثالث؛ وابستگی خارجی |
| ورکر دائمی روی VPS | پیچیده‌تر؛ نیاز به مدیریت پروسه |
| **کرون VPS (انتخاب شد)** | زیرساخت خودمان؛ ساده؛ قابل پایش؛ بدون وابستگی خارجی |
