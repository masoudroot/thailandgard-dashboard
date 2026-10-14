import { NextRequest } from 'next/server';
import { ok, fail } from '../../../../lib/api';
import { approveTask, rejectTask, completeTask } from '../../../../lib/taskqueue';

type Action = 'approve' | 'reject' | 'done';

interface PatchBody {
  action?: Action;
  reason?: string;
  result?: string;
  commitSha?: string;
}

/**
 * PATCH /api/tasks/:id — drives the queue lifecycle.
 * Body: { action: 'approve' | 'reject' | 'done', reason?, result?, commitSha? }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  try {
    const id = params.id;
    const body = (await request.json()) as PatchBody;
    const action = body.action;

    if (action === 'approve') {
      await approveTask(id);
      return ok({ id, status: 'approved' });
    }

    if (action === 'reject') {
      if (!body.reason || typeof body.reason !== 'string') {
        return fail('Field "reason" is required for reject.', 400);
      }
      await rejectTask(id, body.reason);
      return ok({ id, status: 'rejected' });
    }

    if (action === 'done') {
      if (!body.result || typeof body.result !== 'string') {
        return fail('Field "result" is required for done.', 400);
      }
      await completeTask(id, body.result, body.commitSha);
      return ok({ id, status: 'done' });
    }

    return fail("Field \"action\" must be one of 'approve', 'reject', 'done'.", 400);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Unknown error', 500);
  }
}
