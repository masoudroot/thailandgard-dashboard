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
}

export interface CriticKnowledgeResult {
  ok: boolean;
  knowledgeId?: string;
  title?: string;
  error?: string;
}

/**
 * حکم منتقد را به دانش ساخت‌یافته تبدیل و در team_knowledge + RAG ثبت می‌کند.
 * fail-soft: خطا هرگز چرخه را متوقف نمی‌کند؛ نتیجه برگردانده می‌شود تا در گزارش تیم لاگ شود.
 *
 * نقطه فراخوانی: در انتهای runTeam هر تیم، بعد از داوری منتقد و قبل از return.
 */
export async function extractCriticKnowledge(
  team: TeamName,
  verdict: CriticVerdictInput,
  runId: string,
): Promise<CriticKnowledgeResult> {
  const shortRun = runId.slice(0, 8);
  const domain = verdict.domain?.trim() || team;
  const rejectedPattern = verdict.rejectedPattern?.trim() || verdict.reason.slice(0, 200);

  const title = verdict.approved
    ? `درس موفق ${domain} (${shortRun})`
    : `رد منتقد ${domain} (${shortRun})`;

  const content = [
    `الگوی مردود: ${verdict.approved ? '(ندارد؛ الگو تأیید شد)' : rejectedPattern}`,
    `دلیل: ${verdict.reason}`,
    `دامنه: ${domain}`,
    verdict.approved
      ? `قاعده آینده: این الگو موفق بود؛ در چرخه‌های بعد تکرار شود.`
      : `قاعده آینده: از این الگو پرهیز شود؛ قبل از تحویل، با این قاعده کنترل شود.`,
    `شاهد: حکم منتقد در چرخه ${shortRun} تیم ${team}: ${verdict.approved ? 'تأیید' : 'رد'} شد.`,
  ].join('\n');

  try {
    const sb = getSupabase();
    const { data: item, error: insertErr } = await sb
      .from('team_knowledge')
      .insert({ team, title, content, source: 'critic-verdict' })
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

/**
 * پیام لاگ فارسی برای گزارش تیم: ثبت موفق یا ناموفق دانش.
 */
export function criticKnowledgeLog(result: CriticKnowledgeResult): string {
  if (result.ok) {
    return `دانش منتقد ثبت شد: ${result.title}`;
  }
  return `ثبت دانش منتقد ناموفق بود: ${result.error ?? 'خطای نامشخص'}`;
}
