import { NextRequest } from 'next/server';
import { ok, fail } from '../../../../lib/api';
import { InputError } from '../../../../lib/llm-endpoints';
import { applyTaskCriticVerdict, approveTask, rejectTask, completeTask, setTaskLLM } from '../../../../lib/taskqueue';

type Action = 'approve' | 'reject' | 'done' | 'set-model' | 'critic';

interface PatchBody {
  action?: Action;
  reason?: string;
  result?: string;
  commitSha?: string;
  /** for action 'set-model': شناسه‌ی endpoint (خالی = پاک کردن انتخاب کار) */
  endpointId?: string | null;
  /** for action 'set-model': نام مدل */
  model?: string;
  /** for action 'critic': حکم منتقد (بولین الزامی) */
  approved?: boolean;
}

/**
 * PATCH /api/tasks/:id: drives the queue lifecycle.
 * Body: { action: 'approve' | 'reject' | 'done' | 'set-model' | 'critic', reason?, result?, commitSha?, endpointId?, model?, approved? }
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

    if (action === 'critic') {
      // حکم منتقد روی کار pending: رد => rejected؛ تأیید کم‌ریسک (estimate=1) => خودکار approved؛
      // تأیید بقیه => pending می‌ماند (منتظر تأیید دستی).
      if (typeof body.approved !== 'boolean') {
        return fail('Field "approved" (boolean) is required for critic.', 400);
      }
      const status = await applyTaskCriticVerdict(id, {
        approved: body.approved,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
      });
      return ok({ id, status });
    }

    if (action === 'set-model') {
      const endpointId =
        typeof body.endpointId === 'string' ? body.endpointId.trim() : '';
      if (!endpointId) {
        await setTaskLLM(id, null);
        return ok({ id, llm: null });
      }
      if (!body.model || typeof body.model !== 'string' || !body.model.trim()) {
        return fail('برای ثبت مدل کار، نام مدل لازم است.', 400);
      }
      await setTaskLLM(id, { endpointId, model: body.model.trim() });
      return ok({ id, llm: { endpointId, model: body.model.trim() } });
    }

    return fail("Field \"action\" must be one of 'approve', 'reject', 'done', 'set-model', 'critic'.", 400);
  } catch (err) {
    if (err instanceof InputError) return fail(err.message, 400);
    return fail(err instanceof Error ? err.message : 'Unknown error', 500);
  }
}
