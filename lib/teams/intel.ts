/**
 * lib/teams/intel.ts | تیم intel: اخبار تایلند؛ جمع‌آوری
 *
 * اقتباس TypeScript از بخش intel ورک‌فلو n8n «thailandgard-all-teams»:
 * سرپرست ← سه مجری موازی (منابع خبری، ثبت ضدتکراری، دایجست و کاندیدای بلاگ)
 * ← منتقد ← در صورت تأیید: ثبت حافظه و تحویل خروجی، وگرنه بسته‌بندی بلوکر.
 *
 * قرارداد خروجی: TeamResult استاندارد از lib/types.ts.
 * کلید حافظه: `learned:<runId>` در جدول team_memory (از راه lib/memory).
 */

import { callLLM } from '../llm';
import { writeMemory } from '../memory';
import type { MemoryEntry, QueuedTask, TeamName, TeamResult } from '../types';

/** نام تیم در رجیستری تیم‌ها. */
export const TEAM: TeamName = 'intel';

/** مأموریت یک‌خطی تیم. */
export const MISSION =
  'چشم و گوش تایلندگرد: تازه‌ترین خبرهای تایلند را از منابع معتبر می‌گیرد، به فارسی خلاصه می‌کند، در فید خبری ذخیره می‌کند و رقبا را هر هفته رصد می‌کند.';

/** ورودی استاندارد تیم از ارکستر (سازگار با TeamInput در lib/orchestrator.ts). */
export interface TeamInput {
  runId: string;
  cycleId?: string;
  /** زمینه‌ی متنی از خروجی موج‌های قبلی / چانک‌های RAG (معادل «زمینه» در n8n). */
  ragContext?: string;
  /** حافظه‌ی ذخیره‌شده‌ی تیم از چرخه‌های قبلی. */
  memory?: MemoryEntry[];
  previousWavesOutput?: Record<string, TeamResult | null>;
}

const SUPERVISOR_SYSTEM = 'تو سرپرست تیم intel تایلندگرد هستی.';
const WORKER_SYSTEM = 'تو مجری تیم intel تایلندگرد هستی.';
const CRITIC_SYSTEM = 'تو منتقد سخت‌گیر تیم intel هستی.';

const SUPERVISOR_PROMPT = (ragContext: string) =>
  [
    'زمینه:',
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
 * اجرای کامل تیم intel برای یک چرخه.
 * کلید حافظه به شکل `learned:<runId>` ساخته می‌شود.
 */
export async function runTeam(input: TeamInput): Promise<TeamResult> {
  const runId = input.runId;
  try {
    // ۱. سرپرست: شکستن کار چرخه به سه مأموریت (با زمینه‌ی RAG)
    const supervisorText = await callLLM(SUPERVISOR_PROMPT(input.ragContext ?? ''), {
      system: SUPERVISOR_SYSTEM,
      temperature: 0.2,
      maxTokens: 1200,
    });
    const missions = parseMissions(supervisorText);

    // ۲. سه مجری به‌صورت موازی (معادل انشعاب n8n از نود سرپرست)
    const workerOutputs = await Promise.all(
      WORKER_ROLES.map((worker, i) =>
        callLLM(`مأموریت سرپرست:\n${missions[i]}\n\nنقش تو (${worker.label}): ${worker.body}`, {
          system: WORKER_SYSTEM,
          temperature: 0.4,
          maxTokens: 2500,
        }),
      ),
    );
    const [sourcesText, ingestText, digestText] = workerOutputs;

    // ۳. منتقد
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
        'داوری کن و فقط یک JSON معتبر بده با کلیدهای: approved (بولین)، reason (یک جمله)، payload.',
        'تمرکز داوری: آیا هر آیتم منبع معتبر دارد، خلاصه کپی متن خبر نیست و به تور تایلند ربط دارد؟',
      ].join('\n'),
      { system: CRITIC_SYSTEM, temperature: 0.2, maxTokens: 1500 },
    );
    const verdict = parseVerdict(criticText);

    // ۴. رد منتقد ← بلوکر (معادل شاخهٔ دوم «تأیید شد؟» در n8n)
    if (!verdict.approved) {
      const reason = verdict.reason || 'منتقد خروجی را تأیید نکرد.';
      return {
        team: TEAM,
        summary: `تیم intel در چرخهٔ ${runId} متوقف شد: ${reason}`,
        blockers: [`بلوکر تیم intel: ${reason}`],
        tasks: [],
        approved: false,
      };
    }

    // ۵. ثبت حافظه؛ فقط در مسیر تأیید (مثل n8n)
    await writeMemory(TEAM, `learned:${runId}`, {
      content: criticText.slice(0, 2000),
      approved: true,
      run_id: runId,
    });

    // ۶. صف کار: کاندیداهای بلاگ برای تیم محتوا (معادل «صف ساخت» در n8n)
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
      summary: `تیم intel چرخهٔ ${runId} را با تأیید منتقد بست (${verdict.reason}). ${itemsClause} ${tasksClause}`,
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
