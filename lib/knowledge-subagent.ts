/**
 * lib/knowledge-subagent.ts — ساب‌ایجنت دانش.
 *
 * در شروع نوبت هر تیم، منابع معتبر بیرونی را می‌خواند و نکته‌های تازه را
 * در دانش همان تیم ذخیره می‌کند. هر ۱۵ تیم از طریق یک نقطه اتصال در
 * ارکستراتور صاحب این ساب‌ایجنت می‌شوند (فقط ارکستراتور صدا می‌زند).
 *
 * طراحی: docs/knowledge-subagent-arch.md (تیم ۱ از ۱۰ تیم مدیریت دانش)
 * استخراج نکته: lib/knowledge-pipeline.ts (تیم ۳)
 *
 * قراردادها:
 * - برچسب ردیف در جدول subagents: دقیقاً «دانش: گردآوری»
 * - مقدار source در team_knowledge: دقیقاً 'knowledge-subagent'
 * - اکشن تاریخچه: 'external-refresh' (موفق) / 'external-refresh-skipped' (رد سالم)
 *
 * fail-soft: این تابع هرگز throw نمی‌کند؛ هر خطایی به نتیجه برگردانده می‌شود.
 * وابستگی‌های بیرونی از طریق پارامتر deps تزریق می‌شوند تا تست‌پذیر بماند؛
 * در اجرای واقعی از createDefaultDeps() استفاده می‌شود.
 */

import { createHash } from 'crypto';
import type { ProgressReporter, TeamName } from './types';
import { getSupabase } from './api';
import { TEAM_META } from './team-meta';
import { indexKnowledge, retrieveKnowledgeChunks } from './rag';
import { reportIndexOutcome } from './rag-index-health';
import { extractKnowledgePoints } from './knowledge-pipeline';
import {
  recordCriticFinalVerdict,
  type CriticKnowledgeResult,
  type CriticRoundRecord,
} from './knowledge/critic-knowledge';

/** آیتم دانش تازه استخراج‌شده از یک منبع. */
export interface NewKnowledgeItem {
  /** عنوان کوتاه فارسی */
  title: string;
  /** ۲ تا ۵ جمله فارسی، کاربردی، بدون کلی‌گویی */
  content: string;
  /** نام نمایشی منبع */
  sourceName: string;
  /** آدرس دقیق صفحه‌ای که خوانده شد */
  sourceUrl: string;
  /** درجه اعتبار منبع (۱ رسمی ← ۳ تجربه کاربردی) */
  authorityTier: 1 | 2 | 3;
}

/** منبع دانش ثبت‌شده برای یک تیم. */
export interface KnowledgeSource {
  id: string;
  team: TeamName;
  name: string;
  url: string;
  authorityTier: 1 | 2 | 3;
  isActive: boolean;
  /** آخرین بازخوانی موفق/ناموفق (ISO)؛ null یعنی هنوز خوانده نشده */
  lastFetchedAt: string | null;
  /** هر چند ساعت یک بار بازخوانی شود؛ پیش‌فرض ۱۶۸ (هفتگی) */
  fetchFrequencyHours: number;
}

/** نتیجه اجرای ساب‌ایجنت دانش در یک نوبت تیم. */
export interface KnowledgeSubagentResult {
  /** آیا به‌روزرسانی واقعی (حداقل یک نکته تازه) انجام شد؟ */
  refreshed: boolean;
  /** نام منابعی که در این نوبت بررسی شدند */
  sourcesChecked: string[];
  /** یافته‌های تازه (خالی اگر چیزی نبود) */
  newItems: NewKnowledgeItem[];
  /** دلیل رد/عدم‌یافت، فارسی و کوتاه؛ null یعنی به‌روزرسانی شد */
  skippedReason: string | null;
  /** یک خط فارسی برای لاگ و تاریخچه */
  summary: string;
  /** تعداد فراخوانی‌های LLM این مرحله */
  llmCalls: number;
  /** خلاصه تزریقی در ragContext سرپرست؛ null اگر چیز تازه‌ای نبود */
  contextSnippet: string | null;
}

/** آستانه شباهت برای تکراری شناخته شدن یک نکته. */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.92;
/** سقف منابع بررسی‌شده در هر نوبت. */
export const MAX_SOURCES_PER_RUN = 2;
/** سقف آیتم‌های استخراج‌شده از هر منبع. */
export const MAX_ITEMS_PER_SOURCE = 3;
/** سقف کل آیتم‌های تازه در هر نوبت. */
export const MAX_ITEMS_PER_RUN = 5;
/** برچسب ثابت مرحله در جدول subagents. */
export const KNOWLEDGE_STAGE_LABEL = 'دانش: گردآوری';
/** مقدار source برای رکوردهای این مسیر در team_knowledge. */
export const KNOWLEDGE_SOURCE_VALUE = 'knowledge-subagent';

/** وابستگی‌های بیرونی؛ در تست با نسخه جعلی جایگزین می‌شوند. */
export interface KnowledgeSubagentDeps {
  listSources: (team: TeamName) => Promise<KnowledgeSource[]>;
  /** متن تمیزشده صفحه را برمی‌گرداند؛ در خطا throw می‌کند. */
  fetchSourceText: (url: string) => Promise<string>;
  /** نکات را با LLM استخراج می‌کند؛ حداکثر MAX_ITEMS_PER_SOURCE آیتم. */
  extractItems: (
    cleanText: string,
    mission: string,
    teamFa: string,
    source: KnowledgeSource,
    existingTitles: string[],
  ) => Promise<NewKnowledgeItem[]>;
  /** بیشترین شباهت نکته با دانش موجود تیم؛ null یعنی قابل سنجش نیست. */
  maxSimilarity: (title: string, team: TeamName) => Promise<number | null>;
  /** هش محتوای تکراری قبلاً ثبت شده؟ */
  isHashDuplicate: (team: TeamName, hash: string) => Promise<boolean>;
  /** ذخیره در team_knowledge + ایندکس RAG؛ شناسه برمی‌گرداند. */
  saveKnowledge: (team: TeamName, item: NewKnowledgeItem, sourceId: string) => Promise<string>;
  markSourceChecked: (sourceId: string, ok: boolean, error?: string) => Promise<void>;
  logHistory: (team: TeamName, action: string, summary: string, knowledgeIds?: string[]) => Promise<void>;
  listExistingTitles: (team: TeamName) => Promise<string[]>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** آیا این منبع در این نوبت سررسید بازخوانی است؟ */
export function isSourceDue(src: KnowledgeSource, now: number = Date.now()): boolean {
  if (!src.lastFetchedAt) return true;
  const freq = src.fetchFrequencyHours > 0 ? src.fetchFrequencyHours : 168;
  const last = Date.parse(src.lastFetchedAt);
  if (Number.isNaN(last)) return true;
  return now - last >= freq * 3_600_000;
}

function contentHash(team: string, title: string, content: string): string {
  return createHash('sha256').update(`${team}|${title}|${content}`).digest('hex').slice(0, 32);
}

/** ارقام لاتین را به فارسی تبدیل می‌کند. */
function toFa(n: number): string {
  return String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
}

// ---------------------------------------------------------------------------
// پیاده‌سازی‌های پیش‌فرض (اتصال به دیتابیس و LLM واقعی)
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 8_000;

async function defaultFetchSourceText(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('آدرس منبع معتبر نیست.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('فقط منابع http/https خوانده می‌شوند.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'ThailandGard-KnowledgeBot/1.0 (+https://thailandgard.ir)' },
    });
    if (!res.ok) throw new Error(`خطای HTTP ${res.status}`);
    const len = res.headers.get('content-length');
    if (len && Number(len) > MAX_RESPONSE_BYTES) throw new Error('حجم پاسخ بیش از سقف مجاز است.');
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_RESPONSE_BYTES) throw new Error('حجم پاسخ بیش از سقف مجاز است.');
    const html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    return cleanHtmlToText(html);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error('تایم‌اوت دریافت صفحه.');
    throw err instanceof Error ? err : new Error('خطای ناشناخته در دریافت صفحه.');
  } finally {
    clearTimeout(timer);
  }
}

/** استخراج متن خوانا از HTML: حذف تگ‌ها، اسکریپت‌ها و ناوبری. */
function cleanHtmlToText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > MAX_TEXT_CHARS) {
    const cut = text.slice(0, MAX_TEXT_CHARS);
    const lastDot = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('.'), cut.lastIndexOf('؟'), cut.lastIndexOf('!'));
    text = lastDot > MAX_TEXT_CHARS * 0.7 ? cut.slice(0, lastDot + 1) : cut;
  }
  return text;
}

/** وابستگی‌های واقعی برای اجرای پروداکشن. */
export function createDefaultDeps(): KnowledgeSubagentDeps {
  return {
    async listSources(team) {
      const sb = getSupabase();
      const { data, error } = await sb
        .from('knowledge_sources')
        .select('id, team, url, title, authority_tier, fetch_frequency_hours, last_fetched_at, is_active')
        .eq('team', team)
        .eq('is_active', true)
        .order('last_fetched_at', { ascending: true, nullsFirst: true });
      if (error) throw new Error(`خوانش منابع دانش ناموفق بود: ${error.message}`);
      return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        team,
        name: (r.title as string)?.trim() || String(r.url),
        url: String(r.url),
        authorityTier: r.authority_tier === 1 || r.authority_tier === 3 ? (r.authority_tier as 1 | 3) : 2,
        isActive: true,
        lastFetchedAt: (r.last_fetched_at as string) ?? null,
        fetchFrequencyHours: typeof r.fetch_frequency_hours === 'number' ? r.fetch_frequency_hours : 168,
      }));
    },

    async fetchSourceText(url) {
      return defaultFetchSourceText(url);
    },

    async extractItems(cleanText, mission, teamFa, source, existingTitles) {
      if (cleanText.trim().length < 100) return [];
      const points = await extractKnowledgePoints(cleanText, mission, {
        teamFa,
        sourceName: source.name,
        sourceUrl: source.url,
        existingTitles,
        maxPoints: MAX_ITEMS_PER_SOURCE,
      });
      return points.map((p) => ({
        title: p.title.trim(),
        content: [p.point.trim(), `چرا مهم است: ${p.why_matters.trim()}`, p.quote ? `شاهد از منبع: ${p.quote.trim()}` : '']
          .filter(Boolean)
          .join('\n'),
        sourceName: source.name,
        sourceUrl: source.url,
        authorityTier: source.authorityTier,
      }));
    },

    async maxSimilarity(title, team) {
      try {
        const chunks = await retrieveKnowledgeChunks(title, team, 1);
        return chunks.length > 0 ? chunks[0].similarity : null;
      } catch {
        return null;
      }
    },

    async isHashDuplicate(team, hash) {
      try {
        const sb = getSupabase();
        const { data } = await sb.from('team_knowledge').select('id').eq('team', team).eq('content_hash', hash).limit(1);
        return !!data && data.length > 0;
      } catch {
        return false;
      }
    },

    async saveKnowledge(team, item, sourceId) {
      const sb = getSupabase();
      const hash = contentHash(team, item.title, item.content);
      const { data, error } = await sb
        .from('team_knowledge')
        .insert({
          team,
          title: item.title.slice(0, 200),
          content: item.content.slice(0, 4000),
          source: KNOWLEDGE_SOURCE_VALUE,
          source_id: sourceId,
          authority_tier: item.authorityTier,
          origin: 'source-fetch',
          extracted_at: new Date().toISOString(),
          content_hash: hash,
          freshness_status: 'fresh',
        })
        .select('id')
        .single();
      if (error || !data) throw new Error(`ذخیره دانش ناموفق بود: ${error?.message ?? 'بدون شناسه'}`);
      // ایندکس RAG؛ fail-soft: ردیف والد می‌ماند، ولی خطا دیگر بی‌صدا نیست —
      // در لاگ ساخت‌یافته و شمارنده‌ی سلامت ثبت می‌شود (رفع ریشه‌ای مشکل ۳).
      try {
        await indexKnowledge(data.id, team, item.title, item.content);
        await reportIndexOutcome({
          knowledgeId: data.id as string,
          team,
          ok: true,
          source: 'knowledge-subagent',
        });
      } catch (err) {
        await reportIndexOutcome({
          knowledgeId: data.id as string,
          team,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          source: 'knowledge-subagent',
        });
        // ایندکس مجدد در نوبت بعدی
      }
      return data.id as string;
    },

    async markSourceChecked(sourceId, ok, error) {
      try {
        const sb = getSupabase();
        await sb
          .from('knowledge_sources')
          .update({
            last_fetched_at: new Date().toISOString(),
            last_fetch_status: ok ? 'ok' : 'failed',
            last_fetch_error: ok ? null : (error ?? 'خطای ناشناخته').slice(0, 500),
            updated_at: new Date().toISOString(),
          })
          .eq('id', sourceId);
      } catch {
        // بی‌صدا رد می‌شود
      }
    },

    async logHistory(team, action, summary, knowledgeIds = []) {
      try {
        const sb = getSupabase();
        if (knowledgeIds.length > 0) {
          const { data } = await sb.from('team_knowledge').select('id, title, content').in('id', knowledgeIds);
          const rows = ((data ?? []) as Array<{ id: string; title: string; content: string }>).map((r) => ({
            knowledge_id: r.id,
            team,
            title: r.title,
            content: (r.content ?? '').slice(0, 2000),
            action,
          }));
          if (rows.length > 0) await sb.from('knowledge_history').insert(rows);
        } else {
          // رد سالم یا خطای کلی: بدون رکورد دانش، فقط در لاگ ورکر دیده می‌شود
          void summary;
        }
      } catch {
        // تاریخچه اختیاری است
      }
    },

    async listExistingTitles(team) {
      try {
        const sb = getSupabase();
        const { data } = await sb
          .from('team_knowledge')
          .select('title')
          .eq('team', team)
          .order('created_at', { ascending: false })
          .limit(20);
        return ((data ?? []) as Array<{ title: string }>).map((r) => r.title).filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

// ---------------------------------------------------------------------------
// اجرای اصلی
// ---------------------------------------------------------------------------

/**
 * ساب‌ایجنت دانش یک تیم را اجرا می‌کند.
 *
 * @param team نام تیم
 * @param runId شناسه چرخه (برای لاگ و تاریخچه)
 * @param ragContext زمینه این چرخه؛ برای سنجش ربط نکته‌ها در نسخه‌های آینده نگه داشته شده
 * @param reportProgress گزارش‌دهنده ارکستراتور (ردیف «دانش: گردآوری» را می‌سازد)
 * @param deps وابستگی‌های بیرونی؛ پیش‌فرض واقعی
 *
 * هرگز throw نمی‌کند؛ همیشه یک KnowledgeSubagentResult برمی‌گرداند.
 * ردیف ساب‌ایجنت با اولین reportProgress بعدی تیم، خودکار موفق بسته می‌شود.
 */
export async function runKnowledgeSubagent(
  team: TeamName,
  runId: string,
  ragContext: string,
  reportProgress: ProgressReporter,
  deps: KnowledgeSubagentDeps = createDefaultDeps(),
): Promise<KnowledgeSubagentResult> {
  void runId;
  void ragContext;
  const faName = TEAM_META[team]?.faName ?? team;
  const mission = TEAM_META[team]?.mission ?? '';

  const fail = (summary: string, skippedReason: string, sourcesChecked: string[] = [], llmCalls = 0): KnowledgeSubagentResult => ({
    refreshed: false,
    sourcesChecked,
    newItems: [],
    skippedReason,
    summary,
    llmCalls,
    contextSnippet: null,
  });

  try {
    try {
      await reportProgress(KNOWLEDGE_STAGE_LABEL, 8);
    } catch {
      // خطای گزارش‌دهی نباید مرحله را بشکند
    }

    // ۱. خوانش منابع فعال تیم
    let sources: KnowledgeSource[];
    try {
      sources = (await deps.listSources(team)).filter((s) => s.isActive);
    } catch {
      return fail(
        `ساب‌ایجنت دانش تیم ${faName}: خوانش فهرست منابع ناموفق بود؛ با دانش قبلی ادامه می‌دهیم.`,
        'خطا در خوانش فهرست منابع',
      );
    }

    if (sources.length === 0) {
      return fail(
        `ساب‌ایجنت دانش تیم ${faName}: منبعی برای این تیم ثبت نشده است.`,
        'منبع فعالی ثبت نشده',
      );
    }

    // ۲. قانون تازگی (بدون هزینه LLM): فقط منابع سررسیده
    const due = sources.filter((s) => isSourceDue(s)).slice(0, MAX_SOURCES_PER_RUN);
    if (due.length === 0) {
      return fail(
        `ساب‌ایجنت دانش تیم ${faName}: دانش به‌روز است؛ بازخوانی لازم نبود.`,
        'دانش تیم به‌روز است؛ همه منابع در بازه تنظیم‌شده بررسی شده‌اند',
      );
    }

    const existingTitles = await deps.listExistingTitles(team);

    const newItems: NewKnowledgeItem[] = [];
    const savedIds: string[] = [];
    const sourcesChecked: string[] = [];
    let llmCalls = 0;

    // ۳. خط لوله هر منبع: فچ ← استخراج ← تکراری‌زدایی ← ذخیره
    for (const source of due) {
      sourcesChecked.push(source.name);

      // فچ (fail-soft برای هر منبع جدا)
      let cleanText = '';
      try {
        cleanText = await deps.fetchSourceText(source.url);
        if (!cleanText.trim()) throw new Error('متن قابل‌استفاده‌ای استخراج نشد.');
      } catch (err) {
        await deps.markSourceChecked(source.id, false, err instanceof Error ? err.message : undefined);
        continue;
      }

      // استخراج نکته با LLM
      let extracted: NewKnowledgeItem[];
      try {
        extracted = await deps.extractItems(cleanText, mission, faName, source, existingTitles);
        llmCalls += 1;
      } catch {
        await deps.markSourceChecked(source.id, false, 'خطای استخراج نکته');
        continue;
      }

      let foundNewForSource = false;
      for (const item of extracted.slice(0, MAX_ITEMS_PER_SOURCE)) {
        if (newItems.length >= MAX_ITEMS_PER_RUN) break;
        if (!item.title?.trim() || !item.content?.trim()) continue;

        // تکراری‌زدایی: هش دقیق + شباهت معنایی
        let duplicate = false;
        try {
          const hash = contentHash(team, item.title, item.content);
          if (await deps.isHashDuplicate(team, hash)) {
            duplicate = true;
          } else {
            const sim = await deps.maxSimilarity(`${item.title} ${item.content.slice(0, 200)}`, team);
            if (sim !== null && sim >= DUPLICATE_SIMILARITY_THRESHOLD) duplicate = true;
          }
        } catch {
          duplicate = false; // خطای جست‌وجو یعنی «تکراری فرض نکن»
        }
        if (duplicate) continue;

        // ذخیره
        try {
          const id = await deps.saveKnowledge(team, item, source.id);
          savedIds.push(id);
          newItems.push(item);
          foundNewForSource = true;
        } catch {
          continue;
        }
      }

      await deps.markSourceChecked(source.id, true);
      await sleep(300); // ادب شبکه بین منابع
    }

    const refreshed = newItems.length > 0;
    const summary = refreshed
      ? `ساب‌ایجنت دانش تیم ${faName}: ${toFa(newItems.length)} نکته تازه از ${toFa(sourcesChecked.length)} منبع ثبت شد.`
      : `ساب‌ایجنت دانش تیم ${faName}: ${toFa(sourcesChecked.length)} منبع بررسی شد؛ نکته تازه‌ای یافت نشد.`;

    await deps.logHistory(team, refreshed ? 'external-refresh' : 'external-refresh-skipped', summary, savedIds);

    const contextSnippet = refreshed
      ? `یافته‌های تازه دانش این چرخه:\n${newItems.slice(0, 3).map((it, i) => `${toFa(i + 1)}. ${it.title}`).join('\n')}`
      : null;

    return {
      refreshed,
      sourcesChecked,
      newItems,
      skippedReason: refreshed ? null : 'نکته تازه و غیرتکراری یافت نشد',
      summary,
      llmCalls,
      contextSnippet,
    };
  } catch {
    // آخرین تور امنیت: هیچ‌وقت نباید تیم را متوقف کنیم
    return fail(
      `ساب‌ایجنت دانش تیم ${faName}: خطای غیرمنتظره؛ با دانش قبلی ادامه می‌دهیم.`,
      'خطای غیرمنتظره در ساب‌ایجنت دانش',
    );
  }
}

/**
 * ثبت نظر نهایی منتقد (دور ۳ حلقه نقد) در دانش تیم، به نام ساب‌ایجنت دانش.
 *
 * حلقه نقد سه‌مرحله‌ای: دور ۱ و ۲ (رد ← دستور دقیق ← اجرای تیم) و
 * دور ۳ (فقط نظارت، بدون رد). این تابع بعد از نظر نهایی منتقد صدا زده
 * می‌شود و تاریخچه کامل دورها + نظر نهایی را در team_knowledge با منبع
 * 'knowledge-subagent' ثبت و در RAG ایندکس می‌کند تا چرخه‌های بعد
 * پیش از شروع، از طریق buildKnowledgePromptSection آن را بخوانند.
 *
 * fail-soft: هرگز throw نمی‌کند.
 */
export async function storeCriticFinalVerdict(
  team: TeamName,
  runId: string,
  rounds: CriticRoundRecord[],
  finalNote: string,
  domain?: string,
): Promise<CriticKnowledgeResult> {
  try {
    return await recordCriticFinalVerdict(team, runId, rounds, finalNote, { domain });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
