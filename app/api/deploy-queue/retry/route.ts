import type { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api';
import { retryDeployItem } from '@/lib/bridge/deploy-queue';

export const dynamic = 'force-dynamic';

/**
 * POST /api/deploy-queue/retry: تلاش مجدد دستی برای آیتم ناموفق.
 * Body: { id: string }
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: { id?: unknown };
  try {
    body = (await request.json()) as { id?: unknown };
  } catch {
    return fail('invalid JSON body', 400);
  }
  if (typeof body?.id !== 'string' || body.id.trim() === '') {
    return fail('field "id" is required', 400);
  }
  try {
    const item = await retryDeployItem(body.id);
    return ok(item);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'retry failed', 400);
  }
}
