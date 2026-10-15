/**
 * GET /api/github/commits - فهرست واقعی کامیت‌های ریپوی سایت از GitHub API.
 *
 * کوئری‌ها: page (پیش‌فرض ۱)، per_page (پیش‌فرض ۱۵، سقف ۵۰)،
 * team (اسلاگ تیم، all یا other)، since و until (ISO، فیلتر تاریخ).
 *
 * خروجی موفق: { ok: true, data: { commits, page, per_page, has_more } }
 * بدون توکن: { ok: false, error: { message, code: 503, not_connected: true } }
 * هیچ دادهٔ نمایشی برنمی‌گردد.
 */

import { NextResponse } from 'next/server';
import { ok } from '../../../../lib/api';
import { GithubError, listSiteCommits } from '../../../../lib/github-changes';

function isoOrUndefined(value: string | null): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const page = Number(url.searchParams.get('page') ?? '1');
    const perPage = Number(url.searchParams.get('per_page') ?? '15');
    const team = url.searchParams.get('team') ?? 'all';
    const since = isoOrUndefined(url.searchParams.get('since'));
    const until = isoOrUndefined(url.searchParams.get('until'));

    const result = await listSiteCommits({ page, perPage, team, since, until });
    return ok({
      commits: result.commits,
      page: result.page,
      per_page: result.perPage,
      has_more: result.hasMore,
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
        error: { message: 'خطای غیرمنتظره در خواندن تغییرات از گیت‌هاب.', code: 500 },
      },
      { status: 500 },
    );
  }
}
