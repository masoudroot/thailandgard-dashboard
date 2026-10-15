/**
 * lib/bridge/read.ts: خواندن فایل از ریپوی سایت تایلندگرد.
 *
 * تیم‌های تولیدکننده (content، seo و...) پیش از ساخت پچ، نسخهٔ جاری فایل
 * هدف را از شاخهٔ dev ریپوی سایت می‌خوانند تا درج امن انجام شود.
 * قرارداد توکن همان settings/github_token است (lib/github.ts).
 */

import { getGithubConfig } from '../github';
import { SITE_REPO, BRIDGE_BASE_BRANCH } from './commit';

const NOT_CONNECTED_MESSAGE =
  'گیت‌هاب متصل نیست. توکن شخصی گیت‌هاب را در صفحهٔ تنظیمات وارد کنید.';

/**
 * خواندن محتوای یک فایل از ریپوی سایت (شاخهٔ dev).
 * path نسبی به ریشهٔ ریپوست، مثل site/lib/guides.ts.
 * null یعنی فایل وجود ندارد (برای فایل‌های تازه، طبیعی است).
 */
export async function readSiteFile(path: string): Promise<string | null> {
  const { token } = await getGithubConfig();
  if (!token) throw new Error(NOT_CONNECTED_MESSAGE);
  const clean = path.replace(/^\/+/, '');
  const res = await fetch(
    `https://api.github.com/repos/${SITE_REPO}/contents/${clean}?ref=${BRIDGE_BASE_BRANCH}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`خواندن فایل «${clean}» از ریپوی سایت ناموفق بود (وضعیت ${res.status}).`);
  }
  const body = (await res.json()) as { content?: string; encoding?: string };
  if (!body.content || body.encoding !== 'base64') return null;
  return Buffer.from(body.content, 'base64').toString('utf-8');
}
