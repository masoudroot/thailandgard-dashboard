/**
 * سرویس اطلاع‌رسانی تلگرام داشبورد تایلندگرد.
 *
 * هر پیام با سربرگ خودکار ارسال می‌شود: نام تیم، تاریخ شمسی و ساعت تهران.
 * اگر توکن بات تنظیم نشده باشد، ارسال انجام نمی‌شود و فقط در لاگ ثبت می‌شود
 * تا هیچ‌وقت مسیر اصلی برنامه را مسدود نکند.
 */

const TIME_ZONE = 'Asia/Tehran';
const LOCALE = 'fa-IR-u-nu-latn';

const tehranDateFormat = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

const tehranTimeFormat = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
});

/** تاریخ شمسی و ساعت تهرانِ لحظهٔ جاری. */
function tehranNow(): { date: string; time: string } {
  const now = new Date();
  return { date: tehranDateFormat.format(now), time: tehranTimeFormat.format(now) };
}

/** سربرگ خودکار بالای هر پیام. */
function buildHeader(team: string): string {
  const { date, time } = tehranNow();
  return [`تیم: ${team}`, `تاریخ: ${date}`, `ساعت: ${time}`].join('\n');
}

/**
 * ارسال پیام به تلگرام.
 * اگر TELEGRAM_BOT_TOKEN یا TELEGRAM_CHAT_ID تنظیم نشده باشد، فقط لاگ می‌کند و رد می‌شود.
 */
export async function sendTelegram(team: string, message: string): Promise<void> {
  const text = `${buildHeader(team)}\n\n${message}`;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn('[notify] تلگرام پیکربندی نشده؛ پیام فقط لاگ شد.', { team, text });
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      console.error('[notify] ارسال به تلگرام ناموفق بود.', await res.text());
    }
  } catch (err) {
    console.error('[notify] خطا در ارسال به تلگرام.', err);
  }
}

/** ارسال گزارش پنج‌محوری چرخهٔ عملیاتی. */
export async function sendCycleReport(cycleId: string, summary: string): Promise<void> {
  await sendTelegram('داشبورد', `گزارش پنج‌محوری چرخه ${cycleId}\n\n${summary}`);
}

/** ارسال هشدار برای یک تیم. */
export async function sendAlert(team: string, alert: string): Promise<void> {
  await sendTelegram(team, `هشدار\n\n${alert}`);
}
