/**
 * /api/settings/telegram: مدیریت اتصال تلگرام (هاب اتصال‌ها).
 *
 * GET : { connected, chatId, tokenMasked, source, message }
 *         توکن هرگز برنمی‌گردد؛ فقط ماسک‌شده.
 * POST: { token, chatId, sendTest? }: اول با getMe تست می‌شود، بعد ذخیره؛
 *         اگر sendTest=true باشد یک پیام آزمایشی هم فرستاده می‌شود.
 * DELETE: حذف پیکربندی از settings (برگشت به env).
 */

import { fail, ok } from '../../../../lib/api';
import { getSetting, setSetting } from '../../../../lib/settings';
import { maskTelegramToken } from '../../../../lib/notify';

interface StatusPayload {
  connected: boolean;
  chatId: string | null;
  tokenMasked: string | null;
  source: 'settings' | 'env' | null;
  botUsername: string | null;
  message: string;
}

async function readStored(): Promise<{ token: string | null; chatId: string | null }> {
  const token = await getSetting<string | null>('telegram_bot_token', null);
  const chatId = await getSetting<string | null>('telegram_chat_id', null);
  return {
    token: typeof token === 'string' && token.trim() ? token.trim() : null,
    chatId: typeof chatId === 'string' && String(chatId).trim() ? String(chatId).trim() : null,
  };
}

async function testToken(token: string): Promise<{ ok: boolean; username: string | null; message: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { username?: string }; description?: string };
    if (!res.ok || body?.ok !== true) {
      return { ok: false, username: null, message: `توکن نامعتبر است (${body?.description ?? res.status}).` };
    }
    const username = body?.result?.username ? `@${body.result.username}` : null;
    return { ok: true, username, message: username ? `بات ${username} پاسخ داد.` : 'توکن معتبر است.' };
  } catch {
    return { ok: false, username: null, message: 'به تلگرام وصل نشد؛ اتصال اینترنت را بررسی کنید.' };
  }
}

/** GET /api/settings/telegram: وضعیت اتصال. */
export async function GET(): Promise<Response> {
  try {
    const stored = await readStored();
    const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
    const envChatId = process.env.TELEGRAM_CHAT_ID?.trim() || null;

    const token = stored.token ?? envToken;
    const chatId = stored.chatId ?? envChatId;
    const source = stored.token && stored.chatId ? 'settings' : token && chatId ? 'env' : null;

    if (!token || !chatId) {
      return ok<StatusPayload>({
        connected: false,
        chatId: null,
        tokenMasked: null,
        source: null,
        botUsername: null,
        message: 'تلگرام پیکربندی نشده است. توکن بات و آیدی چت را وارد کنید.',
      });
    }
    const t = await testToken(token);
    return ok<StatusPayload>({
      connected: t.ok,
      chatId,
      tokenMasked: maskTelegramToken(token),
      source,
      botUsername: t.username,
      message: t.ok
        ? `متصل است${t.username ? ` (${t.username})` : ''}${source === 'env' ? '؛ از متغیر محیطی.' : '.'}`
        : t.message,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** POST /api/settings/telegram: ذخیره پس از تست. */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : String(body.chatId ?? '').trim();
    const sendTest = body.sendTest === true;
    if (!token) return fail('توکن بات خالی است.', 400);
    if (!chatId) return fail('آیدی چت خالی است.', 400);

    const t = await testToken(token);
    if (!t.ok) return fail(t.message, 400);

    await setSetting('telegram_bot_token', token);
    await setSetting('telegram_chat_id', chatId);

    let testNote = '';
    if (sendTest) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: 'این یک پیام آزمایشی از داشبورد تایلندگرد است. اتصال تلگرام برقرار شد.',
          }),
          signal: AbortSignal.timeout(15_000),
        });
        const jb = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
        testNote = res.ok && jb?.ok === true ? ' پیام آزمایشی هم ارسال شد.' : ' ولی ارسال پیام آزمایشی ناموفق بود؛ آیدی چت را بررسی کنید.';
      } catch {
        testNote = ' ولی ارسال پیام آزمایشی ناموفق بود.';
      }
    }

    return ok({
      connected: true,
      chatId,
      tokenMasked: maskTelegramToken(token),
      source: 'settings',
      botUsername: t.username,
      message: `تلگرام متصل شد${t.username ? ` (${t.username})` : ''}.${testNote}`,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** DELETE /api/settings/telegram: حذف پیکربندی settings (برگشت به env). */
export async function DELETE(): Promise<Response> {
  try {
    await setSetting('telegram_bot_token', null);
    await setSetting('telegram_chat_id', null);
    return ok({ message: 'پیکربندی تلگرام از داشبورد حذف شد؛ از این پس متغیر محیطی استفاده می‌شود.' });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
