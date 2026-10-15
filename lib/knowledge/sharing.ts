/**
 * lib/knowledge/sharing.ts
 *
 * تگ‌گذاری تیم‌های مرتبط برای اشتراک دانش بین تیم‌ها.
 * طرح کامل: docs/knowledge-sharing.md
 *
 * قانون ضد آلودگی (از سند طراحی):
 * - نمره ارتباط ≥ ۰٫۸۵: اشتراک خودکار
 * - ۰٫۶ تا ۰٫۸۵: پیشنهاد برای تأیید مالک در داشبورد
 * - زیر ۰٫۶: اشتراک نمی‌شود
 */

import type { TeamName } from '../types';
import { callLLMJson } from '../llm';
import { TEAM_META } from '../teams-meta';

export const SHARE_AUTO_THRESHOLD = 0.85;
export const SHARE_SUGGEST_THRESHOLD = 0.6;
export const MAX_SUGGESTED_TEAMS = 3;

interface TeamScoreRow {
  team: string;
  score: number;
  reason: string;
}

/**
 * تیم‌های مرتبط با یک دانش را با LLM پیشنهاد می‌دهد.
 *
 * ورودی: محتوای دانش (عنوان + متن) و تیم مالک.
 * خروجی: حداکثر ۳ نام تیم که نمره ارتباط‌شان ≥ ۰٫۶ است، مرتب بر اساس نمره نزولی.
 *
 * fail-soft: در صورت خطای LLM آرایه خالی برمی‌گردد تا خط لوله دانش هرگز متوقف نشود.
 */
export async function suggestRelatedTeams(
  knowledgeContent: string,
  currentTeam: TeamName,
): Promise<TeamName[]> {
  const trimmed = knowledgeContent.trim();
  if (!trimmed) return [];

  const others = (Object.keys(TEAM_META) as TeamName[]).filter((t) => t !== currentTeam);
  if (others.length === 0) return [];

  const missions = others
    .map((t) => `- ${t} (${TEAM_META[t].faName}): ${TEAM_META[t].mission}`)
    .join('\n');

  const prompt =
    `یک تیم («${currentTeam}») دانش زیر را ثبت کرده است. برای هر یک از تیم‌های دیگر، نمره ارتباط ۰ تا ۱ بده ` +
    `با یک جمله دلیل کوتاه فارسی.\n\n` +
    `دانش:\n${trimmed.slice(0, 2000)}\n\n` +
    `مأموریت تیم‌ها:\n${missions}\n\n` +
    `خروجی فقط آرایه JSON از آبجکت‌های {team, score, reason} برای تیم‌هایی که واقعاً به این دانش نیاز دارند. ` +
    `تیم‌های بی‌ربط را در خروجی نیاور.`;

  try {
    const rows = await callLLMJson<TeamScoreRow[]>(prompt, {
      jsonExample: '[{"team":"content","score":0.9,"reason":"متن‌های سایت همان پیام برند را تکرار می‌کنند"}]',
      temperature: 0.1,
      maxTokens: 1500,
    });
    if (!Array.isArray(rows)) return [];

    const validNames = new Set<string>(others);
    return rows
      .filter(
        (r) =>
          r &&
          typeof r.team === 'string' &&
          typeof r.score === 'number' &&
          validNames.has(r.team) &&
          r.team !== currentTeam &&
          r.score >= SHARE_SUGGEST_THRESHOLD &&
          r.score <= 1,
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SUGGESTED_TEAMS)
      .map((r) => r.team as TeamName);
  } catch {
    // خطای LLM نباید خط لوله دانش را متوقف کند
    return [];
  }
}
