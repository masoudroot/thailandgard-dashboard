import { ok } from '../../../lib/api';

export async function GET(): Promise<Response> {
  return ok({ status: 'ok' });
}
