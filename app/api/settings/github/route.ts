/**
 * /api/settings/github: مدیریت اتصال گیت‌هاب برای «دستیار فنی».
 *
 * GET : { connected, repo, user?, message } (توکن هرگز برنمی‌گردد)
 * POST: { token, repo? }: ذخیره در settings و تست اتصال با /user
 *
 * توکن در جدول settings با کلید github_token نگه‌داری می‌شود (فقط service_role).
 */

import { fail, ok } from '../../../../lib/api';
import { getSetting, setSetting } from '../../../../lib/settings';
import { DEFAULT_REPO } from '../../../../lib/github';

/** GET /api/settings/github: وضعیت اتصال. */
export async function GET(): Promise<Response> {
  try {
    const stored = await getSetting<string | { token?: string } | null>('github_token', null);
    let token: string | null = null;
    if (typeof stored === 'string' && stored.trim()) token = stored.trim();
    else if (stored && typeof stored === 'object' && stored.token) token = String(stored.token).trim();
    if (!token && process.env.GITHUB_TOKEN) token = process.env.GITHUB_TOKEN.trim();
    const repo = (await getSetting<string | null>('github_repo', null)) || DEFAULT_REPO;

    if (!token) {
      return ok({
        connected: false,
        repo,
        message:
          'گیت‌هاب متصل نیست. برای اتصال خودکار، توکن شخصی گیت‌هاب را در همین صفحه وارد کنید؛ تا آن‌موقع فیکس به‌صورت قابل کپی داده می‌شود.',
      });
    }
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return ok({
        connected: false,
        repo,
        message: `توکن گیت‌هاب نامعتبر است (وضعیت ${res.status})؛ توکن تازه وارد کنید.`,
      });
    }
    const body = (await res.json()) as { login?: string };
    return ok({
      connected: true,
      repo,
      user: body.login,
      message: `گیت‌هاب متصل است (${body.login ?? 'نامشخص'}).`,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** POST /api/settings/github: ذخیره‌ی توکن و تست اتصال. */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) return fail('توکن خالی است.', 400);
    const repo =
      typeof body.repo === 'string' && body.repo.trim() ? body.repo.trim() : DEFAULT_REPO;

    // اول اتصال را با خود گیت‌هاب تست می‌کنیم، بعد ذخیره
    const test = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!test.ok) {
      return fail(
        `اتصال با این توکن ناموفق بود (وضعیت ${test.status}). توکن را بررسی کنید و دوباره تلاش کنید.`,
        400,
      );
    }
    const user = (await test.json()) as { login?: string };

    await setSetting('github_token', token);
    await setSetting('github_repo', repo);

    return ok({
      connected: true,
      repo,
      user: user.login,
      message: `گیت‌هاب متصل شد (${user.login ?? 'نامشخص'}).`,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
