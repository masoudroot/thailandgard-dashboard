/**
 * ops-monitor/report-reviewer.ts — بررسی خودکار گزارش تیم‌ها.
 *
 * دستور مسعود (۲۵ مهر ۱۴۰۵): «گزارش‌ها را خودت چک کن و خودت تصمیم بگیر؛
 * من فوروارد نکنم.»
 *
 * هر ۱۰ دقیقه از کرون اجرا می‌شود:
 * ۱. team_runهای تازهٔ تمام‌شده را از واترمارک به بعد می‌خواند
 * ۲. برای هر تیم چک‌های کیفی محتوایی (فراتر از دروازهٔ ساختاری) اعمال می‌کند
 * ۳. bridge_patches گیرکرده در needs_review را بررسی می‌کند
 * ۴. حکم را در report_reviews ثبت می‌کند
 * ۵. فقط وقتی قضاوت مسعود لازم است، به تلگرامش پیام می‌دهد (سکوت در غیر این صورت)
 *
 * احکام:
 *   ok         ← سالم؛ نیازی به اقدام نیست
 *   attention  ← یافته‌ای هست ولی بحرانی نیست؛ ثبت شد، به مسعود خبر نرفت
 *   auto_fixed ← خودکار حل شد
 *   escalated  ← به مسعود ارجاع شد (تلگرام رفت)
 *
 * امن: فقط خواندن + ثبت review + اطلاع‌رسانی. وضعیت پچ‌ها را تغییر نمی‌دهد.
 */

import { getSupabase } from '../lib/api';
import { sendTelegram } from '../lib/notify';
import { WAVES } from '../lib/types';

/** تیم‌های فعال فعلی (از پیکربندی موج‌ها)؛ تیم‌های قدیمی (branding و...) ارجاع نمی‌شوند. */
const ACTIVE_TEAMS: ReadonlySet<string> = new Set(WAVES.flatMap((w) => w.teams));

const WATERMARK_KEY = 'report_reviewer_watermark';
const EM_DASH = '—';

/** یافتهٔ یک چک. */
interface Finding {
  check: string;
  passed: boolean;
  message: string;
}

/** نتیجهٔ بررسی یک منبع. */
interface ReviewResult {
  verdict: 'ok' | 'attention' | 'auto_fixed' | 'escalated';
  reason: string;
  findings: Finding[];
  notifyMasoud: boolean;
  notifyMessage?: string;
}

const ok = (reason = ''): ReviewResult => ({
  verdict: 'ok', reason, findings: [], notifyMasoud: false,
});

/** نرمال‌سازی برای مقایسهٔ معنایی H1 و تایتل: حذف علائم و فاصله. */
function normalizeFa(s: string): string {
  return s
    .replace(/[؛|:|،\-_«»"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** عبارات کلیشه‌ای در متا دیسکریپشن. */
const CLICHES = ['راهنمای جامع ما', 'سفری بی‌نقص', 'بهترین‌ها را', 'با ما همراه باشید'];

/**
 * چک‌های محتوایی سئو روی فایل‌های پچ.
 * معیارها (از بریف seo و نقدهای مسعود):
 * - h1 واقعاً از تایتل جدا باشد (نه فقط تعویض «؛» با «|»)
 * - طول متا تایتل ۵۰ تا ۶۰، دیسکریپشن ۱۲۰ تا ۱۶۰
 * - فارسی طبیعی، بدون خط تیرهٔ بلند، بدون کلیشه
 */
function checkSeoContent(files: Array<{ path: string; content: string }>): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (typeof f.content !== 'string') continue;
    const c = f.content;

    // استخراج H1_OVERRIDES و META_OVERRIDES
    const h1Matches = Array.from(c.matchAll(/"([\w-]+)":\s*"([^"]+)"/g));
    const metaMatches = Array.from(c.matchAll(/"([\w-]+)":\s*\{\s*title:\s*"([^"]+)"\s*,\s*description:\s*"([^"]+)"/g));

    const h1Entries: Array<[string, string]> = h1Matches.map((m) => [m[1], m[2]]);
    const metaEntries: Array<[string, { title: string; description: string }]> =
      metaMatches.map((m) => [m[1], { title: m[2], description: m[3] }]);
    const metaMap = new Map(metaEntries);

    for (const [slug, h1] of h1Entries) {
      const meta = metaMap.get(slug);
      if (meta) {
        // تفاوت واقعی H1 و تایتل؟
        const nH1 = normalizeFa(h1);
        const nTitle = normalizeFa(meta.title);
        if (nH1 === nTitle) {
          findings.push({
            check: 'تمایز H1 از تایتل',
            passed: false,
            message: `اسلاگ ${slug}: H1 و تایتل فقط در علائم فرق دارند، نه در معنا. H1 باید واقعاً متفاوت باشد.`,
          });
        } else {
          findings.push({ check: 'تمایز H1 از تایتل', passed: true, message: `اسلاگ ${slug}: تمایز واقعی دارد.` });
        }
        // طول تایتل
        const tLen = Array.from(meta.title).length;
        if (tLen < 40 || tLen > 70) {
          findings.push({
            check: 'طول متا تایتل',
            passed: false,
            message: `اسلاگ ${slug}: طول تایتل ${tLen} نویسه است؛ بازهٔ مناسب ۵۰ تا ۶۰ است.`,
          });
        }
        // طول دیسکریپشن
        const dLen = Array.from(meta.description).length;
        if (dLen < 100 || dLen > 180) {
          findings.push({
            check: 'طول متا دیسکریپشن',
            passed: false,
            message: `اسلاگ ${slug}: طول دیسکریپشن ${dLen} نویسه است؛ بازهٔ مناسب ۱۲۰ تا ۱۶۰ است.`,
          });
        }
        // کلیشه
        for (const cl of CLICHES) {
          if (meta.description.includes(cl)) {
            findings.push({
              check: 'کلیشه در دیسکریپشن',
              passed: false,
              message: `اسلاگ ${slug}: دیسکریپشن عبارت کلیشه‌ای «${cl}» دارد.`,
            });
          }
        }
      }
      // طول H1
      const hLen = Array.from(h1).length;
      if (hLen > 60) {
        findings.push({
          check: 'طول H1',
          passed: false,
          message: `اسلاگ ${slug}: H1 بیش از ۶۰ نویسه است (${hLen}).`,
        });
      }
    }
  }
  if (findings.length === 0) {
    findings.push({ check: 'سئوی محتوایی', passed: true, message: 'یافته‌ای نیست.' });
  }
  return findings;
}

/**
 * چک‌های محتوایی تیم محتوا:
 * - خروجی خالی یا پلیس‌هولدر نباشد
 * - خط تیرهٔ بلند نباشد
 */
function checkContentQuality(
  files: Array<{ path: string; content: string }>,
  summary: string,
): Finding[] {
  const findings: Finding[] = [];
  const s = summary.trim();
  if (s.length < 20 || s === '#' || /^#+\s*$/.test(s)) {
    findings.push({ check: 'خروجی محتوا', passed: false, message: 'خلاصهٔ خروجی خالی یا پلیس‌هولدر است.' });
  }
  for (const f of files) {
    if (typeof f.content === 'string' && f.content.includes(EM_DASH)) {
      findings.push({ check: 'خط تیرهٔ بلند', passed: false, message: `فایل ${f.path} خط تیرهٔ بلند دارد.` });
    }
  }
  if (findings.length === 0) {
    findings.push({ check: 'کیفیت محتوا', passed: true, message: 'یافته‌ای نیست.' });
  }
  return findings;
}

/**
 * چک‌های محتوایی دیزاین (ساختاری سبک):
 * - فایل TSX خالی نباشد
 * - رنگ هاردکد (hex) نداشته باشد؛ از توکن تم استفاده شود
 */
function checkDesignQuality(files: Array<{ path: string; content: string }>): Finding[] {
  const findings: Finding[] = [];
  const hexColor = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/;
  for (const f of files) {
    if (!f.path.endsWith('.tsx') || typeof f.content !== 'string') continue;
    if (f.content.trim().length < 50) {
      findings.push({ check: 'خروجی دیزاین', passed: false, message: `فایل ${f.path} خیلی کوتاه است؛ احتمالاً ناقص است.` });
    }
    if (hexColor.test(f.content)) {
      findings.push({
        check: 'توکن تم',
        passed: false,
        message: `فایل ${f.path} رنگ hex هاردکد دارد؛ باید از توکن‌های تم وایب‌فارسی استفاده شود.`,
      });
    }
  }
  if (findings.length === 0) {
    findings.push({ check: 'کیفیت دیزاین', passed: true, message: 'یافته‌ای نیست.' });
  }
  return findings;
}

/**
 * بررسی یک team_run تازه.
 * منطق: اگر تیم خودش رد کرده (rejected) یا fail شده، دلیل را می‌خوانیم؛
 * الگوی تکراری (۳ رد پیاپی) ← ارجاع به مسعود. در غیر این صورت سکوت.
 */
async function reviewTeamRun(
  sb: ReturnType<typeof getSupabase>,
  run: {
    id: string;
    team: string;
    status: string;
    cycle_id: string | null;
    output_summary: string | null;
    review_rounds: unknown;
  },
): Promise<ReviewResult> {
  const team = run.team;
  const summary = (run.output_summary ?? '').trim();

  // ۰. تیم غیرفعال (قدیمی، خارج از موج‌های فعلی): نادیده بگیر؛ ارجاع بی‌معنی است.
  if (!ACTIVE_TEAMS.has(team)) {
    return ok(`تیم ${team} در پیکربندی فعلی فعال نیست؛ نادیده گرفته شد.`);
  }

  // ۱. بررسی الگوی تکراری: ۳ اجرای پیاپی ناموفق همین تیم در ۲۴ ساعت اخیر؟
  // (فقط تاریخ تازه؛ تاریخ سیستم ۱۵تیمی قدیمی شمرده نمی‌شود)
  const dayAgo = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const { data: recent } = await sb
    .from('team_runs')
    .select('status')
    .eq('team', team)
    .gte('started_at', dayAgo)
    .order('started_at', { ascending: false })
    .limit(3);
  const badStreak = (recent ?? []).length === 3 &&
    (recent ?? []).every((r: { status: string }) => r.status === 'failed' || r.status === 'rejected');

  if (run.status === 'failed') {
    if (badStreak) {
      return {
        verdict: 'escalated',
        reason: `تیم ${team} سه بار پیاپی ناموفق بود.`,
        findings: [{ check: 'پایداری تیم', passed: false, message: 'سه اجرای پیاپی failed/rejected.' }],
        notifyMasoud: true,
        notifyMessage: `تیم ${team} سه بار پیاپی ناموفق بود. آخرین خطا: ${summary.slice(0, 200)}`,
      };
    }
    return ok(`تیم ${team} ناموفق بود ولی الگوی تکراری نیست؛ چرخه ادامه می‌یابد.`);
  }

  if (run.status === 'rejected') {
    if (badStreak) {
      return {
        verdict: 'escalated',
        reason: `تیم ${team} سه بار پیاپی رد شد.`,
        findings: [{ check: 'پایداری تیم', passed: false, message: 'سه رد پیاپی در چک رهبر.' }],
        notifyMasoud: true,
        notifyMessage: `تیم ${team} سه بار پیاپی در چک رهبر رد شد. آخرین دلیل: ${summary.slice(0, 200)}`,
      };
    }
    return {
      verdict: 'attention',
      reason: `تیم ${team} رد شد: ${summary.slice(0, 150)}`,
      findings: [{ check: 'چک رهبر', passed: false, message: summary.slice(0, 300) }],
      notifyMasoud: false,
    };
  }

  // ۲. اجرای موفق: چک کیفی محتوایی بر اساس پچ (اگر پچ دارد)
  const { data: patch } = await sb
    .from('bridge_patches')
    .select('id, files')
    .eq('cycle_id', run.cycle_id)
    .eq('team', team)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  const files = (patch as { files?: Array<{ path: string; content: string }> } | null)?.files ?? [];
  let findings: Finding[] = [];

  if (team === 'seo' && files.length > 0) {
    findings = checkSeoContent(files);
  } else if (team === 'content' && files.length > 0) {
    findings = checkContentQuality(files, summary);
  } else if (team === 'design' && files.length > 0) {
    findings = checkDesignQuality(files);
  }

  const failed = findings.filter((f) => !f.passed);
  if (failed.length === 0) {
    return ok(`تیم ${team} موفق؛ چک کیفی هم سبز.`);
  }

  // یافتهٔ کیفی هست ولی بحرانی نیست → ثبت، بدون اطلاع به مسعود
  // (مسعود فقط وقتی خبر می‌شود که الگو تکرار شود یا پچ گیر کند)
  return {
    verdict: 'attention',
    reason: `تیم ${team}: ${failed.length} یافتهٔ کیفی (${failed.map((f) => f.check).join('، ')}).`,
    findings,
    notifyMasoud: false,
  };
}

/**
 * بررسی پچ‌های گیرکرده در needs_review.
 * - اگر بیش از ۲۴ ساعت گیر کرده و قبلاً ارجاع نشده → ارجاع به مسعود
 * - در غیر این صورت → attention (ثبت، سکوت)
 */
async function reviewStuckPatch(
  sb: ReturnType<typeof getSupabase>,
  patch: {
    id: string;
    team: string;
    cycle_id: string | null;
    summary: string | null;
    gate_errors: unknown;
    created_at: string;
  },
): Promise<ReviewResult> {
  const ageHours = (Date.now() - new Date(patch.created_at).getTime()) / 3_600_000;
  const errors = Array.isArray(patch.gate_errors) ? patch.gate_errors.join(' | ') : String(patch.gate_errors ?? '');

  // قبلاً برای این پچ ارجاع شده؟
  const { data: prior } = await sb
    .from('report_reviews')
    .select('id')
    .eq('source_type', 'bridge_patch')
    .eq('source_id', patch.id)
    .eq('verdict', 'escalated')
    .limit(1);
  const alreadyEscalated = (prior ?? []).length > 0;

  if (ageHours > 24 && !alreadyEscalated) {
    return {
      verdict: 'escalated',
      reason: `پچ تیم ${patch.team} بیش از ۲۴ ساعت در needs_review گیر کرده.`,
      findings: [{ check: 'پچ گیرکرده', passed: false, message: errors.slice(0, 400) }],
      notifyMasoud: true,
      notifyMessage:
        `پچ تیم ${patch.team} بیش از ۲۴ ساعت در بررسی گیر کرده.\n` +
        `خلاصه: ${(patch.summary ?? '').slice(0, 150)}\n` +
        `خطا: ${errors.slice(0, 300)}`,
    };
  }

  return {
    verdict: 'attention',
    reason: `پچ تیم ${patch.team} در needs_review است (${Math.round(ageHours)} ساعت).`,
    findings: [{ check: 'وضعیت پچ', passed: false, message: errors.slice(0, 300) }],
    notifyMasoud: false,
  };
}

async function getWatermark(sb: ReturnType<typeof getSupabase>): Promise<string> {
  const { data } = await sb.from('settings').select('value').eq('key', WATERMARK_KEY).maybeSingle();
  const v = (data as { value?: unknown } | null)?.value;
  if (typeof v === 'string') return v;
  return '1970-01-01T00:00:00Z';
}

async function setWatermark(sb: ReturnType<typeof getSupabase>, iso: string): Promise<void> {
  await sb.from('settings').upsert({ key: WATERMARK_KEY, value: iso, updated_at: new Date().toISOString() });
}

async function alreadyReviewed(
  sb: ReturnType<typeof getSupabase>,
  sourceType: string,
  sourceId: string,
): Promise<boolean> {
  const { data } = await sb
    .from('report_reviews')
    .select('id')
    .eq('source_type', sourceType)
    .eq('source_id', sourceId)
    .limit(1);
  return (data ?? []).length > 0;
}

async function saveReview(
  sb: ReturnType<typeof getSupabase>,
  args: {
    sourceType: 'team_run' | 'bridge_patch';
    sourceId: string;
    team: string;
    cycleId: string | null;
    verdict: ReviewResult['verdict'];
    reason: string;
    findings: Finding[];
    notified: boolean;
  },
): Promise<void> {
  await sb.from('report_reviews').insert({
    source_type: args.sourceType,
    source_id: args.sourceId,
    team: args.team,
    cycle_id: args.cycleId,
    verdict: args.verdict,
    reason: args.reason,
    findings: args.findings,
    notified: args.notified,
  });
}

async function main(): Promise<void> {
  const sb = getSupabase();
  const watermark = await getWatermark(sb);
  console.log(`[reviewer] واترمارک: ${watermark}`);

  let reviewed = 0;
  let escalated = 0;

  // ۱. team_runهای تازهٔ تمام‌شده
  const { data: runs, error: runsErr } = await sb
    .from('team_runs')
    .select('id, team, status, cycle_id, output_summary, review_rounds, finished_at')
    .not('finished_at', 'is', null)
    .gt('finished_at', watermark)
    .order('finished_at', { ascending: true })
    .limit(50);

  if (runsErr) {
    console.error('[reviewer] خطا در خواندن team_runs:', runsErr.message);
  } else {
    for (const run of runs ?? []) {
      const r = run as {
        id: string; team: string; status: string; cycle_id: string | null;
        output_summary: string | null; review_rounds: unknown; finished_at: string;
      };
      if (await alreadyReviewed(sb, 'team_run', r.id)) continue;
      try {
        const res = await reviewTeamRun(sb, r);
        let notified = false;
        if (res.notifyMasoud && res.notifyMessage) {
          const msgId = await sendTelegram('بازبین گزارش', res.notifyMessage);
          notified = msgId !== null;
        }
        await saveReview(sb, {
          sourceType: 'team_run',
          sourceId: r.id,
          team: r.team,
          cycleId: r.cycle_id,
          verdict: res.verdict,
          reason: res.reason,
          findings: res.findings,
          notified,
        });
        reviewed++;
        if (res.verdict === 'escalated') escalated++;
        console.log(`[reviewer] team_run ${r.team}/${r.status} → ${res.verdict}: ${res.reason.slice(0, 100)}`);
      } catch (err) {
        console.error(`[reviewer] خطا در بررسی team_run ${r.id}:`, err instanceof Error ? err.message : err);
      }
    }
    // واترمارک را به آخرین finished_at برسان
    const last = (runs ?? [])[(runs ?? []).length - 1] as { finished_at?: string } | undefined;
    if (last?.finished_at) await setWatermark(sb, last.finished_at);
  }

  // ۲. پچ‌های needs_review که هنوز بررسی نشده‌اند
  const { data: patches, error: patchesErr } = await sb
    .from('bridge_patches')
    .select('id, team, cycle_id, summary, gate_errors, created_at')
    .eq('status', 'needs_review')
    .order('created_at', { ascending: true })
    .limit(20);

  if (patchesErr) {
    console.error('[reviewer] خطا در خواندن bridge_patches:', patchesErr.message);
  } else {
    for (const p of patches ?? []) {
      const patch = p as {
        id: string; team: string; cycle_id: string | null;
        summary: string | null; gate_errors: unknown; created_at: string;
      };
      if (await alreadyReviewed(sb, 'bridge_patch', patch.id)) continue;
      try {
        const res = await reviewStuckPatch(sb, patch);
        let notified = false;
        if (res.notifyMasoud && res.notifyMessage) {
          const msgId = await sendTelegram('بازبین گزارش', res.notifyMessage);
          notified = msgId !== null;
        }
        await saveReview(sb, {
          sourceType: 'bridge_patch',
          sourceId: patch.id,
          team: patch.team,
          cycleId: patch.cycle_id,
          verdict: res.verdict,
          reason: res.reason,
          findings: res.findings,
          notified,
        });
        reviewed++;
        if (res.verdict === 'escalated') escalated++;
        console.log(`[reviewer] patch ${patch.team}/${patch.id.slice(0, 8)} → ${res.verdict}: ${res.reason.slice(0, 100)}`);
      } catch (err) {
        console.error(`[reviewer] خطا در بررسی patch ${patch.id}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  console.log(`[reviewer] تمام شد: ${reviewed} بررسی، ${escalated} ارجاع به مسعود.`);
}

main().catch((err) => {
  console.error('[reviewer] خطای مرگبار:', err instanceof Error ? err.message : err);
  process.exit(1);
});
