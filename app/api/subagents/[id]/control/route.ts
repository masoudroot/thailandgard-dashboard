import { NextRequest } from 'next/server';
import { fail, getSupabase, ok } from '@/lib/api';
import type { SubagentControl } from '@/lib/types';

const ACTIONS: Record<string, SubagentControl> = {
  pause: 'pause',
  resume: 'run',
  stop: 'stop',
};

/**
 * POST /api/subagents/[id]/control : کنترل زنده‌ی یک ساب‌ایجنت.
 * بدنه: { action: 'pause' | 'resume' | 'stop' }
 *
 * سیگنال در جدول subagents ثبت می‌شود و ارکستر آن را در مرز مرحله‌ی بعدی
 * اعمال می‌کند (pause: انتظار تا resume، stop: پایان اجرا با وضعیت stopped).
 * روی مرحله‌ای که هم‌اکنون در حال اجراست اثر فوری ندارد.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const id = params.id?.trim();
  if (!id) return fail('شناسه‌ی ساب‌ایجنت لازم است.', 400);

  let body: { action?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail('درخواست نامعتبر است.', 400);
  }
  const action = typeof body.action === 'string' ? body.action : '';
  const control = ACTIONS[action];
  if (!control) {
    return fail('action باید یکی از pause ،resume یا stop باشد.', 400);
  }

  let sb;
  try {
    sb = getSupabase();
  } catch {
    return fail('اتصال به دیتابیس برقرار نیست.', 503);
  }

  try {
    const { data: existing, error: readErr } = await sb
      .from('subagents')
      .select('id, status, team, label')
      .eq('id', id)
      .maybeSingle();
    if (readErr) return fail(`خطا در خواندن ساب‌ایجنت: ${readErr.message}`);
    if (!existing) return fail('ساب‌ایجنتی با این شناسه پیدا نشد.', 404);

    const status = (existing as { status: string }).status;
    if (['success', 'failed', 'stopped'].includes(status)) {
      return fail('این ساب‌ایجنت قبلاً تمام شده و قابل کنترل نیست.', 409);
    }

    const { error: updateErr } = await sb
      .from('subagents')
      .update({
        control,
        // resume روی ساب‌ایجنت متوقف‌شده: وضعیت را به در حال اجرا برگردان تا
        // ارکستر از حلقه‌ی انتظار خارج شود.
        ...(control === 'run' && status === 'paused' ? { status: 'running' } : {}),
      })
      .eq('id', id);
    if (updateErr) return fail(`ثبت سیگنال ناموفق بود: ${updateErr.message}`);

    return ok({
      id,
      control,
      note: 'سیگنال ثبت شد؛ از مرز مرحله‌ی بعدی اعمال می‌شود.',
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'خطای ناشناخته.');
  }
}
