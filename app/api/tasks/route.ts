import { NextRequest } from 'next/server';
import { ok, fail } from '../../../lib/api';
import { InputError } from '../../../lib/llm-endpoints';
import { enqueueTask, listTasks, saveTaskPrefs } from '../../../lib/taskqueue';
import { triggerTaskRun } from '../../../lib/taskrunner';

/** GET /api/tasks?status=pending: lists the task queue (newest first). */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    const status = request.nextUrl.searchParams.get('status') ?? undefined;
    const tasks = await listTasks(status);
    return ok(tasks);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Unknown error', 500);
  }
}

/** POST /api/tasks: ثبت دستی کار. Body: QueuedTask & { team, cycleId?, files_hint?, execution_mode?, parallel? }. */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body = await request.json();

    if (!body?.title || typeof body.title !== 'string' || !body.title.trim()) {
      return fail('عنوان کار لازم است.', 400);
    }
    if (!body?.team || typeof body.team !== 'string') {
      return fail('تیم مجری لازم است.', 400);
    }

    // فایل‌های مرتبط: آرایه یا متن چندخطی
    const filesHint = Array.isArray(body.files)
      ? body.files.filter((f: unknown) => typeof f === 'string' && (f as string).trim()).join('\n')
      : typeof body.files === 'string'
        ? body.files
        : (body.files_hint ?? '');

    const executionMode = body.execution_mode === 'now' ? 'now' : 'cycle';
    const parallel = body.parallel !== false;

    // فیلدهای بک‌لاگ planner (مایگریشن 20261016133600)؛ همه اختیاری‌اند
    const estimate = body.estimate;
    if (estimate != null && ![1, 2, 3].includes(estimate)) {
      return fail('Field "estimate" must be 1, 2 or 3.', 400);
    }
    const source = body.source;
    if (source != null && !['planner-weekly', 'critic', 'manual'].includes(source)) {
      return fail('Field "source" must be planner-weekly, critic or manual.', 400);
    }

    const id = await enqueueTask({
      title: body.title.trim(),
      description: typeof body.description === 'string' ? body.description.trim() : '',
      files_hint: filesHint,
      priority: body.priority ?? 'medium',
      team: body.team,
      cycleId: body.cycleId,
      llm:
        typeof body.llmEndpointId === 'string' && body.llmEndpointId
          ? {
              endpointId: body.llmEndpointId,
              model: typeof body.llmModel === 'string' ? body.llmModel : '',
            }
          : undefined,
      ...(source ? { source } : {}),
      ...(typeof body.week_key === 'string' && body.week_key.trim() ? { week_key: body.week_key.trim() } : {}),
      ...(typeof body.acceptance === 'string' && body.acceptance.trim()
        ? { acceptance: body.acceptance.trim() }
        : {}),
      ...(estimate != null ? { estimate } : {}),
      ...(typeof body.depends_on === 'string' && body.depends_on.trim()
        ? { depends_on: body.depends_on.trim() }
        : {}),
      ...(typeof body.dedupe_key === 'string' && body.dedupe_key.trim()
        ? { dedupe_key: body.dedupe_key.trim() }
        : {}),
    });

    // تنظیمات واقعی اجرا: حالت اجرا + سوییچ موازی (به مجری واقعی وصل است)
    await saveTaskPrefs(id, { execution_mode: executionMode, parallel });

    // «همین الان انجام شود»: اجرای واقعی در پس‌زمینه
    if (executionMode === 'now') {
      await triggerTaskRun(id);
      return ok({ id, status: 'in_progress' }, 202);
    }

    return ok({ id, status: 'pending' }, 201);
  } catch (err) {
    if (err instanceof InputError) return fail(err.message, 400);
    return fail(err instanceof Error ? err.message : 'Unknown error', 500);
  }
}
