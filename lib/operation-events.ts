/**
 * lib/operation-events.ts — لایه ۱ دیده‌بان زنده: ثبت رویدادهای عملیات.
 *
 * کاملاً fail-soft است: هر خطایی (دیتابیس، شبکه، محیط) فقط console.error
 * می‌شود و هرگز throw نمی‌کند تا اجرای اصلی چرخه/تیم خراب نشود.
 */

import { getSupabase } from './api';

export type OperationEventType =
  | 'prompt_sent'
  | 'llm_response'
  | 'critic_decision'
  | 'error'
  | 'status_change'
  | 'cycle_started'
  | 'cycle_finished'
  | 'team_started'
  | 'team_finished';

/** سقف تقریبی طول JSON پرامپت/پیلود ذخیره‌شده (کاراکتر). */
const MAX_PAYLOAD_CHARS = 8000;

/**
 * پیلود را به سقف کاراکتری می‌برد. اگر برش خورد، به‌جای حذف بی‌صدا،
 * پرچم _truncated و پیش‌نمایش را ثبت می‌کند تا دیده‌بان بداند داده ناقص است.
 */
function truncatePayload(payload: Record<string, unknown>): Record<string, unknown> {
  let json: string;
  try {
    json = JSON.stringify(payload ?? {});
  } catch {
    return { _truncated: true, _preview: '[payload unserializable]' };
  }
  if (json.length <= MAX_PAYLOAD_CHARS) return payload ?? {};
  return {
    _truncated: true,
    _preview: json.slice(0, MAX_PAYLOAD_CHARS - 200) + '…[برش خورده]',
  };
}

/**
 * ثبت یک رویداد عملیات در جدول operation_events. fail-soft: هر خطایی
 * فقط لاگ می‌شود و Promise همیشه resolve می‌شود (هرگز reject نمی‌کند).
 *
 * @param cycleId شناسه چرخه (runId چرخه؛ کلید یکتای هر اجرا)
 * @param team نام تیم یا 'orchestrator' برای رویدادهای سطح چرخه
 * @param eventType نوع رویداد
 * @param payload داده دلخواه (به ۸۰۰۰ کاراکتر برش می‌خورد)
 */
export async function recordEvent(
  cycleId: string,
  team: string,
  eventType: OperationEventType,
  payload: Record<string, unknown> = {},
): Promise<void> {
  try {
    const { error } = await getSupabase().from('operation_events').insert({
      cycle_id: cycleId,
      team,
      event_type: eventType,
      payload: truncatePayload(payload),
    });
    if (error) {
      console.error('[operation-events] insert failed:', error.message);
    }
  } catch (err) {
    console.error(
      '[operation-events] recordEvent failed:',
      err instanceof Error ? err.message : err,
    );
  }
}
