/**
 * سرویس اطلاع‌رسانی داشبورد تایلندگرد: دوگانه (تلگرام + پنل).
 *
 * هر پیام با سربرگ خودکار ارسال می‌شود: نام تیم، تاریخ شمسی و ساعت تهران.
 * «پنل» یعنی جدول notifications در سوپابیس؛ همان‌جا ثبت می‌شود تا در
 * داشبورد هم دیده شود، و هم‌زمان به تلگرام هم می‌رود.
 * اگر توکن بات تنظیم نشده باشد، ارسال تلگرام رد می‌شود و فقط در لاگ ثبت
 * می‌شود؛ ثبت در پنل مستقل از تلگرام است و همیشه تلاش می‌شود.
 * همه‌ی مسیرها best-effort هستند تا هیچ‌وقت مسیر اصلی برنامه را مسدود نکنند.
 */

import { getSupabase } from './api';

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
 * در صورت موفقیت، شناسه‌ی پیام تلگرام را برمی‌گرداند؛ وگرنه null.
 */
export async function sendTelegram(team: string, message: string): Promise<string | null> {
  const text = `${buildHeader(team)}\n\n${message}`;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn('[notify] تلگرام پیکربندی نشده؛ پیام فقط لاگ شد.', { team, text });
    return null;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      console.error('[notify] ارسال به تلگرام ناموفق بود.', await res.text());
      return null;
    }
    const json = (await res.json()) as { ok?: boolean; result?: { message_id?: number } };
    const messageId = json?.result?.message_id;
    return typeof messageId === 'number' ? String(messageId) : null;
  } catch (err) {
    console.error('[notify] خطا در ارسال به تلگرام.', err);
    return null;
  }
}

/** ثبت پیام در پنل (جدول notifications)؛ best-effort و بدون throw. */
async function saveToPanel(
  team: string,
  message: string,
  cycleId?: string,
): Promise<string | null> {
  try {
    const { data, error } = await getSupabase()
      .from('notifications')
      .insert({
        cycle_id: cycleId ?? null,
        team,
        message,
        channel: 'telegram',
        status: 'sent',
      })
      .select('id')
      .single();
    if (error || !data) {
      console.error('[notify] ثبت در پنل ناموفق بود.', error?.message);
      return null;
    }
    return data.id as string;
  } catch (err) {
    console.error('[notify] خطا در ثبت پنل.', err instanceof Error ? err.message : err);
    return null;
  }
}

export interface TeamReportInput {
  team: string;
  message: string;
  /** شناسه‌ی چرخه (اختیاری)؛ برای پیوند گزارش به چرخه در پنل. */
  cycleId?: string;
}

/**
 * گزارش دوگانه‌ی تیم: هم در پنل (جدول notifications) ثبت می‌شود،
 * هم به تلگرام ارسال می‌شود. ترتیب: اول پنل، بعد تلگرام؛ اگر تلگرام
 * پیام داد، شناسه‌اش روی همان رکورد پنل نوشته می‌شود.
 * هیچ‌وقت throw نمی‌کند.
 */
export async function notifyTeamReport({
  team,
  message,
  cycleId,
}: TeamReportInput): Promise<{ panelId: string | null; telegramMessageId: string | null }> {
  const panelId = await saveToPanel(team, message, cycleId);
  const telegramMessageId = await sendTelegram(team, message);
  if (panelId && telegramMessageId) {
    try {
      await getSupabase()
        .from('notifications')
        .update({ telegram_message_id: telegramMessageId })
        .eq('id', panelId);
    } catch {
      /* best effort */
    }
  }
  return { panelId, telegramMessageId };
}

/** ارسال گزارش پنج‌محوری چرخهٔ عملیاتی. */
export async function sendCycleReport(cycleId: string, summary: string): Promise<void> {
  await sendTelegram('داشبورد', `گزارش پنج‌محوری چرخه ${cycleId}\n\n${summary}`);
}

/** ارسال هشدار برای یک تیم. */
export async function sendAlert(team: string, alert: string): Promise<void> {
  await sendTelegram(team, `هشدار\n\n${alert}`);
}
