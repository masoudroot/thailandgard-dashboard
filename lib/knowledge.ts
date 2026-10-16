/**
 * lib/knowledge.ts: ابزارهای مشترک API دانش تیم‌ها (تیم ۱۱).
 *
 * - اعتبارسنجی slug تیم با TEAM_META
 * - ثبت تاریخچه در knowledge_history
 * - فراخوانی امن indexKnowledge / deleteKnowledgeIndex از lib/rag.ts:
 *   اگر تیم ۲/۳ هنوز آن‌ها را نساخته باشند، بدون ایندکس ادامه می‌دهیم.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { TEAM_META } from './team-meta';
import type { TeamName } from './types';
import * as rag from './rag';
import { reportIndexOutcome } from './rag-index-health';

export const TEAM_SLUGS = Object.keys(TEAM_META) as TeamName[];

/** slug معتبر است اگر یکی از کلیدهای TEAM_META باشد. */
export function isValidTeam(slug: string): slug is TeamName {
  return slug in TEAM_META;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** شناسه دانش باید UUID باشد. */
export function isKnowledgeId(value: string): boolean {
  return UUID_RE.test(value);
}

type HistoryAction = 'create' | 'update' | 'delete';

/** ثبت یک ردیف در knowledge_history (اسنپ‌شات قبل/بعد تغییر). */
export async function recordHistory(
  sb: SupabaseClient,
  row: {
    knowledge_id: string;
    team: string;
    title: string;
    content: string;
    action: HistoryAction;
  },
): Promise<void> {
  const { error } = await sb.from('knowledge_history').insert(row);
  if (error) {
    throw new Error(`ثبت تاریخچه دانش ناموفق بود: ${error.message}`);
  }
}

/** خلاصه کوتاه از متن برای نمایش در لیست. */
export function makeSnippet(content: string, length = 200): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > length ? flat.slice(0, length) + '…' : flat;
}

// ایندکس RAG ممکن است هنوز در lib/rag.ts ساخته نشده باشد (کار تیم ۲/۳)؛
// پس در زمان اجرا بررسی می‌کنیم، نه با import ایستا.
type IndexKnowledgeFn = (
  knowledgeId: string,
  team: string,
  title: string,
  content: string,
) => Promise<void>;
type DeleteKnowledgeIndexFn = (knowledgeId: string) => Promise<void>;
const ragFns = rag as unknown as {
  indexKnowledge?: IndexKnowledgeFn;
  deleteKnowledgeIndex?: DeleteKnowledgeIndexFn;
};

/**
 * ایندکس کردن دانش در RAG. اگر indexKnowledge هنوز وجود نداشت یا خطا داد،
 * false برمی‌گرداند تا درخواست اصلی (ساخت/ویرایش) موفق بماند.
 *
 * رفع ریشه‌ای مشکل ۳: خطا دیگر بی‌صدا نیست؛ هر نتیجه (موفق/ناموفق) در
 * لاگ ساخت‌یافته و شمارنده‌ی سلامت دیتابیس ثبت می‌شود
 * (lib/rag-index-health.ts) و خطاهای پیاپی هشدار می‌گیرند.
 */
export async function tryIndexKnowledge(
  knowledgeId: string,
  team: string,
  title: string,
  content: string,
): Promise<boolean> {
  const fn = ragFns.indexKnowledge;
  if (typeof fn !== 'function') return false;
  try {
    await fn(knowledgeId, team, title, content);
    await reportIndexOutcome({
      knowledgeId,
      team,
      ok: true,
      source: 'tryIndexKnowledge',
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await reportIndexOutcome({
      knowledgeId,
      team,
      ok: false,
      error: message,
      source: 'tryIndexKnowledge',
    });
    return false;
  }
}

/** حذف ایندکس یک دانش؛ نبود تابع یعنی ایندکسی هم نبوده است. */
export async function tryDeleteKnowledgeIndex(
  knowledgeId: string,
): Promise<boolean> {
  const fn = ragFns.deleteKnowledgeIndex;
  if (typeof fn !== 'function') return false;
  try {
    await fn(knowledgeId);
    return true;
  } catch {
    return false;
  }
}
