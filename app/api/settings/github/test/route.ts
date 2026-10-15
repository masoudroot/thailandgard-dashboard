/**
 * POST /api/settings/github/test - تست زندهٔ اتصال گیت‌هاب با توکن فعلی.
 * ریپوی masoudroot/thailandgard را از API واقعی می‌خواند؛ هیچ دادهٔ نمایشی نیست.
 */

import { NextResponse } from 'next/server';
import { ok } from '../../../../../lib/api';
import { GithubError, testSiteConnection } from '../../../../../lib/github-changes';

export async function POST(): Promise<Response> {
  try {
    const info = await testSiteConnection();
    return ok({
      ok: true,
      message: `اتصال برقرار شد؛ ریپوی ${info.repo} دیده شد.`,
      repo: info.repo,
      private: info.isPrivate,
    });
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
        error: { message: 'تست اتصال ناموفق بود.', code: 500 },
      },
      { status: 500 },
    );
  }
}
