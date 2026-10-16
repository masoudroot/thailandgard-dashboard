/**
 * lib/planner/planner.ts — هستهٔ تولید بک‌لاگ هفتگی.
 *
 * ورودی:
 *   ۱. ۱۰ قانون طلایی هر تیم (جدول team_golden_rules)
 *   ۲. سیگنال‌های دادهٔ تازهٔ تیم (جدول team_knowledge: درس‌های منتقد و دانش fresh)
 * خروجی: برای هر تیم تا ۱۰ تسک با title/description/acceptance/estimate/
 * dedupe_key/week_key و source='planner-weekly' که با وضعیت pending در
 * build_queue ثبت می‌شوند تا مسعود تأیید کند (خودکار اجرا نمی‌شوند).
 *
 * قرارداد با ارکستراتور فقط از طریق build_queue است؛ planner هیچ قفلی نمی‌گیرد.
 * کاملاً idempotent است: تسکی که dedupe_key یکسان در همان week_key داشته
 * باشد دوباره نوشته نمی‌شود (هم پیش‌چک، هم قید یکتای DB).
 */

import { getSupabase } from '../api';
import { getGoldenRules, type GoldenRule } from '../knowledge/golden-rules';
import { teamFaName } from '../teams-meta';
import type { TeamName } from '../types';
import {
  PLANNER_SOURCE,
  PLANNER_TASKS_PER_TEAM,
  type PlannerRunOptions,
  type PlannerRunResult,
  type PlannerTask,
  type PlannerTeamResult,
  type PlannerTeamRole,
} from './types';
import { resolveRoster, type RosterEntry } from './teams';

/* ------------------------------------------------------------------ */
/* کلید هفته (ISO 8601): 2026-W42                                      */
/* ------------------------------------------------------------------ */

/** کلید هفتهٔ ISO برای یک تاریخ؛ مثل «2026-W42». */
export function weekKeyFor(date: Date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // ISO 8601: جابه‌جایی به پنجشنبهٔ همان هفته، بعد شمارش از اول ژانویه
  const dayNum = d.getUTCDay() || 7; // دوشنبه=۱ تا یکشنبه=۷
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* ورودی ۲: سیگنال‌های دادهٔ تازهٔ تیم                                   */
/* ------------------------------------------------------------------ */

interface DataSignal {
  id: string;
  title: string;
  origin: string;
}

/**
 * تازه‌ترین دانش‌های fresh تیم (درس‌های منتقد و دانش منابع).
 * اگر جدول/ستون در دسترس نبود، خالی برمی‌گرداند تا planner نشکند.
 */
async function loadSignals(team: string, limit: number): Promise<DataSignal[]> {
  try {
    const { data, error } = await getSupabase()
      .from('team_knowledge')
      .select('id, title, origin')
      .eq('team', team)
      .eq('freshness_status', 'fresh')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return (data as Array<{ id: string; title: string; origin: string | null }>).map((r) => ({
      id: r.id,
      title: r.title,
      origin: r.origin ?? 'unknown',
    }));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* ساخت تسک از قانون طلایی / سیگنال / بهداشت هفتگی                      */
/* ------------------------------------------------------------------ */

function estimateFromImpact(impact: number): 1 | 2 | 3 {
  if (impact >= 80) return 3;
  if (impact >= 60) return 2;
  return 1;
}

function priorityFromImpact(impact: number): PlannerTask['priority'] {
  if (impact >= 80) return 'high';
  if (impact >= 50) return 'medium';
  return 'low';
}

/** هر قانون طلایی → یک تسک «اعمال قانون در خروجی‌های این هفته». */
function taskFromRule(team: string, rule: GoldenRule): PlannerTask {
  const impact = rule.impact_score ?? 50;
  const ruleText = rule.rule.trim();
  const why = rule.why?.trim();
  return {
    team,
    title: `اعمال قانون طلایی در خروجی‌های هفته: ${ruleText}`.slice(0, 200),
    description: [
      `قانون طلایی تیم (امتیاز تأثیر ${impact}، منشأ: ${rule.source}):`,
      `«${ruleText}»`,
      why ? `چرا مهم است: ${why}` : '',
      '',
      'اقدام: این قانون را روی خروجی‌های این هفتهٔ تیم اعمال کن؛',
      'در گزارش بنویس کدام ۲ قانون را اعمال کردی و اثرش چه بود.',
    ]
      .filter((l) => l !== '')
      .join('\n'),
    acceptance:
      'در گزارش هفته، نمونهٔ مشخصی از اعمال این قانون روی حداقل یک خروجی ثبت شده ' +
      'و منتقد آن را رد نکرده است.',
    estimate: estimateFromImpact(impact),
    dedupeKey: `rule:${rule.id}`,
    priority: priorityFromImpact(impact),
  };
}

/** هر سیگنال دادهٔ تازه → یک تسک «پیگیری یافته در برنامهٔ هفته». */
function taskFromSignal(team: string, signal: DataSignal): PlannerTask {
  return {
    team,
    title: `پیگیری یافتهٔ تازه در برنامهٔ هفته: ${signal.title}`.slice(0, 200),
    description: [
      `یافتهٔ تازه از دانش تیم (منشأ: ${signal.origin}):`,
      `«${signal.title.trim()}»`,
      '',
      'اقدام: این یافته را به یک اقدام مشخص این هفته تبدیل کن؛',
      'اگر درس منتقد است، جلوی تکرار همان خطا را بگیر.',
    ].join('\n'),
    acceptance:
      'نتیجهٔ پیگیری (اقدام انجام‌شده یا تصمیم مستدل برای نادیده گرفتن) در دانش تیم ثبت شده است.',
    estimate: 2,
    dedupeKey: `signal:${signal.id}`,
    priority: 'medium',
  };
}

interface HygieneTemplate {
  title: (faName: string) => string;
  description: (faName: string) => string;
  acceptance: string;
  estimate: 1 | 2 | 3;
}

/** تسک‌های بهداشت هفتگی سازنده‌ها؛ فقط وقتی قانون/سیگنال کافی نبود. */
const BUILDER_HYGIENE: HygieneTemplate[] = [
  {
    title: (f) => `بازبینی ۳ خروجی شاخص چرخهٔ قبل «${f}» و ثبت ۱ درس تازه`,
    description: (f) =>
      `۳ خروجی مهم هفتهٔ گذشتهٔ تیم «${f}» را مرور کن؛ قوی‌ترین الگو و بزرگ‌ترین خطا را پیدا کن و ۱ درس تازه در دانش تیم ثبت کن.`,
    acceptance: '۱ درس تازه با منشأ مشخص در team_knowledge ثبت شده است.',
    estimate: 1,
  },
  {
    title: (f) => `سنجش یک معیار کلیدی «${f}» و ثبت عدد قبل/بعد`,
    description: (f) =>
      `یک معیار کلیدی مرتبط با «${f}» (مثل سرعت صفحه، خوانایی، یا رتبه) را روی یک نمونهٔ واقعی بسنج و عدد قبل و بعد را ثبت کن.`,
    acceptance: 'عدد معیار با تاریخ و نمونهٔ مشخص ثبت شده است.',
    estimate: 2,
  },
  {
    title: (f) => `به‌روزرسانی ۱ قانون طلایی «${f}» بر اساس خطاهای هفته`,
    description: (f) =>
      `خطاهای ثبت‌شدهٔ هفتهٔ گذشته را مرور کن؛ اگر قانونی نیاز به اصلاح/تقویت دارد، پیشنهادش را با دلیل ثبت کن.`,
    acceptance: 'پیشنهاد اصلاح قانون با دلیل در دانش تیم ثبت شده است.',
    estimate: 1,
  },
  {
    title: (f) => `هم‌راستایی «${f}» با یک تیم سازندهٔ دیگر: ثبت ۱ تصمیم مشترک`,
    description: (f) =>
      `با یک تیم سازندهٔ دیگر دربارهٔ نقطهٔ اتصال کاری‌تان گفت‌وگو کن و ۱ تصمیم مشترک مکتوب ثبت کن.`,
    acceptance: '۱ تصمیم مشترک با نام دو تیم ثبت شده است.',
    estimate: 1,
  },
  {
    title: (f) => `پاک‌سازی بک‌لاگ «${f}»: بستن یا defer تسک‌های قدیمی‌تر از ۳۰ روز`,
    description: (f) =>
      `تسک‌های pending قدیمی‌تر از ۳۰ روز تیم «${f}» را مرور کن؛ هر کدام را یا ببند، یا به deferred ببر، یا دلیل نگه‌داشتنش را بنویس.`,
    acceptance: 'هیچ تسک pending قدیمی‌تر از ۳۰ روز بدون تصمیم ثبت‌شده نمانده است.',
    estimate: 1,
  },
  {
    title: (f) => `نمونه‌برداری از ۵ خروجی تازه «${f}» با چک‌لیست کیفیت داخلی`,
    description: (f) =>
      `۵ خروجی تازهٔ «${f}» را با چک‌لیست کیفیت تیم بسنج و نتیجه را در قالب ۱ جدول کوتاه ثبت کن.`,
    acceptance: 'جدول نتیجهٔ ۵ نمونه با وضعیت قبول/رد ثبت شده است.',
    estimate: 2,
  },
  {
    title: (f) => `مستندسازی ۱ الگوی موفق «${f}» برای چرخه‌های بعد`,
    description: (f) =>
      `۱ کاری که این هفته خوب جواب داد را به‌صورت الگوی قابل تکرار (قدم‌به‌قدم) در دانش تیم بنویس.`,
    acceptance: '۱ الگوی قدم‌به‌قدم در دانش تیم ثبت شده است.',
    estimate: 1,
  },
  {
    title: (f) => `بررسی ۱ نمونهٔ خارجی مرتبط با «${f}» و ثبت ۲ نکته`,
    description: (f) =>
      `۱ نمونه/رقیب خارجی مرتبط با حوزهٔ «${f}» را بررسی کن و ۲ نکتهٔ قابل استفاده ثبت کن.`,
    acceptance: '۲ نکته با منبع مشخص در دانش تیم ثبت شده است.',
    estimate: 1,
  },
  {
    title: (f) => `آماده‌سازی ورودی چرخهٔ بعد «${f}»: فهرست ۳ اولویت پیشنهادی`,
    description: (f) => `برای چرخهٔ بعد، ۳ اولویت پیشنهادی «${f}» را با ۱ خط دلیل برای هر کدام بنویس.`,
    acceptance: 'فهرست ۳ اولویت با دلیل ثبت شده است.',
    estimate: 1,
  },
  {
    title: (f) => `بازبینی files_hint تسک‌های «${f}»: اصلاح موارد قدیمی`,
    description: (f) =>
      `تسک‌های باز «${f}» را از نظر files_hint بررسی کن؛ موارد قدیمی یا اشتباه را اصلاح کن.`,
    acceptance: 'files_hint همهٔ تسک‌های باز، معتبر و به‌روز است.',
    estimate: 1,
  },
];

/** تسک‌های بهداشت هفتگی بازبین‌ها؛ فقط وقتی قانون/سیگنال کافی نبود. */
const REVIEWER_HYGIENE: HygieneTemplate[] = [
  {
    title: (f) => `بازبینی نمونه‌ای ۳ خروجی سازنده‌ها و ثبت ۲ یافتهٔ «${f}»`,
    description: (f) =>
      `۳ خروجی تازهٔ تیم‌های سازنده را با نگاه «${f}» بازبینی کن و ۲ یافتهٔ مستند (نقطهٔ قوت یا ایراد) ثبت کن.`,
    acceptance: '۲ یافته با نمونهٔ مشخص ثبت شده است.',
    estimate: 2,
  },
  {
    title: (f) => `اعتبارسنجی ۵ تسک pending از نظر معیار قبولی «${f}»`,
    description: (f) =>
      `۵ تسک pending مرتبط با «${f}» را از نظر شفاف بودن acceptance بررسی کن؛ موارد مبهم را برای اصلاح برگردان.`,
    acceptance: 'وضعیت هر ۵ تسک (تأیید/برگشت با دلیل) ثبت شده است.',
    estimate: 1,
  },
  {
    title: (f) => `گزارش سلامت هفتگی «${f}»: ۱ صفحه خلاصه برای مسعود`,
    description: (f) =>
      `۱ صفحه خلاصه از وضعیت هفته از نگاه «${f}» بنویس: چه خوب پیش رفت، چه گیر کرد، چه تصمیمی لازم است.`,
    acceptance: 'گزارش ۱ صفحه‌ای با ۳ بخش (خوب/گیرکرده/تصمیم لازم) آماده است.',
    estimate: 2,
  },
  {
    title: (f) => `بازبینی قوانین طلایی و پیشنهاد ۱ قانون تازه از خطاهای هفته «${f}»`,
    description: (f) =>
      `خطاهای هفته را از نگاه «${f}» مرور کن و اگر الگوی تکرارشونده‌ای هست، ۱ قانون طلایی تازه پیشنهاد بده.`,
    acceptance: 'پیشنهاد قانون با الگوی خطای مستند ثبت شده است.',
    estimate: 1,
  },
  {
    title: (f) => `بررسی تسک‌های deferred بیش از ۲ هفته و تصمیم‌گیری «${f}»`,
    description: (f) =>
      `تسک‌های deferred قدیمی‌تر از ۲ هفته را مرور کن؛ هر کدام: انجام، حذف با دلیل، یا تمدید defer با تاریخ.`,
    acceptance: 'هیچ تسک deferred قدیمی بدون تصمیم ثبت‌شده نمانده است.',
    estimate: 1,
  },
  {
    title: (f) => `نمونه‌برداری از خروجی‌های ردشده و استخراج الگوی خطای مشترک «${f}»`,
    description: (f) =>
      `خروجی‌های ردشدهٔ هفته را مرور کن و اگر الگوی مشترکی هست، ۱ جملهٔ دقیق از آن بنویس و به تیم مربوطه بده.`,
    acceptance: 'الگوی خطا (یا «الگویی نبود») با نمونه ثبت شده است.',
    estimate: 2,
  },
  {
    title: (f) => `هم‌راستایی با منتقد: مرور ۳ درس منتقد و ثبت وضعیت اعمال «${f}»`,
    description: (f) =>
      `۳ درس تازهٔ منتقد را بخوان و برای هر کدام بنویس: اعمال شده، در حال اعمال، یا چرا اعمال نشده.`,
    acceptance: 'وضعیت اعمال هر ۳ درس ثبت شده است.',
    estimate: 1,
  },
  {
    title: (f) => `سنجش زمان چرخه: میانگین pending تا done در هفتهٔ گذشته «${f}»`,
    description: (f) =>
      `برای تسک‌های بسته‌شدهٔ هفتهٔ گذشته، میانگین زمان از pending تا done را حساب و با هفتهٔ قبل مقایسه کن.`,
    acceptance: 'عدد میانگین با مقایسهٔ هفتهٔ قبل ثبت شده است.',
    estimate: 1,
  },
  {
    title: (f) => `بازبینی ۱ مسیر بحرانی کاربر و ثبت یافته‌های کیفی «${f}»`,
    description: (f) =>
      `۱ مسیر بحرانی کاربر (مثل انتخاب تور تا تماس) را از نگاه «${f}» طی کن و یافته‌ها را ثبت کن.`,
    acceptance: 'یافته‌ها با قدم‌های مسیر ثبت شده‌اند.',
    estimate: 2,
  },
  {
    title: (f) => `آرشیو گزارش‌های قدیمی‌تر از ۹۰ روز در فضای کاری «${f}»`,
    description: (f) =>
      `گزارش‌ها و خروجی‌های قدیمی‌تر از ۹۰ روز «${f}» را آرشیو کن تا فضای کاری تمیز بماند.`,
    acceptance: 'فهرست آرشیوشده‌ها ثبت شده است.',
    estimate: 1,
  },
];

function taskFromHygiene(team: string, faName: string, tpl: HygieneTemplate, idx: number): PlannerTask {
  return {
    team,
    title: tpl.title(faName).slice(0, 200),
    description: `${tpl.description(faName)}\n\n(تسک بهداشت هفتگی خودکار؛ اگر اولویت بهتری هست، ردش کن.)`,
    acceptance: tpl.acceptance,
    estimate: tpl.estimate,
    dedupeKey: `hygiene:${team}:${idx}`,
    priority: 'low',
  };
}

/**
 * ساخت بک‌لاگ یک تیم: اول قوانین طلایی، بعد سیگنال‌های داده،
 * و در آخر بهداشت هفتگی تا سقف PLANNER_TASKS_PER_TEAM.
 */
export function buildBacklog(
  team: string,
  role: PlannerTeamRole,
  rules: GoldenRule[],
  signals: DataSignal[],
  faName?: string,
): PlannerTask[] {
  const name = faName ?? team;
  const tasks: PlannerTask[] = [];
  for (const rule of rules.slice(0, PLANNER_TASKS_PER_TEAM)) {
    tasks.push(taskFromRule(team, rule));
  }
  const hygiene = role === 'builder' ? BUILDER_HYGIENE : REVIEWER_HYGIENE;
  let hIdx = 0;
  for (const signal of signals) {
    if (tasks.length >= PLANNER_TASKS_PER_TEAM) break;
    tasks.push(taskFromSignal(team, signal));
  }
  while (tasks.length < PLANNER_TASKS_PER_TEAM && hIdx < hygiene.length) {
    const tpl = hygiene[hIdx];
    if (tpl) tasks.push(taskFromHygiene(team, name, tpl, hIdx));
    hIdx += 1;
  }
  return tasks;
}

/* ------------------------------------------------------------------ */
/* ثبت در build_queue (dedupe + pending)                               */
/* ------------------------------------------------------------------ */

/** dedupe_keyهای موجود این هفته؛ برای پیش‌چک تکراری‌ها. */
async function existingDedupeKeys(weekKey: string): Promise<Set<string>> {
  const { data, error } = await getSupabase()
    .from('build_queue')
    .select('dedupe_key')
    .eq('week_key', weekKey)
    .not('dedupe_key', 'is', null);
  if (error) throw new Error(`planner dedupe read failed: ${error.message}`);
  return new Set((data ?? []).map((r) => (r as { dedupe_key: string }).dedupe_key));
}

interface QueueInsertRow {
  team: string;
  run_id: null;
  title: string;
  description: string;
  files_hint: string[];
  priority: PlannerTask['priority'];
  status: 'pending';
  source: string;
  week_key: string;
  acceptance: string;
  estimate: number;
  depends_on: null;
  dedupe_key: string;
}

function toRow(t: PlannerTask, weekKey: string): QueueInsertRow {
  return {
    team: t.team,
    run_id: null,
    title: t.title,
    description: t.description,
    files_hint: [],
    priority: t.priority,
    status: 'pending',
    source: PLANNER_SOURCE,
    week_key: weekKey,
    acceptance: t.acceptance,
    estimate: t.estimate,
    depends_on: null,
    dedupe_key: t.dedupeKey,
  };
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === '23505';
}

/**
 * ثبت تسک‌ها با وضعیت pending. در صورت برخورد به قید یکتا (مسابقهٔ دو اجرا)،
 * تک‌تک ثبت می‌کند و تکراری‌ها را رد می‌کند؛ پس اجرای دوباره امن است.
 */
async function insertPending(tasks: PlannerTask[], weekKey: string): Promise<string[]> {
  if (tasks.length === 0) return [];
  const sb = getSupabase();
  const rows = tasks.map((t) => toRow(t, weekKey));
  const { data, error } = await sb.from('build_queue').insert(rows).select('id');
  if (!error) return (data ?? []).map((r) => (r as { id: string }).id);
  if (!isUniqueViolation(error)) {
    throw new Error(`planner insert failed: ${error.message}`);
  }
  // مسیر کند ولی امن برای مسابقهٔ دو اجرا
  const ids: string[] = [];
  for (const row of rows) {
    const { data: one, error: oneErr } = await sb
      .from('build_queue')
      .insert(row)
      .select('id')
      .single();
    if (oneErr) {
      if (isUniqueViolation(oneErr)) continue;
      throw new Error(`planner insert failed: ${oneErr.message}`);
    }
    ids.push((one as { id: string }).id);
  }
  return ids;
}

/* ------------------------------------------------------------------ */
/* اجرای کامل planner                                                 */
/* ------------------------------------------------------------------ */

/**
 * اجرای planner برای یک هفته: برای هر تیم رستر، بک‌لاگ می‌سازد و با
 * وضعیت pending در build_queue می‌نویسد (دروازهٔ تأیید: مسعود).
 * هیچ قفلی نمی‌گیرد؛ شکست یک تیم، تیم‌های دیگر را متوقف نمی‌کند.
 */
export async function runPlanner(options: PlannerRunOptions = {}): Promise<PlannerRunResult> {
  const weekKey = options.weekKey ?? weekKeyFor();
  const roster: RosterEntry[] = resolveRoster();
  const seen = await existingDedupeKeys(weekKey);
  const teams: Record<string, PlannerTeamResult> = {};

  for (const entry of roster) {
    const team = entry.name;
    const result: PlannerTeamResult = { generated: 0, inserted: 0, skipped: 0 };
    try {
      const rules = await getGoldenRules(team);
      const signals = await loadSignals(team, PLANNER_TASKS_PER_TEAM);
      const tasks = buildBacklog(team, entry.role, rules, signals, teamFaName(team as TeamName));
      result.generated = tasks.length;
      const fresh = tasks.filter((t) => !seen.has(t.dedupeKey));
      result.skipped = tasks.length - fresh.length;
      const ids = await insertPending(fresh, weekKey);
      for (const t of fresh) seen.add(t.dedupeKey);
      result.inserted = ids.length;
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
    teams[team] = result;
  }

  return { weekKey, teams };
}
