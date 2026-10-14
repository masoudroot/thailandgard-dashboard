import { NextRequest } from 'next/server';
import { ok, fail } from '../../../lib/api';
import { enqueueTask, listTasks } from '../../../lib/taskqueue';

/** GET /api/tasks?status=pending — lists the task queue (newest first). */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    const status = request.nextUrl.searchParams.get('status') ?? undefined;
    const tasks = await listTasks(status);
    return ok(tasks);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Unknown error', 500);
  }
}

/** POST /api/tasks — manually enqueues a task. Body: QueuedTask & { team, cycleId? }. */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body = await request.json();

    if (!body?.title || typeof body.title !== 'string') {
      return fail('Field "title" is required.', 400);
    }
    if (!body?.team || typeof body.team !== 'string') {
      return fail('Field "team" is required.', 400);
    }

    const id = await enqueueTask({
      title: body.title,
      description: body.description ?? '',
      files_hint: body.files_hint ?? '',
      priority: body.priority ?? 'medium',
      team: body.team,
      cycleId: body.cycleId,
    });

    return ok({ id }, 201);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Unknown error', 500);
  }
}
