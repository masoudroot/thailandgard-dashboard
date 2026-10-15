/**
 * POST /api/settings/llm/[id]/models-health: تست سبک سلامت مدل‌های یک endpoint.
 *
 * ورودی: { models: string[], force?: boolean }
 *   - force=true کش را نادیده می‌گیرد و همه‌ی مدل‌ها را دوباره تست می‌کند.
 * خروجی موفق: { health: { [model]: { ok, message } }, tested, healthy, total }
 *
 * تست هر مدل یک chat/completions سبک با پرامپت «سلام» است (تایم‌اوت ۱۵ ثانیه،
 * حداکثر ۳ تست هم‌زمان). نتیجه در settings با کلید llm_model_health و انقضای
 * ۲۴ ساعت کش می‌شود؛ کش هرگز کلید API ندارد.
 */

import { fail, ok } from '../../../../../../lib/api';
import {
  InputError,
  getModelsHealth,
  isSupabaseConfigured,
} from '../../../../../../lib/llm-endpoints';

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  if (!isSupabaseConfigured()) {
    return fail('سوپابیس متصل نیست؛ ابتدا اتصال پایگاه داده را برقرار کنید.', 503);
  }
  try {
    const body = (await request.json().catch(() => ({}))) as {
      models?: unknown;
      force?: unknown;
    };
    if (!Array.isArray(body.models)) {
      throw new InputError('فهرست مدل‌ها (models) لازم است.');
    }
    const health = await getModelsHealth(
      decodeURIComponent(params.id),
      body.models.filter((m): m is string => typeof m === 'string'),
      { force: body.force === true },
    );
    const entries = Object.values(health);
    const tested = body.force === true ? entries.length : 0;
    return ok({
      health,
      tested,
      healthy: entries.filter((h) => h.ok).length,
      total: entries.length,
    });
  } catch (err) {
    if (err instanceof InputError) return fail(err.message, 400);
    return fail(err instanceof Error ? err.message : String(err));
  }
}
