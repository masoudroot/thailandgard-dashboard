/**
 * lib/teams/vibefarsi.ts: تیم وایب‌فارسی (ممیز رجیستری وایب‌فارسی)
 *
 * وابستگی: خروجی تیم design از موج‌های قبلی (previousWavesOutput['design']).
 * جریان اجرا، همان خط n8n است: سرپرست ← ۳ مجری ← منتقد ← ثبت حافظه.
 * همه فراخوانی‌های مدل از callLLM می‌گذرد؛ حافظه با کلید learned:<runId>.
 */

import { callLLM, callLLMJson } from '../llm';
import { writeMemory } from '../memory';
import { buildKnowledgePromptSection } from '../rag';
import { extractCriticKnowledge, criticKnowledgeLog } from '../knowledge/critic-knowledge';
import type { ProgressReporter, QueuedTask, TeamName, TeamResult } from '../types';

export const TEAM: TeamName = 'vibefarsi';

/** مأموریت تیم در یک خط */
export const MISSION: string =
  'ممیز انطباق با رجیستری وایب‌فارسی؛ هر چیزی که روی سایت می‌نشیند باید نزدیک‌ترین آیتم رجیستری را داشته باشد؛ تأیید می‌کند، انحراف آگاهانه را ثبت می‌کند یا دستور اصلاح می‌دهد.';

/** ورودی اجرای تیم */
export interface RunTeamInput {
  /** گزارش زنده‌ی پیشرفت به ارکستر؛ ارکستر همیشه آن را می‌دهد. */
  reportProgress?: ProgressReporter;
  /** شناسه اجرای جاری (برای کلید حافظه) */
  runId: string;
  /** خروجی موج‌های قبلی؛ تیم design منبع اصلی ممیزی است */
  previousWavesOutput: Record<string, string | null | undefined>;
}

interface SupervisorPlan {
  workers: string[];
}

interface CriticVerdict {
  approved: boolean;
  reason: string;
  payload: unknown;
}

const SYSTEM_SUPERVISOR = 'تو سرپرست تیم vibefarsi تایلندگرد هستی.';
const SYSTEM_WORKER = 'تو مجری تیم vibefarsi تایلندگرد هستی.';
const SYSTEM_CRITIC = 'تو منتقد سخت‌گیر تیم vibefarsi هستی.';

function supervisorPrompt(designOutput: string | null, knowledgeSection = ''): string {
  const context = designOutput ?? '(خروجی تیم design در این چرخه ثبت نشده است)';
  return [
    'زمینه (خروجی تیم design از موج‌های قبلی):',
    ...(knowledgeSection ? [knowledgeSection, ''] : []),
    context,
    '',
    'مأموریت تیم vibefarsi:',
    MISSION,
    '',
    'بر اساس زمینه، تصمیم بگیر این چرخه چه کاری باید انجام شود و آن را به سه مأموریت مجزا برای سه مجری بشکن:',
    'مجری ۱ (تحلیل): خروجی یا دیف design را با چک‌لیست ممیزی می‌خواند.',
    'مجری ۲ (ثبت فنی): انحراف‌های آگاهانه را با دلیل فنی ثبت می‌کند.',
    'مجری ۳ (نگارش): فهرست ممیزی هر نوبت را با ارجاع دقیق به slug می‌نویسد.',
    'فقط JSON معتبر بده با کلید workers که آرایه‌ای از دقیقاً سه رشته (مأموریت هر مجری) است.',
  ].join('\n');
}

function worker1Prompt(mission: string): string {
  return [
    'مأموریت سرپرست:',
    mission,
    '',
    'نقش تو: خروجی یا دیف تیم design را با چک‌لیست ممیزی وایب‌فارسی بخوان: نزدیک‌ترین slug رجیستری برای هر المان، توکن‌محوری (رنگ، فاصله و تایپوگرافی همه از توکن‌ها)، ممنوعیت استایل من‌درآوردی.',
    'فقط واقعیت بنویس؛ بدون حدس. برای هر یافته بگو: کدام المان، چه انحرافی، نزدیک‌ترین slug کدام است.',
  ].join('\n');
}

function worker2Prompt(mission: string): string {
  return [
    'مأموریت سرپرست:',
    mission,
    '',
    'نقش تو: انحراف‌های آگاهانه را با دلیل فنی ثبت کن.',
    'خروجی: بلوک‌های آماده برای DEVIATIONS.md؛ هر مورد شامل slug آیتم، شرح انحراف، و دلیل فنی که چرا کپی بایت‌به‌بایت ممکن یا درست نبوده است.',
    'فقط واقعیت؛ بدون حدس.',
  ].join('\n');
}

function worker3Prompt(mission: string): string {
  return [
    'مأموریت سرپرست:',
    mission,
    '',
    'نقش تو: فهرست ممیزی این نوبت را با ارجاع دقیق به slug بنویس و یافته‌های تازه را برای KNOWLEDGE.md ثبت کن.',
    'هر قلم فهرست: وضعیت (تأیید / انحراف ثبت‌شده / نیازمند اصلاح)، المان، slug مرجع.',
    'فقط واقعیت؛ بدون حدس.',
  ].join('\n');
}

function criticPrompt(text1: string, text2: string, text3: string): string {
  return [
    'خروجی مجری ۱:',
    text1,
    '',
    'خروجی مجری ۲:',
    text2,
    '',
    'خروجی مجری ۳:',
    text3,
    '',
    'داوری کن و فقط JSON معتبر بده با کلیدهای: approved (بولین)، reason (یک جمله)، payload.',
    'تمرکز داوری: آیا کپی آیتم بایت‌به‌بایت است، همه‌چیز از توکن می‌آید و هیچ تصمیمی بدون slug نیست؟',
  ].join('\n');
}

/**
 * اجرای کامل تیم vibefarsi در یک چرخه.
 * سرپرست مأموریت‌ها را می‌شکند، سه مجری موازی کار می‌کنند،
 * منتقد داوری می‌کند و یادگیری چرخه در حافظه ثبت می‌شود.
 */
export async function runTeam(input: RunTeamInput): Promise<TeamResult> {
  const reportLive = input.reportProgress;
  const { runId, previousWavesOutput } = input;
  const designOutput = previousWavesOutput['design'] ?? null;
  const blockers: string[] = [];
  const tasks: QueuedTask[] = [];

  if (!designOutput) {
    blockers.push('خروجی تیم design در موج‌های قبلی ثبت نشده؛ ممیزی روی زمینه تهی انجام شد.');
  }

  // تزریق best-effort دانش تیم در ابتدای بخش زمینه (تیم ۱۳)؛
  // بدون دانش، پرامپت دقیقاً مثل قبل می‌ماند.
  let knowledgeSection = '';
  try {
    knowledgeSection = await buildKnowledgePromptSection(TEAM, MISSION);
  } catch {
    knowledgeSection = '';
  }

  // قدم ۱: سرپرست، سه مأموریت مجری‌ها را مشخص می‌کند
  await reportLive?.('سرپرست: طراحی مأموریت‌ها', 20);
  const plan = await callLLMJson<SupervisorPlan>(supervisorPrompt(designOutput, knowledgeSection), {
    system: SYSTEM_SUPERVISOR,
  });
  const missions = Array.isArray(plan.workers) ? plan.workers.slice(0, 3) : [];
  while (missions.length < 3) missions.push('مأموریت پیش‌فرض: خروجی design را با چک‌لیست وایب‌فارسی ممیزی کن.');

  // قدم ۲: سه مجری به‌صورت موازی
  const [text1, text2, text3] = await Promise.all([
    callLLM(worker1Prompt(missions[0]), { system: SYSTEM_WORKER, temperature: 0.3 }),
    callLLM(worker2Prompt(missions[1]), { system: SYSTEM_WORKER, temperature: 0.3 }),
    callLLM(worker3Prompt(missions[2]), { system: SYSTEM_WORKER, temperature: 0.3 }),
  ]);

  // قدم ۳: منتقد
  await reportLive?.('منتقد: داوری خروجی', 70);
  const verdict = await callLLMJson<CriticVerdict>(criticPrompt(text1, text2, text3), {
    system: SYSTEM_CRITIC,
    temperature: 0.2,
  });

  // قدم ۴: اگر تأیید نشد، کار اصلاح در صف می‌نشیند
  if (!verdict.approved) {
    tasks.push({
      title: 'اصلاح انحراف‌های رجیستری وایب‌فارسی',
      description: `منتقد تأیید نکرد: ${verdict.reason}`,
      files_hint: 'site/ (کامپوننت‌ها و استایل‌های خارج از رجیستری)',
      priority: 'high',
    });
  }

  // قدم ۵: ثبت یادگیری چرخه در حافظه
  const learned = [
    `نتیجه ممیزی: ${verdict.approved ? 'تأیید شد' : 'تأیید نشد'}`,
    `دلیل منتقد: ${verdict.reason}`,
    designOutput ? 'ممیزی روی خروجی واقعی تیم design انجام شد.' : 'خروجی design در دسترس نبود.',
  ].join('\n');
  await writeMemory(TEAM, `learned:${runId}`, learned);

  // استخراج دانش از حکم منتقد (نقد←دانش)
  const knowledgeResult = await extractCriticKnowledge(
    TEAM,
    { approved: verdict.approved, reason: verdict.reason, domain: 'استاندارد وایب‌فارسی' },
    runId,
  );
  const knowledgeLog = criticKnowledgeLog(knowledgeResult);

  const summary = verdict.approved
    ? `ممیزی وایب‌فارسی پاس شد: ${verdict.reason} ${knowledgeLog}`
    : `ممیزی وایب‌فارسی رد شد و کار اصلاح در صف نشست: ${verdict.reason} ${knowledgeLog}`;

  return {
    team: TEAM,
    summary,
    blockers,
    tasks,
    approved: verdict.approved,
  };
}
