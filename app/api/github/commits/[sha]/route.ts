/**
 * GET /api/github/commits/[sha] - جزئیات واقعی یک کامیت: پیام کامل و
 * فایل‌های تغییرکرده از API کامیت گیت‌هاب. هیچ دادهٔ نمایشی برنمی‌گردد.
 */

import { NextResponse } from 'next/server';
import { ok } from '../../../../../lib/api';
import { GithubError, getSiteCommitDetail } from '../../../../../lib/github-changes';

export async function GET(
  _request: Request,
  { params }: { params: { sha: string } },
): Promise<Response> {
  try {
    const detail = await getSiteCommitDetail(params.sha);
    return ok({ commit: detail });
  } catch (err) {
    if (err instanceof GithubError) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            message: err.message,
            code: err.status,
            not_connected: err.notConnected,
          },
        },
        { status: err.status },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: { message: 'خطای غیرمنتظره در خواندن جزئیات کامیت.', code: 500 },
      },
      { status: 500 },
    );
  }
}
