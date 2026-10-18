/**
 * lib/bridge/commit.ts: لایهٔ «پل» (bridge) برای اعمال پچ تیم‌ها روی ریپوی سایت.
 *
 * قانون سفت (دستور مسعود): هیچ‌وقت مستقیم روی dev یا main کامیت زده نمی‌شود.
 * هر پچ روی شاخهٔ ai-bridge/<patchId> (منشعب از dev ریپوی سایت) کامیت می‌شود
 * و بعد با Pull Request به dev پیشنهاد می‌شود.
 *
 * قرارداد توکن همان settings/github_token است (lib/github.ts).
 */

import { applyPatchViaGithub, getGithubConfig, type PatchFile } from '../github';

/** ریپوی سایت تایلندگرد. */
export const SITE_REPO = 'masoudroot/thailandgard';
/** شاخهٔ مبدأ انشعاب و مقصد PR پل: همیشه dev. */
export const BRIDGE_BASE_BRANCH = 'dev';
/** پیشوند شاخه‌های پل. */
export const BRIDGE_BRANCH_PREFIX = 'ai-bridge/';

export interface BridgeCommitResult {
  branch: string;
  sha: string;
}

export interface BridgePRResult {
  number: number;
  url: string;
}

const NOT_CONNECTED_MESSAGE =
  'گیت‌هاب متصل نیست. توکن شخصی گیت‌هاب را در صفحهٔ تنظیمات وارد کنید.';

/**
 * تشخیص خطای موقتی (شبکه یا سمت سرور) که تلاش مجدد معنادار است.
 * خطاهای 4xx (مثل ۴۲۲ شاخهٔ تکراری یا ۴۰۳ دسترسی) قطعی‌اند و ریتری نمی‌شوند.
 */
function isTransientError(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch network failure
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return true;
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/\(وضعیت (\d{3})\)/);
  if (m) {
    const status = Number(m[1]);
    return status === 429 || (status >= 500 && status < 600);
  }
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(msg);
}

/**
 * تلاش مجدد با backoff نمایی برای فراخوانی‌های API گیت‌هاب.
 * زنجیرهٔ کامیت پل چند فراخوانی پیاپی دارد و یک لرزش لحظه‌ای شبکه نباید
 * کل پچ را بکشد؛ ولی خطای قطعی فوراً بالا می‌آید.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isTransientError(err) || i === attempts - 1) throw err;
      const waitMs = 1000 * 2 ** i; // ۱ثانیه، ۲ثانیه
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(
        `[bridge] ${label}: خطای موقتی (${detail.slice(0, 120)})؛ تلاش ${i + 2}/${attempts} پس از ${waitMs}ms`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw last;
}

/**
 * راستی‌آزمایی این‌که کامیت واقعاً روی origin نشسته است (نه فقط «API خطا نداد»).
 * رأس شاخه از API دوباره خوانده و با SHA برگشتی مقایسه می‌شود؛
 * ناسازگاری یعنی وضعیت نامشخص و خطای بلند (fail-closed).
 * اسلش‌های نام شاخه encode نمی‌شوند (فقط هر قطعه جدا)، چون GitHub در مسیر
 * ref اسلشِ encodeشده (%2F) را قابل‌اتکا قبول نمی‌کند.
 * خوانش رأس تا ۳ بار با فاصله تکرار می‌شود تا تأخیر رپلیکیشن گیت‌هاب
 * داوری را نکشد؛ بعد از آن، ناسازگاری = خطای بلند.
 */
async function verifyBranchHeadOnOrigin(
  branch: string,
  commitSha: string,
): Promise<void> {
  const { token } = await getGithubConfig();
  if (!token) throw new Error(NOT_CONNECTED_MESSAGE);
  const api = `https://api.github.com/repos/${SITE_REPO}`;
  const refPath = branch
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  const expected = String(commitSha ?? '').toLowerCase();
  let lastHead = '';
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${api}/git/refs/heads/${refPath}`, {
      headers: bridgeHeaders(token),
      signal: AbortSignal.timeout(15_000),
    });
    lastStatus = res.status;
    if (res.ok) {
      const body = (await res.json()) as { object?: { sha?: string } };
      lastHead = String(body.object?.sha ?? '').toLowerCase();
      if (lastHead && expected.length >= 7 && lastHead.startsWith(expected)) return;
    } else if (attempt < 2 && (res.status === 404 || res.status === 429 || res.status >= 500)) {
      // ۴۰۴ بلافاصله پس از ساخت شاخه معمولاً تأخیر رپلیکیشن گیت‌هاب است،
      // نه نبودن واقعی شاخه؛ مثل ناسازگاری SHA با فاصله دوباره خوانده می‌شود.
      // (پس از ۳ تلاش ناموفق، خطای بلند پایین تابع پرتاب می‌شود.)
    } else {
      throw new Error(
        `راستی‌آزمایی کامیت ناموفق بود (وضعیت ${res.status})؛ وضعیت شاخهٔ «${branch}» روی origin نامشخص است.`,
      );
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!lastHead) {
    throw new Error(
      `راستی‌آزمایی کامیت ناموفق بود (وضعیت ${lastStatus})؛ وضعیت شاخهٔ «${branch}» روی origin نامشخص است.`,
    );
  }
  throw new Error(
    `راستی‌آزمایی کامیت ناموفق بود: رأس «${branch}» روی origin (${lastHead.slice(0, 7) || 'نامشخص'}) ` +
      `با SHA برگشتی (${commitSha}) جور نیست؛ کامیت به‌عنوان موفق ثبت نمی‌شود.`,
  );
}

/**
 * تمیزکاری شناسهٔ پچ برای نام شاخه: حروف کوچک، بدون کاراکتر خاص.
 * هر رشتهٔ دیگری به خط‌تیره تبدیل و خط‌تیره‌های تکراری یکی می‌شوند.
 */
function sanitizePatchId(patchId: string): string {
  const clean = String(patchId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (!clean) throw new Error('شناسهٔ پچ نامعتبر است؛ شاخهٔ پل ساخته نشد.');
  return clean;
}

/** نام کامل شاخهٔ پل برای یک شناسهٔ پچ. */
export function bridgeBranchName(patchId: string): string {
  return `${BRIDGE_BRANCH_PREFIX}${sanitizePatchId(patchId)}`;
}

/** تک‌خطی کردن رشته برای پیام کامیت و عنوان PR. */
function oneLine(value: string, max: number): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * کامیت پچ یک تیم روی شاخهٔ پل ai-bridge/<patchId> (منشعب از dev ریپوی سایت).
 * پیام کامیت: [<team>] <summary>؛ اگر summary داده نشود، خود patchId می‌نشیند.
 * خروجی: نام شاخه و SHA کامیت.
 *
 * قابلیت اطمینان:
 * - فراخوانی‌های API گیت‌هاب با backoff نمایی تا ۳ تلاش تکرار می‌شوند
 *   (فقط خطای موقتی شبکه/سرور؛ خطای قطعی مثل ۴۲۲ فوراً بالا می‌آید).
 * - پس از کامیت، رأس شاخه از origin دوباره خوانده و با SHA مقایسه می‌شود؛
 *   اگر کامیت واقعاً روی origin ننشسته باشد، خطای بلند می‌دهد و پچ
 *   به‌عنوان موفق ثبت نمی‌شود (fail-closed).
 */
export async function commitToBridgeBranch(
  patchId: string,
  files: PatchFile[],
  team: string,
  summary?: string,
): Promise<BridgeCommitResult> {
  const teamName = oneLine(team, 40);
  if (!teamName) throw new Error('نام تیم خالی است.');
  const branch = bridgeBranchName(patchId);
  const message = `[${teamName}] ${oneLine(summary || patchId, 120)}`;
  let result: { branch: string; commitSha: string };
  try {
    result = await withRetry('کامیت پل', () =>
      applyPatchViaGithub(branch, message, files, {
        repo: SITE_REPO,
        baseBranch: BRIDGE_BASE_BRANCH,
      }),
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes('(وضعیت 422)')) {
      // شاخه از قبل روی origin هست ولی اثر همین پچ را ندارد
      // (مثلاً تلاش قبلی وسط راه ناتمام مانده). تا وقتی آن شاخه هست،
      // هیچ تلاشی برای همین patchId موفق نمی‌شود؛ پس خطا باید صریح و
      // راه‌حل‌دار باشد، نه یک «۴۲۲» خشک.
      throw new Error(
        `کامیت پل روی شاخهٔ «${branch}» ناموفق بود: شاخه از قبل روی origin هست و اثر همین پچ را ندارد. ` +
          `برای تلاش مجدد، شاخه را از گیت‌هاب حذف کنید. علت اصلی: ${err.message}`,
      );
    }
    throw err;
  }
  // راستی‌آزمایی نشستن واقعی کامیت روی origin (خطای موقتی شبکه در خوانش، ریتری می‌شود)
  await withRetry('راستی‌آزمایی رأس شاخه', () =>
    verifyBranchHeadOnOrigin(branch, result.commitSha),
  );
  return { branch: result.branch, sha: result.commitSha };
}

function bridgeHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

interface GithubPRSummary {
  number?: number;
  html_url?: string;
}

/**
 * اگر برای همین شاخه PR بازی هست، همان را برگردان (رفتار idempotent).
 *
 * عمداً هیچ خطایی قورت داده نمی‌شود: اگر خواندن فهرست PRها با خطای موقتی
 * شکست بخورد و ما بی‌صدا null برگردانیم، صداکننده PR تکراری می‌سازد.
 * خطا بلند بالا می‌آید تا با withRetry تکرار شود یا صداکننده بفهمد.
 */
async function findOpenBridgePR(
  api: string,
  h: Record<string, string>,
  head: string,
): Promise<BridgePRResult | null> {
  const owner = SITE_REPO.split('/')[0];
  const res = await fetch(
    `${api}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&base=${BRIDGE_BASE_BRANCH}&state=open`,
    { headers: h, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) {
    throw new Error(`خواندن PRهای باز شاخهٔ «${head}» ناموفق بود (وضعیت ${res.status}).`);
  }
  const list = (await res.json()) as GithubPRSummary[];
  const pr = Array.isArray(list) ? list[0] : undefined;
  if (pr?.number && pr?.html_url) return { number: pr.number, url: pr.html_url };
  return null;
}

/**
 * ساخت Pull Request از شاخهٔ پل به dev ریپوی سایت.
 * فقط شاخه‌های ai-bridge/ پذیرفته می‌شوند؛ مقصد همیشه dev است.
 */
export async function createBridgePR(
  branch: string,
  title: string,
  body: string,
): Promise<BridgePRResult> {
  const head = branch.trim();
  if (!head.startsWith(BRIDGE_BRANCH_PREFIX)) {
    throw new Error('فقط شاخه‌های ai-bridge/ می‌توانند PR پل بسازند.');
  }
  const cleanTitle = oneLine(title, 150);
  if (!cleanTitle) throw new Error('عنوان PR خالی است.');
  const { token } = await getGithubConfig();
  if (!token) throw new Error(NOT_CONNECTED_MESSAGE);
  const h = bridgeHeaders(token);
  const api = `https://api.github.com/repos/${SITE_REPO}`;

  // کل زنجیرهٔ «پیدا یا بساز» یکجا با ریتری می‌شود:
  // - اگر خواندن PRهای باز با خطای موقتی شکست بخورد، بی‌صدا null برنمی‌گردانیم
  //   (که منجر به PR تکراری شود)؛ بلکه تلاش تکرار و در نهایت خطای بلند می‌دهد.
  // - اگر POST واقعاً رفته ولی پاسخش گم شده باشد، تلاش بعدی PR باز را پیدا
  //   و برمی‌گرداند؛ PR تکراری ساخته نمی‌شود.
  // - اگر POST با ۴۲۲ رد شد (مثلاً PR هم‌زمان از جای دیگری ساخته شده)،
  //   یک بار دیگر فهرست را می‌خوانیم تا همان PR برگردد به‌جای خطای خشک.
  return withRetry('یافتن یا ساخت PR پل', async () => {
    const existing = await findOpenBridgePR(api, h, head);
    if (existing) return existing;

    const res = await fetch(`${api}/pulls`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        title: cleanTitle,
        head,
        base: BRIDGE_BASE_BRANCH,
        body: body ?? '',
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      if (res.status === 422) {
        const raced = await findOpenBridgePR(api, h, head);
        if (raced) return raced;
      }
      const detail = await res.text().catch(() => '');
      throw new Error(`ساخت PR ناموفق بود (وضعیت ${res.status}). ${detail.slice(0, 300)}`);
    }
    const pr = (await res.json()) as GithubPRSummary;
    if (!pr.number || !pr.html_url) throw new Error('پاسخ گیت‌هاب برای PR ناقص بود.');
    return { number: pr.number, url: pr.html_url };
  });
}
