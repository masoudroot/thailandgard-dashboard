import { NextRequest } from 'next/server';
import { fail, ok } from '../../../../lib/api';
import { listTaskPrefs } from '../../../../lib/taskqueue';

/**
 * GET /api/tasks/prefs?ids=<id1>,<id2>,...: تنظیمات اجرای کارها
 * (execution_mode / parallel)؛ یک کوئری برای همه.
 */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    const raw = request.nextUrl.searchParams.get('ids') ?? '';
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200);
    const prefs = await listTaskPrefs(ids);
    return ok(prefs);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Unknown error', 500);
  }
}
