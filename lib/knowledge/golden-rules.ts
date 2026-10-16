/**
 * lib/knowledge/golden-rules.ts — ۱۰ قانون طلایی هر تیم.
 *
 * مشکل: دانش هر تیم می‌تواند صدها رکورد شود؛ پرامپت منفجر می‌شود و تیم
 * نمی‌داند کدام قانون مهم است.
 *
 * راه‌حل: هر تیم حداکثر ۱۰ «قانون طلایی» دارد — مهم‌ترین، کاربردی‌ترین و
 * پرتکرارترین درس‌ها. این‌ها در ابتدای بخش دانش پرامپت می‌آیند و تیم موظف
 * است قبل از اجرا بنویسد کدام ۲ قانون را اعمال می‌کند.
 *
 * قوانین طلایی از:
 * - بازخوردهای منتقد (تکرارشونده‌ترین ایرادها)
 * - دانش ثبت‌شده (پرتأثیرترین‌ها)
 * ساخته می‌شوند و هر ۱۰ چرخه بازبینی می‌شوند.
 */

import { getSupabase } from '../api';

export interface GoldenRule {
  id: string;
  team: string;
  rule: string;
  /** چرا این قانون مهم است؟ */
  why: string;
  /** از کجا آمده؟ (critic-feedback, learned, manual) */
  source: string;
  /** امتیاز تأثیر (برای مرتب‌سازی). */
  impact_score: number;
  created_at: string;
}

/** حداکثر قانون طلایی هر تیم. */
export const MAX_GOLDEN_RULES = 10;

/**
 * خواندن ۱۰ قانون طلایی یک تیم.
 */
export async function getGoldenRules(team: string): Promise<GoldenRule[]> {
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('team_golden_rules')
      .select('*')
      .eq('team', team)
      .order('impact_score', { ascending: false })
      .limit(MAX_GOLDEN_RULES);
    if (error) return [];
    return (data || []) as GoldenRule[];
  } catch {
    return [];
  }
}

/**
 * ساخت بخش «قوانین طلایی» برای پرامپت.
 * اگر قانونی نبود، رشته خالی برمی‌گرداند.
 */
export async function buildGoldenRulesSection(team: string): Promise<string> {
  const rules = await getGoldenRules(team);
  if (rules.length === 0) return '';
  const lines = rules.map((r, i) => `${i + 1}. ${r.rule}`);
  return [
    `⚡ قوانین طلایی تیم «${team}» (حتماً رعایت کن؛ قبل از اجرا بنویس کدام ۲ را اعمال می‌کنی):`,
    ...lines,
  ].join('\n');
}

/**
 * افزودن یا به‌روزرسانی یک قانون طلایی.
 * اگر تیم بیش از ۱۰ قانون داشت، کم‌اثرترین حذف می‌شود.
 */
export async function upsertGoldenRule(
  team: string,
  rule: string,
  why: string,
  source: string,
  impact_score: number = 50,
): Promise<void> {
  const sb = getSupabase();
  // بررسی تکراری نبودن
  const existing = await getGoldenRules(team);
  const duplicate = existing.find(
    (r) => r.rule.trim() === rule.trim(),
  );
  if (duplicate) return; // تکراری؛ اضافه نمی‌شود

  await sb.from('team_golden_rules').insert({
    team,
    rule: rule.trim(),
    why: why.trim(),
    source,
    impact_score,
  });

  // اگر بیش از ۱۰ شد، کم‌اثرترین را حذف کن
  const after = await getGoldenRules(team);
  if (after.length > MAX_GOLDEN_RULES) {
    const toRemove = after[after.length - 1];
    await sb.from('team_golden_rules').delete().eq('id', toRemove.id);
  }
}
