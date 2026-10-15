/**
 * /api/debug: بک‌اند واقعی بخش «دستیار فنی».
 *
 * GET : فهرست نشست‌های دیباگ (جدیدترین اول).
 * POST: { bug_description }: جمع‌کردن زمینه‌ی واقعی، تشخیص ساخت‌یافته با LLM،
 *        و ذخیره‌ی نشست در جدول debug_sessions.
 *
 * زمینه‌ی واقعی (بدون هیچ داده‌ی نمایشی):
 *   ۱) خطاهای اخیر از team_runs (واقعی، از همین سوپابیس)
 *   ۲) کامیت‌های اخیر از GitHub API (فقط اگر توکن در settings/env باشد)
 *   ۳) محتوای فایل‌های مرتبط از ریپوی گیت‌هاب (فقط اگر متصل باشد)
 * اگر GitHub وصل نباشد، صادقانه گزارش می‌شود؛ تشخیص با بقیه‌ی زمینه ادامه می‌یابد.
 */

import { fail, getSupabase, ok } from '../../../lib/api';
import { callLLMJson } from '../../../lib/llm';
import {
  fetchRecentCommits,
  githubStatus,
  readRepoFile,
  type GithubCommit,
  type PatchFile,
} from '../../../lib/github';

/** GET /api/debug: فهرست نشست‌ها. */
export async function GET(): Promise<Response> {
  try {
    const { data, error } = await getSupabase()
      .from('debug_sessions')
      .select('id, bug_desc, status, created_at, diagnosis')
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) return fail(`خواندن نشست‌ها ناموفق بود: ${error.message}`);
    return ok(data ?? []);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

interface TeamRunError {
  team: string;
  status: string;
  error: string | null;
  started_at: string;
}

/** خطاهای واقعی اخیر از team_runs: آخرین اجراهای ناموفق + خطادار. */
async function fetchRecentTeamRunErrors(): Promise<{ errors: TeamRunError[]; note: string }> {
  try {
    const { data, error } = await getSupabase()
      .from('team_runs')
      .select('team, status, error, started_at')
      .order('started_at', { ascending: false })
      .limit(40);
    if (error) return { errors: [], note: `خواندن team_runs ناموفق بود: ${error.message}` };
    const rows = (data ?? []) as TeamRunError[];
    const errors = rows.filter((r) => r.status === 'failed' || (r.error && r.error.trim()));
    return {
      errors: errors.slice(0, 12),
      note:
        errors.length === 0
          ? 'در ۴۰ اجرای اخیر team_runs هیچ خطا یا اجرای ناموفقی ثبت نشده است.'
          : `${errors.length} مورد از ۴۰ اجرای اخیر خطا/شکست دارند.`,
    };
  } catch (err) {
    return { errors: [], note: `خطا در اتصال به دیتابیس: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface Diagnosis {
  root_cause: string;
  ui_impact: string;
  fix_summary: string;
  fix_code: string;
  verification_steps: string[];
  confidence: 'high' | 'medium' | 'low';
  /** اگر داده برای تشخیص کافی نبود، دقیقاً چه اطلاعاتی لازم است. */
  needs_info: string[];
  /** مسیرهای پیشنهادی فایل‌های مرتبط در ریپو. */
  related_files: string[];
  /** پچ قابل اعمال: فقط وقتی گیت‌هاب متصل است و محتوای دقیق فایل‌ها را می‌دانیم. */
  patch_files: PatchFile[];
}

const DIAGNOSIS_SYSTEM = `تو دستیار فنی داشبورد «تایلندگرد» هستی (یک داشبورد Next.js فارسی راست‌چین با سوپابیس).
کاربر یک باگ را به فارسی توصیف کرده و تو زمینه‌ی «واقعی» داری: خطاهای ثبت‌شده‌ی team_runs، کامیت‌های اخیر گیت‌هاب، و گاهی محتوای فایل‌ها.
قانون‌ها:
- هیچ‌چیز را از خودت نساز: اگر زمینه کافی نیست، در needs_info دقیقاً بگو چه چیزی لازم داری و در بقیه‌ی فیلدها صادقانه بگو «اطلاعات کافی نیست».
- بدون خط تیره‌ی بلند (U+2014)؛ از «:» یا «|» استفاده کن.
- خروجی فقط JSON معتبر با همین کلیدها: root_cause, ui_impact, fix_summary, fix_code, verification_steps (آرایه‌ی رشته), confidence (high|medium|low), needs_info (آرایه‌ی رشته), related_files (آرایه‌ی رشته), patch_files (آرایه‌ی {path, content}).
- نقش‌ها را داخل متن همین‌طور نشان بده: «معمار سیستم» برای root_cause (ریشه‌ی محتمل با استناد به زمینه)، «دیزاینر» برای ui_impact (اثر روی رابط کاربری و تجربه‌ی موبایل)، «برنامه‌نویس» برای fix_summary و fix_code (فیکس پیشنهادی با کد دقیق)، «دیباگر» برای verification_steps (قدم‌های راستی‌آزمایی).
- patch_files را فقط وقتی پر کن که محتوای فعلی فایل‌ها را در زمینه دیده باشی و محتوای کامل جدید را مطمئن بنویسی؛ در غیر این صورت آرایه‌ی خالی.
- کد در fix_code به زبان انگلیسی (کد واقعی) و توضیح‌ها فارسی.`;

interface ContextSummary {
  errorsNote: string;
  errorsCount: number;
  commitsCount: number;
  githubConnected: boolean;
  githubMessage: string;
}

function buildContextText(
  bug: string,
  errors: TeamRunError[],
  errorsNote: string,
  commits: GithubCommit[] | null,
  repoFiles: Array<{ path: string; content: string | null }>,
): string {
  const parts: string[] = [];
  parts.push(`شرح باگ از کاربر: ${bug}`);
  parts.push(`خطاهای team_runs: ${errorsNote}`);
  for (const e of errors.slice(0, 8)) {
    parts.push(
      `- تیم ${e.team} | وضعیت ${e.status} | زمان ${e.started_at} | خطا: ${(e.error ?? '').slice(0, 500)}`,
    );
  }
  if (commits === null) {
    parts.push('کامیت‌های گیت‌هاب: در دسترس نیست (گیت‌هاب متصل نیست).');
  } else if (commits.length === 0) {
    parts.push('کامیت‌های گیت‌هاب: هیچ کامیتی برنگشت.');
  } else {
    parts.push('کامیت‌های اخیر:');
    for (const c of commits) {
      parts.push(`- ${c.sha} | ${c.message} | ${c.author} | ${c.date}`);
    }
  }
  for (const rf of repoFiles) {
    if (rf.content) {
      parts.push(`محتوای فایل ${rf.path}:\n${rf.content.slice(0, 6000)}`);
    } else {
      parts.push(`فایل ${rf.path} در ریپو پیدا نشد.`);
    }
  }
  return parts.join('\n');
}

/** حدس مسیرهای کاندید از روی شرح باگ (الگوهای ساده، نه جادو). */
function guessCandidateFiles(bug: string): string[] {
  const b = bug.toLowerCase();
  const out: string[] = [];
  const push = (p: string) => {
    if (out.length < 3 && !out.includes(p)) out.push(p);
  };
  if (/dashboard|داشبورد/.test(b)) push('app/dashboard/page.tsx');
  if (/cycle|چرخه/.test(b)) push('app/dashboard/cycles/page.tsx');
  if (/team|تیم/.test(b)) push('app/dashboard/teams/page.tsx');
  if (/nav|ناوبری|منو/.test(b)) push('components/Nav.tsx');
  if (/mobile|موبایل/.test(b)) push('components/MobileNav.tsx');
  if (/setting|تنظیم/.test(b)) push('app/dashboard/settings/page.tsx');
  if (/api|ای‌پی‌آی/.test(b)) push('lib/api.ts');
  if (/supabase|دیتابیس|پایگاه/.test(b)) push('lib/api.ts');
  return out;
}

/** POST /api/debug: تحلیل باگ با زمینه‌ی واقعی. */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const bug = typeof body.bug_description === 'string' ? body.bug_description.trim() : '';
    if (bug.length < 10) {
      return fail('شرح باگ خیلی کوتاه است؛ لطفاً با جزئیات بیشتری توصیف کنید (حداقل ۱۰ نویسه).', 400);
    }

    const [errCtx, gh] = await Promise.all([fetchRecentTeamRunErrors(), githubStatus()]);

    let commits: GithubCommit[] | null = null;
    if (gh.connected) {
      try {
        commits = await fetchRecentCommits(8);
      } catch {
        commits = [];
      }
    }

    const repoFiles: Array<{ path: string; content: string | null }> = [];
    if (gh.connected) {
      for (const p of guessCandidateFiles(bug)) {
        try {
          repoFiles.push({ path: p, content: await readRepoFile(p) });
        } catch {
          repoFiles.push({ path: p, content: null });
        }
      }
    }

    const contextText = buildContextText(bug, errCtx.errors, errCtx.note, commits, repoFiles);
    const contextSummary: ContextSummary = {
      errorsNote: errCtx.note,
      errorsCount: errCtx.errors.length,
      commitsCount: commits === null ? -1 : commits.length,
      githubConnected: gh.connected,
      githubMessage: gh.message,
    };

    let diagnosis: Diagnosis;
    try {
      diagnosis = await callLLMJson<Diagnosis>(
        `${DIAGNOSIS_SYSTEM}\n\n--- زمینه ---\n${contextText}\n\n--- شرح باگ ---\n${bug}\n\nفقط JSON برگردان.`,
        { maxTokens: 3000, temperature: 0.3, timeoutMs: 120_000 },
      );
    } catch (err) {
      return fail(
        `تحلیل با LLM ناموفق بود: ${err instanceof Error ? err.message : String(err)}. زمینه‌ی جمع‌شده حفظ شد؛ دوباره تلاش کنید.`,
      );
    }

    // بهداشت خروجی: اگر LLM چیزی ساختگی برگرداند، ساختار را محکم می‌کنیم
    const clean: Diagnosis = {
      root_cause: String(diagnosis.root_cause ?? ''),
      ui_impact: String(diagnosis.ui_impact ?? ''),
      fix_summary: String(diagnosis.fix_summary ?? ''),
      fix_code: String(diagnosis.fix_code ?? ''),
      verification_steps: Array.isArray(diagnosis.verification_steps)
        ? diagnosis.verification_steps.map(String)
        : [],
      confidence: ['high', 'medium', 'low'].includes(diagnosis.confidence)
        ? diagnosis.confidence
        : 'low',
      needs_info: Array.isArray(diagnosis.needs_info) ? diagnosis.needs_info.map(String) : [],
      related_files: Array.isArray(diagnosis.related_files) ? diagnosis.related_files.map(String) : [],
      patch_files:
        gh.connected && Array.isArray(diagnosis.patch_files)
          ? diagnosis.patch_files.filter(
              (p) => p && typeof p.path === 'string' && typeof p.content === 'string',
            )
          : [],
    };

    const status =
      clean.needs_info.length > 0 && clean.confidence === 'low' ? 'needs_info' : 'analyzed';

    const { data, error } = await getSupabase()
      .from('debug_sessions')
      .insert({
        bug_desc: bug,
        diagnosis: { ...clean, context_summary: contextSummary },
        status,
      })
      .select('id, bug_desc, status, created_at')
      .single();
    if (error) return fail(`ذخیره‌ی نشست ناموفق بود: ${error.message}`);

    return ok({ session: data, diagnosis: clean, context: contextSummary }, 201);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
