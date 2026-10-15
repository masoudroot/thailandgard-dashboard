/**
 * lib/knowledge-score.ts: تیم ۱۴، معیار «دانشمند حوزه»
 *
 * امتیاز ۰ تا ۱۰۰ برای کیفیت پایه دانش هر تیم، از چهار مؤلفه وزنی:
 * - پوشش (۳۰٪): نسبت دسته‌هایی که حداقل ۳ دانش دارند به کل دسته‌ها
 * - تازگی (۲۵٪): نزولی بر میانگین سن دانش‌ها؛ زیر ۷ روز کامل، بالای ۹۰ روز صفر
 * - تنوع منابع (۲۵٪): تعداد دامنه یا منبع یکتا؛ سقف ۱۰ منبع یعنی کامل
 * - حجم (۲۰٪): تعداد دانش‌ها؛ سقف ۵۰ یعنی کامل
 *
 * خالص و بدون وابستگی به UI؛ تیم ۱۱ همین توابع را برای API مصرف می‌کند.
 */

import { getSupabase } from './api';
import { TEAM_META } from './team-meta';
import type { TeamName } from './types';

/** یک ردیف breakdown؛ دقیقاً همین شکل در قرارداد تیم ۱۱ ثبت شده است. */
export interface ScoreBreakdownItem {
  key: 'coverage' | 'freshness' | 'diversity' | 'volume';
  label: string;
  value: number;
  max: number;
  note: string;
}

export interface TeamKnowledgeScore {
  /** امتیاز نهایی ۰ تا ۱۰۰. */
  score: number;
  breakdown: ScoreBreakdownItem[];
}

const WEIGHTS = {
  coverage: 30,
  freshness: 25,
  diversity: 25,
  volume: 20,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const FRESH_FULL_DAYS = 7;
const FRESH_ZERO_DAYS = 90;
const DIVERSITY_FULL = 10;
const VOLUME_FULL = 50;
const MIN_ITEMS_PER_CATEGORY = 3;

const round1 = (n: number) => Math.round(n * 10) / 10;

interface KnowledgeRow {
  id: string;
  category_id: string | null;
  source: string | null;
  updated_at: string;
}

/** از source یک رشته یکتا بساز: اگر URL بود هاست، وگرنه خود متن منبع. */
function normalizeSource(source: string | null): string | null {
  const s = (source ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(s.includes('://') ? s : `https://${s}`);
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return u.hostname.toLowerCase();
  } catch {
    // ادامه می‌دهیم
  }
  return s.toLowerCase();
}

/**
 * امتیاز دانش یک تیم.
 * خطای دیتابیس را به بالا پرتاب می‌کند؛ تصمیم‌گیری با فراخواننده است.
 */
export async function scoreTeamKnowledge(team: TeamName): Promise<TeamKnowledgeScore> {
  const supabase = getSupabase();

  const [{ data: categories, error: catErr }, { data: items, error: itemErr }] =
    await Promise.all([
      supabase.from('knowledge_categories').select('id').eq('team', team),
      supabase
        .from('team_knowledge')
        .select('id, category_id, source, updated_at')
        .eq('team', team),
    ]);

  if (catErr) throw new Error(`scoreTeamKnowledge(${team}): ${catErr.message}`);
  if (itemErr) throw new Error(`scoreTeamKnowledge(${team}): ${itemErr.message}`);

  const rows = (items ?? []) as KnowledgeRow[];
  const categoryIds = (categories ?? []).map((c: { id: string }) => c.id);
  const count = rows.length;

  // ۱) پوشش: دسته‌های دارای حداقل ۳ دانش
  const perCategory = new Map<string, number>();
  for (const r of rows) {
    if (r.category_id) perCategory.set(r.category_id, (perCategory.get(r.category_id) ?? 0) + 1);
  }
  const filled = categoryIds.filter((id) => (perCategory.get(id) ?? 0) >= MIN_ITEMS_PER_CATEGORY)
    .length;
  const coverageRatio = categoryIds.length > 0 ? filled / categoryIds.length : 0;

  // ۲) تازگی: نزول خطی روی میانگین سن
  let freshnessRatio = 0;
  let avgAgeDays = 0;
  if (count > 0) {
    const now = Date.now();
    const totalAge =
      rows.reduce((sum, r) => sum + Math.max(0, now - new Date(r.updated_at).getTime()), 0) / DAY_MS;
    avgAgeDays = totalAge / count;
    if (avgAgeDays <= FRESH_FULL_DAYS) freshnessRatio = 1;
    else if (avgAgeDays >= FRESH_ZERO_DAYS) freshnessRatio = 0;
    else freshnessRatio = 1 - (avgAgeDays - FRESH_FULL_DAYS) / (FRESH_ZERO_DAYS - FRESH_FULL_DAYS);
  }

  // ۳) تنوع منابع: دامنه یا منبع یکتا، سقف ۱۰
  const sources = new Set<string>();
  for (const r of rows) {
    const s = normalizeSource(r.source);
    if (s) sources.add(s);
  }
  const diversityRatio = Math.min(sources.size / DIVERSITY_FULL, 1);

  // ۴) حجم: تعداد دانش‌ها، سقف ۵۰
  const volumeRatio = Math.min(count / VOLUME_FULL, 1);

  const coveragePts = round1(coverageRatio * WEIGHTS.coverage);
  const freshnessPts = round1(freshnessRatio * WEIGHTS.freshness);
  const diversityPts = round1(diversityRatio * WEIGHTS.diversity);
  const volumePts = round1(volumeRatio * WEIGHTS.volume);

  const breakdown: ScoreBreakdownItem[] = [
    {
      key: 'coverage',
      label: 'پوشش',
      value: coveragePts,
      max: WEIGHTS.coverage,
      note: `${filled} دسته از ${categoryIds.length} دسته، حداقل ${MIN_ITEMS_PER_CATEGORY} دانش دارند`,
    },
    {
      key: 'freshness',
      label: 'تازگی',
      value: freshnessPts,
      max: WEIGHTS.freshness,
      note:
        count > 0
          ? `میانگین سن دانش‌ها ${Math.round(avgAgeDays)} روز`
          : 'هنوز دانشی ثبت نشده',
    },
    {
      key: 'diversity',
      label: 'تنوع منابع',
      value: diversityPts,
      max: WEIGHTS.diversity,
      note: `${sources.size} منبع یکتا از سقف ${DIVERSITY_FULL} منبع`,
    },
    {
      key: 'volume',
      label: 'حجم',
      value: volumePts,
      max: WEIGHTS.volume,
      note: `${count} دانش از سقف ${VOLUME_FULL} دانش`,
    },
  ];

  return {
    score: round1(coveragePts + freshnessPts + diversityPts + volumePts),
    breakdown,
  };
}

const ZERO_BREAKDOWN: ScoreBreakdownItem[] = [
  { key: 'coverage', label: 'پوشش', value: 0, max: WEIGHTS.coverage, note: 'خطا در خواندن دانش' },
  { key: 'freshness', label: 'تازگی', value: 0, max: WEIGHTS.freshness, note: 'خطا در خواندن دانش' },
  { key: 'diversity', label: 'تنوع منابع', value: 0, max: WEIGHTS.diversity, note: 'خطا در خواندن دانش' },
  { key: 'volume', label: 'حجم', value: 0, max: WEIGHTS.volume, note: 'خطا در خواندن دانش' },
];

/** امتیاز هر ۱۵ تیم از روی TEAM_META؛ خطای یک تیم، بقیه را متوقف نمی‌کند. */
export async function scoreAllTeams(): Promise<Record<TeamName, TeamKnowledgeScore>> {
  const teams = Object.keys(TEAM_META) as TeamName[];
  const entries = await Promise.all(
    teams.map(async (team): Promise<[TeamName, TeamKnowledgeScore]> => {
      try {
        return [team, await scoreTeamKnowledge(team)];
      } catch {
        return [team, { score: 0, breakdown: ZERO_BREAKDOWN }];
      }
    }),
  );
  return Object.fromEntries(entries) as Record<TeamName, TeamKnowledgeScore>;
}
