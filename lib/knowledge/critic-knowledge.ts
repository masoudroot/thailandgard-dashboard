/**
 * lib/knowledge/critic-knowledge.ts
 *
 * استخراج استاندارد دانش از حکم منتقد برای همه تیم‌ها.
 * الگو از lib/teams/branding.ts تعمیم یافته است.
 *
 * ساختار استاندارد دانش منتقد:
 * - الگوی مردود: چه چیزی رد شد
 * - دلیل: چرا رد شد
 * - دامنه: این حکم در کدام حوزه/جنبه کاربرد دارد
 * - قاعده آینده: در چرخه‌های بعد چه باید کرد
 * - شاهد: متن حکم منتقد به‌عنوان سند
 */

import type { TeamName } from '../types';
import { indexKnowledge } from '../rag';
import { getSupabase } from '../api';

export interface CriticVerdictInput {
  approved: boolean;
  reason: string;
  /** دامنه حکم (مثلاً: لحن، سئو، معماری). اگر خالی باشد از نام تیم استفاده می‌شود. */
  domain?: string;
  /** الگوی مردود به‌صورت خلاصه. اگر خالی باشد از reason استخراج می‌شود. */
  rejectedPattern?: string;
  /** دستور دقیق منتقد برای اصلاح (مثل پرامپت)؛ خالی اگر تأیید شده یا دستوری نداده. */
  instruction?: string;
  /** شماره دور حلقه نقد (۱، ۲ یا ۳). */
  round?: number;
  /** تاریخچه دورهای قبلی حلقه (برای ثبت نهایی). */
  rounds?: CriticRoundRecord[];
  /** آیا این نظر نهایی دور ۳ (فقط نظارت) است؟ */
  isFinal?: boolean;
}

/**
 * یک دور از حلقه نقد سه‌مرحله‌ای:
 * دور ۱ و ۲: رد ← دستور دقیق ← اجرای تیم؛ دور ۳: فقط نظارت و نظر نهایی.
 */
export interface CriticRoundRecord {
  /** شماره دور: ۱، ۲ یا ۳ */
  round: number;
  /** آیا منتقد در این دور تأیید کرد؟ */
  approved: boolean;
  /** شرح کامل دلیل با جزئیات */
  reason: string;
  /** دستور دقیق منتقد برای اصلاح (مثل پرامپت)؛ در دور تأییدشده خالی است */
  instruction?: string;
  /** خلاصه نتیجه اجرای دستور توسط تیم */
  outcome?: string;
}

export interface CriticKnowledgeResult {
  ok: boolean;
  knowledgeId?: string;
  title?: string;
  error?: string;
}

/**
 * ثبت fail-soft یک دانش در team_knowledge + ایندکس RAG.
 * خطا هرگز throw نمی‌شود؛ نتیجه برگردانده می‌شود.
 */
async function saveKnowledge(
  team: TeamName,
  title: string,
  content: string,
  source: string,
): Promise<CriticKnowledgeResult> {
  try {
    const sb = getSupabase();
    const { data: item, error: insertErr } = await sb
      .from('team_knowledge')
      .insert({ team, title, content, source })
      .select('id')
      .single();
    if (insertErr || !item?.id) {
      return { ok: false, error: `ثبت در team_knowledge ناموفق: ${insertErr?.message ?? 'بدون شناسه'}` };
    }
    try {
      await indexKnowledge(item.id, team, title, content);
    } catch (indexErr) {
      // ایندکس شکست خورد ولی رکورد ثبت شده؛ دانش قابل بازیابی است
      return {
        ok: false,
        knowledgeId: item.id,
        title,
        error: `ایندکس RAG ناموفق: ${indexErr instanceof Error ? indexErr.message : String(indexErr)}`,
      };
    }
    return { ok: true, knowledgeId: item.id, title };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** برچسب فارسی وضعیت یک دور. */
function roundStatusFa(approved: boolean): string {
  return approved ? 'تأیید شد' : 'رد شد';
}

/**
 * ساخت محتوای دانش یک دور از حلقه نقد (تابع خالص، تست‌پذیر).
 * شامل: دلیل کامل رد + دستور دقیق منتقد + نتیجه اجرای تیم.
 */
export function buildFeedbackRoundContent(
  team: TeamName,
  runId: string,
  round: CriticRoundRecord,
  domain?: string,
): { title: string; content: string } {
  const shortRun = String(runId ?? '').slice(0, 8);
  const d = domain?.trim() || team;
  const title = `حلقه نقد دور ${round.round}: ${roundStatusFa(round.approved)} (${d}، ${shortRun})`;
  const lines = [
    `دور: ${round.round} از ۳`,
    `وضعیت دور: ${roundStatusFa(round.approved)}`,
    `دلیل منتقد (شرح کامل): ${round.reason}`,
  ];
  if (round.instruction?.trim()) {
    lines.push(`دستور منتقد برای اصلاح: ${round.instruction.trim()}`);
  }
  if (round.outcome?.trim()) {
    lines.push(`نتیجه اجرای دستور توسط تیم: ${round.outcome.trim()}`);
  }
  lines.push(
    `دامنه: ${d}`,
    round.approved
      ? `قاعده آینده: این الگو در دور ${round.round} تأیید شد؛ در چرخه‌های بعد تکرار شود.`
      : `قاعده آینده: پیش از تحویل، خروجی با «دستور منتقد برای اصلاح» همین دور کنترل شود تا رد تکراری پیش نیاید.`,
    `شاهد: حلقه نقد چرخه ${shortRun} تیم ${team}، دور ${round.round}.`,
  );
  return { title, content: lines.join('\n') };
}

/**
 * ساخت محتوای نظر نهایی منتقد (دور ۳) با تاریخچه کامل دورها (تابع خالص، تست‌پذیر).
 */
export function buildFinalVerdictContent(
  team: TeamName,
  runId: string,
  rounds: CriticRoundRecord[],
  finalNote: string,
  domain?: string,
): { title: string; content: string } {
  const shortRun = String(runId ?? '').slice(0, 8);
  const d = domain?.trim() || team;
  const title = `نظر نهایی منتقد (${d}، ${shortRun})`;
  const lines = [
    `نظر نهایی منتقد پس از ۳ دور حلقه نقد (دور ۳: فقط نظارت، بدون رد).`,
    ``,
    `خلاصه دورها:`,
  ];
  const sorted = [...rounds].sort((a, b) => a.round - b.round);
  for (const r of sorted) {
    lines.push(`- دور ${r.round}: ${roundStatusFa(r.approved)}؛ دلیل: ${r.reason}`);
    if (r.instruction?.trim()) lines.push(`  دستور داده‌شده: ${r.instruction.trim()}`);
    if (r.outcome?.trim()) lines.push(`  نتیجه: ${r.outcome.trim()}`);
  }
  lines.push(
    ``,
    `نظر نهایی منتقد: ${finalNote}`,
    `دامنه: ${d}`,
    `قاعده آینده: درس‌های دورهای ردشده (دستورهای منتقد) در چرخه‌های بعد پیش از تحویل اعمال شود.`,
    `شاهد: حلقه نقد کامل چرخه ${shortRun} تیم ${team}.`,
  );
  return { title, content: lines.join('\n') };
}

/**
 * ثبت خلاصه یک دور رد/اصلاح در دانش تیم.
 * بعد از هر دور حلقه نقد صدا زده می‌شود: دلیل رد + دستور + نتیجه.
 */
export async function recordFeedbackRound(
  team: TeamName,
  runId: string,
  round: CriticRoundRecord,
  opts?: { domain?: string },
): Promise<CriticKnowledgeResult> {
  const { title, content } = buildFeedbackRoundContent(team, runId, round, opts?.domain);
  return saveKnowledge(team, title, content, 'critic-feedback-round');
}

/**
 * ثبت نظر نهایی منتقد (دور ۳) با تاریخچه کامل در دانش تیم.
 * طبق قرارداد، این ثبت به نام «ساب‌ایجنت دانش» انجام می‌شود تا در
 * چرخه‌های بعد از طریق RAG خوانده شود.
 */
export async function recordCriticFinalVerdict(
  team: TeamName,
  runId: string,
  rounds: CriticRoundRecord[],
  finalNote: string,
  opts?: { domain?: string },
): Promise<CriticKnowledgeResult> {
  const { title, content } = buildFinalVerdictContent(team, runId, rounds, finalNote, opts?.domain);
  return saveKnowledge(team, title, content, 'knowledge-subagent');
}

/**
 * پیام لاگ فارسی برای ثبت یک دور.
 */
export function feedbackRoundLog(result: CriticKnowledgeResult, round: number): string {
  if (result.ok) {
    return `درس دور ${round} حلقه نقد ثبت شد: ${result.title}`;
  }
  return `ثبت درس دور ${round} ناموفق بود: ${result.error ?? 'خطای نامشخص'}`;
}

/**
 * حکم منتقد را به دانش ساخت‌یافته تبدیل و در team_knowledge + RAG ثبت می‌کند.
 * fail-soft: خطا هرگز چرخه را متوقف نمی‌کند؛ نتیجه برگردانده می‌شود تا در گزارش تیم لاگ شود.
 *
 * نقطه فراخوانی: در انتهای runTeam هر تیم، بعد از داوری منتقد و قبل از return.
 * نسخه غنی‌شده: دستور منتقد (instruction)، شماره دور (round) و تاریخچه دورها
 * (rounds) هم در محتوا می‌آیند تا چرخه‌های بعد از دستورهای دقیق استفاده کنند.
 */
export async function extractCriticKnowledge(
  team: TeamName,
  verdict: CriticVerdictInput,
  runId: string,
): Promise<CriticKnowledgeResult> {
  const shortRun = String(runId ?? '').slice(0, 8);
  const domain = verdict.domain?.trim() || team;
  // reason ممکن است از JSON ناقص LLM خالی/نامعتبر بیاید؛ slice روی
  // undefined کل تیم را می‌انداخت (Cannot read properties of undefined)
  const reasonText = typeof verdict.reason === 'string' ? verdict.reason : '';
  const rejectedPattern =
    verdict.rejectedPattern?.trim() || reasonText.slice(0, 200) || '(دلیل ثبت نشد)';

  const roundTag = verdict.round ? ` (دور ${verdict.round})` : '';
  const title = verdict.isFinal
    ? `نظر نهایی منتقد ${domain} (${shortRun})`
    : verdict.approved
      ? `درس موفق ${domain} (${shortRun})${roundTag}`
      : `رد منتقد ${domain} (${shortRun})${roundTag}`;

  const lines = [
    `الگوی مردود: ${verdict.approved ? '(ندارد؛ الگو تأیید شد)' : rejectedPattern}`,
    `دلیل: ${reasonText || '(دلیل ثبت نشد)'}`,
  ];
  if (verdict.instruction?.trim()) {
    lines.push(`دستور منتقد برای اصلاح: ${verdict.instruction.trim()}`);
  }
  if (verdict.round) {
    lines.push(`دور حلقه نقد: ${verdict.round} از ۳`);
  }
  if (verdict.rounds && verdict.rounds.length > 0) {
    lines.push(`تاریخچه دورها:`);
    for (const r of [...verdict.rounds].sort((a, b) => a.round - b.round)) {
      lines.push(`- دور ${r.round}: ${roundStatusFa(r.approved)}؛ ${r.reason}`);
      if (r.instruction?.trim()) lines.push(`  دستور: ${r.instruction.trim()}`);
    }
  }
  lines.push(
    `دامنه: ${domain}`,
    verdict.approved
      ? `قاعده آینده: این الگو موفق بود؛ در چرخه‌های بعد تکرار شود.`
      : `قاعده آینده: از این الگو پرهیز شود؛ قبل از تحویل، با این قاعده کنترل شود.`,
    `شاهد: حکم منتقد در چرخه ${shortRun} تیم ${team}: ${verdict.approved ? 'تأیید' : 'رد'} شد.`,
  );

  return saveKnowledge(team, title, lines.join('\n'), 'critic-verdict');
}

/**
 * پیام لاگ فارسی برای گزارش تیم: ثبت موفق یا ناموفق دانش.
 */
export function criticKnowledgeLog(result: CriticKnowledgeResult): string {
  if (result.ok) {
    return `دانش منتقد ثبت شد: ${result.title}`;
  }
  return `ثبت دانش منتقد ناموفق بود: ${result.error ?? 'خطای نامشخص'}`;
}
