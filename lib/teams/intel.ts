/**
 * lib/teams/intel.ts | تیم intel: اخبار تایلند؛ جمع‌آوری
 *
 * اقتباس TypeScript از بخش intel ورک‌فلو n8n «thailandgard-all-teams»:
 * حلقه نقد ۳ دوره‌ای (lib/critic-loop.ts):
 *   دور ۱: سرپرست ← سه مجری موازی (منابع خبری، ثبت ضدتکراری، دایجست و کاندیدای بلاگ)
 *   دور ۲: رد ← دستور دقیق منتقد ← سه مجری اصلاح می‌کنند
 *   دور ۳: فقط نظارت و نظر نهایی (حق رد ندارد)
 * در صورت تأیید: ثبت حافظه و تحویل خروجی، وگرنه بسته‌بندی بلوکر.
 *
 * قرارداد خروجی: TeamResult استاندارد از lib/types.ts.
 * کلید حافظه: `learned:<runId>` در جدول team_memory (از راه lib/memory).
 */

import { callLLM } from '../llm';
import { writeMemory } from '../memory';
import { fetchMarketData } from '../market';
import { buildKnowledgePromptSection } from '../rag';
import {
  extractCriticKnowledge,
  criticKnowledgeLog,
  type CriticRoundRecord,
} from '../knowledge/critic-knowledge';
import {
  runCriticLoop,
  combineReviewDirectives,
  parseCriticScore,
  CRITIC_SCORE_PROMPT_LINE,
  type CriticLoopResult,
  type CriticVerdictV2,
} from '../critic-loop';
import type { ProgressReporter, MemoryEntry, QueuedTask, TeamName, TeamResult } from '../types';

/** نام تیم در رجیستری تیم‌ها. */
export const TEAM: TeamName = 'intel';

/** مأموریت یک‌خطی تیم. */
export const MISSION =
  'چشم و گوش تایلندگرد: تازه‌ترین خبرهای تایلند را از منابع معتبر می‌گیرد، به فارسی خلاصه می‌کند، در فید خبری ذخیره می‌کند و رقبا را هر هفته رصد می‌کند.';

/** ورودی استاندارد تیم از ارکستر (سازگار با TeamInput در lib/orchestrator.ts). */
export interface TeamInput {
  /** گزارش زنده‌ی پیشرفت به ارکستر؛ ارکستر همیشه آن را می‌دهد. */
  reportProgress?: ProgressReporter;
  runId: string;
  cycleId?: string;
  /** زمینه‌ی متنی از خروجی موج‌های قبلی / چانک‌های RAG (معادل «زمینه» در n8n). */
  ragContext?: string;
  /** حافظه‌ی ذخیره‌شده‌ی تیم از چرخه‌های قبلی. */
  memory?: MemoryEntry[];
  previousWavesOutput?: Record<string, TeamResult | null>;
  /**
   * دستور مستقیم منتقد از حلقهٔ بیرونی ارکستراتور (همین چرخه)؛ بالاترین
   * اولویت را دارد و در ابتدای دستور مجری‌ها تزریق می‌شود.
   */
  reviewDirective?: string;
}

const SUPERVISOR_SYSTEM = 'تو سرپرست تیم intel تایلندگرد هستی.';
const WORKER_SYSTEM = 'تو مجری تیم intel تایلندگرد هستی.';
const CRITIC_SYSTEM = 'تو منتقد سخت‌گیر تیم intel هستی.';

const SUPERVISOR_PROMPT = (knowledgeSection: string, ragContext: string) =>
  [
    'زمینه:',
    ...(knowledgeSection ? [knowledgeSection, ''] : []),
    ragContext.trim() ? ragContext.trim() : '(زمینه‌ای در دسترس نیست)',
    '',
    'مأموریت تیم intel: چشم و گوش تایلندگرد است؛ تازه‌ترین خبرهای تایلند را از منابع معتبر می‌گیرد،',
    'به فارسی خلاصه می‌کند و در جدول intel_feed ذخیره می‌کند؛ به‌علاوه رصد هفتگی رقبا.',
    '',
    'بر اساس زمینه، تصمیم بگیر این چرخه چه کاری باید انجام شود و آن را به سه مأموریت مجزا برای سه مجری بشکن:',
    '۱. مجری منابع خبری  ۲. مجری ثبت ضدتکراری  ۳. مجری دایجست و کاندیداهای بلاگ.',
    'خروجی: فقط یک JSON معتبر با کلید workers که آرایه‌ای از سه رشتهٔ مأموریت است.',
  ].join('\n');

interface WorkerRole {
  /** نقش معادل در n8n: analyze | code | write */
  role: string;
  label: string;
  body: string;
}

const WORKER_ROLES: WorkerRole[] = [
  {
    role: 'analyze',
    label: 'منابع خبری',
    body: 'منابع رده‌یک (TAT News، Bangkok Post و...) را می‌خواند و آیتم‌های تازه را با لینک منبع معتبر جدا می‌کند. فقط واقعیت؛ بدون حدس.',
  },
  {
    role: 'code',
    label: 'ثبت ضدتکراری',
    body: 'آیتم‌ها را با کنترل ضدتکراری (source_url یکتا) آمادهٔ درج در جدول intel_feed می‌کند و خروجی را به‌صورت JSON با آرایهٔ items می‌دهد (هر آیتم: title، source_url، source، summary_fa). فقط واقعیت؛ بدون حدس.',
  },
  {
    role: 'write',
    label: 'دایجست و کاندیداهای بلاگ',
    body: 'دایجست روزانه می‌سازد و ۳ کاندیدای برتر بلاگ را با زاویهٔ مشخص (blog_angle) تحویل تیم محتوا می‌دهد. خروجی را به‌صورت JSON با کلیدهای digest و candidates بده (هر کاندیدا: title، blog_angle، source_url). فقط واقعیت؛ بدون حدس.',
  },
];

/** مأموریت‌های پیش‌فرض؛ اگر خروجی سرپرست JSON معتبر نبود از این‌ها استفاده می‌شود. */
const DEFAULT_MISSIONS: [string, string, string] = [
  'منابع رده‌یک خبری تایلند (TAT News، Bangkok Post و...) را بخوان و آیتم‌های تازهٔ مرتبط با سفر تایلند را با لینک منبع معتبر جدا کن.',
  'آیتم‌های تازه را با کنترل ضدتکراری (source_url یکتا) آمادهٔ درج در جدول intel_feed کن.',
  'دایجست روزانه بساز و ۳ کاندیدای برتر بلاگ را با زاویهٔ مشخص (blog_angle) تحویل تیم محتوا بده.',
];

/** خروجی یک دور از مجری‌های حلقه نقد: مأموریت‌ها + خروجی هر سه مجری */
interface WorkerRoundOutput {
  missions: [string, string, string];
  workerOutputs: [string, string, string];
}

/** استخراج اولین آبجکت JSON از متن (معادل نود «پارس منتقد» در n8n). */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // JSON نامعتبر؛ null برمی‌گردد
  }
  return null;
}

function parseMissions(supervisorText: string): [string, string, string] {
  const obj = extractJsonObject(supervisorText);
  const workers = obj?.workers;
  if (Array.isArray(workers)) {
    const missions = workers.filter(
      (w): w is string => typeof w === 'string' && w.trim().length > 0,
    );
    if (missions.length >= 3) return [missions[0], missions[1], missions[2]];
  }
  return DEFAULT_MISSIONS;
}

interface Verdict {
  approved: boolean;
  /** امتیاز کیفی منتقد (۰ تا ۱۰۰)؛ تعیین‌کننده نهایی: تأیید فقط با ≥ ۸۰. */
  score?: number;
  reason: string;
  payload: unknown;
}

function parseVerdict(criticText: string): Verdict {
  const obj = extractJsonObject(criticText);
  if (!obj) {
    return { approved: false, reason: 'خروجی منتقد JSON معتبر نبود.', payload: null };
  }
  const reason =
    typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : 'بدون دلیل';
  return {
    approved: obj.approved === true,
    score: parseCriticScore(obj.score) ?? undefined,
    reason,
    payload: 'payload' in obj ? obj.payload : null,
  };
}

interface BlogCandidate {
  title: string;
  angle: string;
  url: string;
}

function asBlogCandidate(v: unknown): BlogCandidate | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  if (!title) return null;
  const angle =
    typeof o.blog_angle === 'string'
      ? o.blog_angle.trim()
      : typeof o.angle === 'string'
        ? o.angle.trim()
        : '';
  const url =
    typeof o.source_url === 'string'
      ? o.source_url.trim()
      : typeof o.url === 'string'
        ? o.url.trim()
        : typeof o.link === 'string'
          ? o.link.trim()
          : '';
  return { title, angle, url };
}

function findCandidates(value: unknown): BlogCandidate[] {
  const out: BlogCandidate[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) {
        const c = asBlogCandidate(item);
        if (c) out.push(c);
      }
      return;
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const key of ['candidates', 'blog_candidates', 'top_candidates']) {
        if (Array.isArray(o[key])) visit(o[key]);
      }
    }
  };
  visit(value);
  return out;
}

/** کاندیداهای بلاگ ← وظایف صف برای تیم محتوا (معادل «صف ساخت» در n8n). */
function buildTasks(worker3Text: string, payload: unknown): QueuedTask[] {
  const fromPayload = findCandidates(payload);
  const fromWorker = fromPayload.length > 0 ? [] : findCandidates(extractJsonObject(worker3Text));
  return [...fromPayload, ...fromWorker].slice(0, 3).map((c) => ({
    title: c.title,
    description: [c.angle, c.url].filter(Boolean).join('\n'),
    files_hint: '',
    priority: 'medium' as const,
  }));
}

function countFeedItems(worker2Text: string): number | null {
  const obj = extractJsonObject(worker2Text);
  if (!obj) return null;
  for (const key of ['items', 'feed', 'feed_items']) {
    const v = obj[key];
    if (Array.isArray(v)) return v.length;
  }
  return null;
}

/**
 * تبدیل دلیل ردِ منتقد قدیمی به دستور اجرایی (CriticVerdictV2.instruction).
 * امری و بلندتر از ۵۰ نویسه تا از اعتبارسنجی حلقه رد شود.
 */
function criticInstructionFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی ایراد دارد';
  return [
    `خروجی را بر اساس این نقد اصلاح کن: «${r}»`,
    'هر سه خروجی را بازنویسی کن: به هر آیتم خبری لینک منبع معتبر اضافه کن؛',
    'خلاصه‌ها را به فارسی و غیرکپی بنویس و فقط آیتم‌های مرتبط با تور تایلند را نگه دار؛',
    'فقط واقعیت بنویس، بدون حدس.',
  ].join(' ');
}

/**
 * تبدیل دلیل رد به معیار قبولی (CriticVerdictV2.acceptance).
 */
function criticAcceptanceFromReason(reason: string): string {
  const r = reason.trim() || 'خروجی ایراد دارد';
  return `وقتی درست است که نقد «${r}» دیگر دربارهٔ خروجی صدق نکند: هر آیتم منبع معتبر دارد، خلاصه کپی متن خبر نیست و به تور تایلند ربط دارد.`;
}

/**
 * اجرای کامل تیم intel برای یک چرخه.
 * کلید حافظه به شکل `learned:<runId>` ساخته می‌شود.
 * (مهاجرت به حلقه نقد ۳ دوره‌ای lib/critic-loop.ts)
 */
export async function runTeam(input: TeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;
  const runId = input.runId;
  try {
    // گام صفر: داده‌ی بازار از منبع بیرونی (کاملاً graceful؛
    // شکست آن فقط یادداشت می‌شود و چرخه را متوقف نمی‌کند).
    await reportLive?.('دریافت داده‌ی بازار', 10);
    const market = await fetchMarketData();
    const marketContext =
      market.ok && market.data
        ? `\n\nداده‌ی تازه‌ی بازار (منبع: ${market.source === 'live' ? 'زنده' : 'کش'}):\n${market.data.slice(0, 3000)}\n\nنکته: این منابع را کاربر پیشنهاد داده است؛ اگر برای مأموریت لازم دیدی، می‌توانی فراتر از آن‌ها هم جست‌وجو کنی.`
        : '';
    const marketNote = market.ok
      ? market.source === 'off'
        ? 'منبع داده‌ی بازار خاموش است.'
        : `داده‌ی بازار از ${market.source === 'live' ? 'منبع زنده' : 'کش'} دریافت شد.`
      : `هشدار داده‌ی بازار: ${market.note ?? 'در دسترس نیست.'} چرخه بدون داده‌ی بازار ادامه یافت.`;

    // تزریق best-effort دانش تیم در ابتدای بخش زمینه (تیم ۱۳)؛
    // بدون دانش، پرامپت دقیقاً مثل قبل می‌ماند.
    let knowledgeSection = '';
    try {
      knowledgeSection = await buildKnowledgePromptSection(TEAM, MISSION);
    } catch {
      knowledgeSection = '';
    }

    // ---------- توابع حلقه نقد ----------

    // کش دور ۱: مأموریت‌های سرپرست در هر چرخه یک بار ساخته می‌شوند؛
    // دورهای ۲ و ۳ همان مأموریت‌ها را با دستور منتقد اصلاح می‌کنند.
    let cachedMissions: [string, string, string] | null = null;
    // داوری خام آخرین دور (برای تسک‌ها و خلاصه)
    let lastVerdict: Verdict | null = null;
    let lastCriticText = '';

    /**
     * runWorkers: سرپرست (دور ۱) + سه مجری موازی هر دور.
     */
    const runWorkers = async (
      round: number,
      prevInstruction?: string,
    ): Promise<WorkerRoundOutput> => {
      if (round === 1) {
        // ۱. سرپرست: شکستن کار چرخه به سه مأموریت (با زمینه‌ی RAG + داده‌ی بازار)
        await reportLive?.('سرپرست: طراحی مأموریت‌ها', 30);
        const supervisorText = await callLLM(SUPERVISOR_PROMPT(knowledgeSection, input.ragContext ?? '') + marketContext, {
          system: SUPERVISOR_SYSTEM,
          temperature: 0.2,
          maxTokens: 1200,
        });
        cachedMissions = parseMissions(supervisorText);
      } else {
        await reportLive?.(`دور ${round}: اصلاح با دستور منتقد`, 60);
      }
      const missions = cachedMissions;
      if (!missions) {
        throw new Error('مأموریت‌های سرپرست در کش پیدا نشد.');
      }

      // ۲. سه مجری به‌صورت موازی (معادل انشعاب n8n از نود سرپرست)
      // دستور مستقیم حلقهٔ بیرونی (reviewDirective) بالاترین اولویت را دارد.
      await reportLive?.('مجری‌ها: خبر، ثبت و دایجست', 65);
      const instruction = combineReviewDirectives(input.reviewDirective, prevInstruction);
      const workerOutputs = (await Promise.all(
        WORKER_ROLES.map((worker, i) =>
          callLLM(
            [
              ...(instruction
                ? ['دستور منتقد برای اصلاح این دور (حتماً رعایت کن):', instruction, '']
                : []),
              `مأموریت سرپرست:\n${missions[i]}\n\nنقش تو (${worker.label}): ${worker.body}`,
            ].join('\n'),
            {
              system: WORKER_SYSTEM,
              temperature: 0.4,
              maxTokens: 2500,
            },
          ),
        ),
      )) as [string, string, string];
      return { missions, workerOutputs };
    };

    /**
     * runCritic: منتقد فعلی، با تبدیل خروجی به CriticVerdictV2.
     * دور ۳: آخرین دور؛ حکم خام منتقد ثبت می‌شود.
     */
    const runCritic = async (
      output: WorkerRoundOutput,
      round: number,
    ): Promise<CriticVerdictV2> => {
      await reportLive?.(`منتقد: داوری خروجی (دور ${round})`, 85);
      const [sourcesText, ingestText, digestText] = output.workerOutputs;
      const criticText = await callLLM(
        [
          'خروجی مجری ۱ (منابع خبری):',
          sourcesText,
          '',
          'خروجی مجری ۲ (ثبت ضدتکراری):',
          ingestText,
          '',
          'خروجی مجری ۳ (دایجست و کاندیداهای بلاگ):',
          digestText,
          '',
          'داوری کن و فقط یک JSON معتبر بده با کلیدهای: approved (بولین)، score (عدد ۰ تا ۱۰۰)، reason (یک جمله)، payload.',
          CRITIC_SCORE_PROMPT_LINE,
          'تمرکز داوری: آیا هر آیتم منبع معتبر دارد، خلاصه کپی متن خبر نیست و به تور تایلند ربط دارد؟',
        ].join('\n'),
        { system: CRITIC_SYSTEM, temperature: 0.2, maxTokens: 1500 },
      );
      const verdict = parseVerdict(criticText);
      lastVerdict = verdict;
      lastCriticText = criticText;
      const reason = verdict.reason;
      const score = verdict.score;

      if (verdict.approved) {
        return {
          approved: true,
          score,
          reason: '',
          instruction: '',
          acceptance: '',
          finalOpinion: reason || undefined,
        };
      }
      return {
        approved: false,
        score,
        reason,
        instruction: criticInstructionFromReason(reason),
        acceptance: criticAcceptanceFromReason(reason),
      };
    };

    // تاریخچه دورها برای ثبت دانش + آخرین لاگ دانش برای خلاصه
    const roundHistory: CriticRoundRecord[] = [];
    let lastKnowledgeLog = '';

    /**
     * onRoundKnowledge: ثبت دانش هر دور با extractCriticKnowledge فعلی.
     */
    const onRoundKnowledge = async (
      round: number,
      verdict: CriticVerdictV2,
    ): Promise<void> => {
      const record: CriticRoundRecord = {
        round,
        approved: verdict.approved,
        reason: verdict.approved
          ? verdict.finalOpinion || 'تأیید شد.'
          : verdict.reason,
        instruction: verdict.instruction?.trim() || undefined,
      };
      const knowledgeResult = await extractCriticKnowledge(
        TEAM,
        {
          approved: verdict.approved,
          reason: record.reason,
          domain: 'اطلاعات بازار و رقیب',
          instruction: record.instruction,
          round,
          rounds: roundHistory.slice(),
          isFinal: round === 3,
        },
        runId,
      );
      roundHistory.push(record);
      lastKnowledgeLog = criticKnowledgeLog(knowledgeResult);
    };

    // ---------- اجرای حلقه نقد ۳ دوره‌ای ----------
    const loopResult: CriticLoopResult<WorkerRoundOutput> = await runCriticLoop<WorkerRoundOutput>({
      team: TEAM,
      runId,
      runWorkers,
      runCritic,
      onRoundKnowledge,
      onProgress: (msg) => reportLive?.(msg, 70),
    });

    const verdict = lastVerdict ?? { approved: false, reason: 'داوری ثبت نشد.', payload: null };
    const digestText = loopResult.output.workerOutputs[2];
    const ingestText = loopResult.output.workerOutputs[1];

    // رد منتقد ← بلوکر (معادل شاخهٔ دوم «تأیید شد؟» در n8n)
    if (!loopResult.approved) {
      const reason = verdict.reason || 'منتقد خروجی را تأیید نکرد.';
      return {
        team: TEAM,
        summary: `تیم intel در چرخهٔ ${runId} متوقف شد: ${reason} ${marketNote} ${lastKnowledgeLog}`,
        blockers: [`بلوکر تیم intel: ${reason}`],
        tasks: [],
        approved: false,
      };
    }

    // ثبت حافظه؛ فقط در مسیر تأیید (مثل n8n)
    await writeMemory(TEAM, `learned:${runId}`, {
      content: lastCriticText.slice(0, 2000),
      approved: true,
      run_id: runId,
      finalRound: loopResult.finalRound,
      rounds: loopResult.verdicts.map((v, i) => ({
        round: i + 1,
        approved: v.approved,
        reason: v.reason || v.finalOpinion || '',
      })),
    });

    // صف کار: کاندیداهای بلاگ برای تیم محتوا (معادل «صف ساخت» در n8n)
    const tasks = buildTasks(digestText, verdict.payload);

    const itemCount = countFeedItems(ingestText);
    const itemsClause =
      itemCount === null
        ? 'آیتم‌های تازه با منبع معتبر جدا و آمادهٔ درج شدند.'
        : `${itemCount} آیتم تازه با منبع معتبر جدا و آمادهٔ درج شد.`;
    const tasksClause =
      tasks.length === 0
        ? 'کاندیدای بلاگی استخراج نشد.'
        : `${tasks.length} کاندیدای بلاگ با زاویهٔ مشخص تحویل تیم محتوا شد.`;

    return {
      team: TEAM,
      summary: `تیم intel چرخهٔ ${runId} را با تأیید منتقد بست (${verdict.reason}). ${itemsClause} ${tasksClause} ${marketNote} (حلقه در دور ${loopResult.finalRound} تمام شد) ${lastKnowledgeLog}`,
      blockers: [],
      tasks,
      approved: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      team: TEAM,
      summary: `اجرای تیم intel در چرخهٔ ${runId} با خطا متوقف شد: ${message}`,
      blockers: [`اجرای تیم intel ناموفق بود: ${message}`],
      tasks: [],
      approved: false,
    };
  }
}
