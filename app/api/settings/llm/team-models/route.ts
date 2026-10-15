/**
 * POST /api/settings/llm/team-models: ذخیره‌ی نگاشت «مدل هر تیم».
 *
 * ورودی: { teamModels: Record<TeamName, { endpointId: string, model: string }> }
 * نگاشت کامل ذخیره می‌شود؛ تیمی که در ورودی نباشد «تنظیم نشده» حساب می‌شود.
 */

import { fail, ok } from '../../../../../lib/api';
import {
  InputError,
  isSupabaseConfigured,
  saveTeamModelMap,
} from '../../../../../lib/llm-endpoints';

export async function POST(request: Request): Promise<Response> {
  if (!isSupabaseConfigured()) {
    return fail('سوپابیس متصل نیست؛ ابتدا اتصال پایگاه داده را برقرار کنید.', 503);
  }
  try {
    const body: unknown = await request.json().catch(() => ({}));
    const map = await saveTeamModelMap((body as Record<string, unknown>)?.teamModels);
    return ok({ teamModels: map });
  } catch (err) {
    if (err instanceof InputError) return fail(err.message, 400);
    return fail(err instanceof Error ? err.message : String(err));
  }
}
