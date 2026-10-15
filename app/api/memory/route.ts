import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api';
import { readMemory, writeMemory } from '@/lib/memory';

/**
 * GET /api/memory?team=<team> : reads all memory entries for a team.
 * team=all برمی‌گرداند: همه‌ی تیم‌ها (برای فیلتر «همه»).
 */
export async function GET(request: NextRequest) {
  const team = request.nextUrl.searchParams.get('team')?.trim() ?? '';

  if (!team) {
    return fail('پارامتر team لازم است.', 400);
  }

  try {
    return ok(await readMemory(team));
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'خطای خواندن حافظه.');
  }
}

/**
 * POST /api/memory : body: { team, key, value } : upserts one entry.
 */
export async function POST(request: NextRequest) {
  let body: { team?: unknown; key?: unknown; value?: unknown } | null;
  try {
    body = await request.json();
  } catch {
    return fail('درخواست نامعتبر است.', 400);
  }

  if (body === null || typeof body !== 'object') {
    return fail('بدنهٔ درخواست نامعتبر است.', 400);
  }

  const team = typeof body.team === 'string' ? body.team.trim() : '';
  const key = typeof body.key === 'string' ? body.key.trim() : '';

  if (!team || !key) {
    return fail('team و key هر دو لازم‌اند.', 400);
  }
  if (!('value' in body)) {
    return fail('value لازم است.', 400);
  }

  try {
    await writeMemory(team, key, body.value);
    return ok({ saved: true, team, key });
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'خطای نوشتن حافظه.');
  }
}
