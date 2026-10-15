import { ok, fail } from '@/lib/api';
import { TEAM_META } from '@/lib/team-meta';
import {
  scoreAllTeams,
  type ScoreBreakdownItem,
} from '@/lib/knowledge-score';
import type { TeamName } from '@/lib/types';

export interface ReportTeamEntry {
  team: TeamName;
  faName: string;
  /** امتیاز ۰ تا ۱۰۰ از lib/knowledge-score.ts (تیم ۱۴). */
  score: number;
  /** فعلاً همیشه null؛ وقتی تاریخچه امتیازها ذخیره شد پر می‌شود. */
  trend: null;
  /** سه پیشنهاد اول مربی برای این تیم. */
  topSuggestions: string[];
  /** false یعنی خواندن دانش این تیم از دیتابیس ناموفق بود. */
  hasData: boolean;
}

interface ReportTeamHighlight {
  team: TeamName;
  faName: string;
  score: number;
  message: string;
}

interface ReportSummary {
  averageScore: number;
  weakestTeam: ReportTeamHighlight | null;
  strongestTeam: ReportTeamHighlight | null;
  message: string;
}

export interface KnowledgeReport {
  generatedAt: string;
  teams: ReportTeamEntry[];
  summary: ReportSummary;
}

const faNum = (n: number | string): string =>
  String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]);

const ERROR_NOTE = 'خطا در خواندن دانش';

/** توصیه مربی برای هر مؤلفه؛ وقتی lib/teams/knowledge.ts تیم ۴ آماده شد، جایگزینش می‌کند. */
const COACH_ADVICE: Record<ScoreBreakdownItem['key'], string> = {
  coverage:
    'دسته‌های کم‌دانش را پر کن؛ هر دسته دست‌کم ۳ دانش می‌خواهد تا موقع پرسش، جواب از همه زاویه‌ها بیاید.',
  freshness:
    'دانش‌های قدیمی را بازبینی و به‌روز کن؛ دانش کهنه، تصمیم کهنه می‌سازد.',
  diversity:
    'از منابع تازه تغذیه کن؛ دانش تک‌منبعی زود فرسوده می‌شود.',
  volume:
    'دانش بیشتری ثبت کن؛ مغز خالی تیم، جواب تکراری می‌دهد.',
};

/** پیشنهادهای نگه‌داشت برای تیم‌هایی که کمتر از ۳ حلقه ضعیف دارند. */
const MAINTAIN_ADVICE = [
  'همین روند را نگه دار؛ بازبینی دوره‌ای، دانش را تازه نگه می‌دارد.',
  'تجربه‌های تازه تیم را همان هفته ثبت کن تا حافظه تیم از کار امروز جلو بزند.',
];

function buildSuggestions(breakdown: ScoreBreakdownItem[]): string[] {
  const weak = breakdown
    .filter((b) => b.value < b.max)
    .sort((a, b) => b.max - b.value - (a.max - a.value))
    .slice(0, 3)
    .map((b) => `${COACH_ADVICE[b.key]} (${b.note})`);

  const out = [...weak];
  let i = 0;
  while (out.length < 3 && i < MAINTAIN_ADVICE.length) {
    out.push(MAINTAIN_ADVICE[i]);
    i += 1;
  }
  return out;
}

function averageMessage(avg: number): string {
  const v = faNum(avg);
  if (avg >= 70) {
    return `میانگین کیفیت دانش تیم‌ها ${v} از ۱۰۰ است؛ وضعیت کلی خوب است، تمرکز را بگذار روی ضعیف‌ترین حلقه‌ها.`;
  }
  if (avg >= 40) {
    return `میانگین کیفیت دانش تیم‌ها ${v} از ۱۰۰ است؛ جای کار هست، اول سراغ ضعیف‌ترین تیم برو.`;
  }
  return `میانگین کیفیت دانش تیم‌ها ${v} از ۱۰۰ است؛ وضعیت بحرانی است و دانش تیم‌ها توجه فوری می‌خواهد.`;
}

/**
 * GET /api/knowledge/report
 * گزارش دوره‌ای کیفیت دانش همه تیم‌ها (نقش «مربی»).
 * امتیازها از scoreAllTeams (تیم ۱۴) می‌آید؛ پیشنهادها فعلاً از روی
 * ضعیف‌ترین مؤلفه‌های همان امتیاز ساخته می‌شوند تا evaluateTeamKnowledge
 * تیم ۴ آماده شود.
 *
 * احراز ادمین توسط میان‌افزار موجود انجام می‌شود.
 * → { ok, data: { generatedAt, teams: [{ team, faName, score, trend, topSuggestions, hasData }], summary } }
 */
export async function GET(): Promise<Response> {
  let scores: Awaited<ReturnType<typeof scoreAllTeams>>;
  try {
    scores = await scoreAllTeams();
  } catch {
    return fail('خواندن امتیاز دانش از دیتابیس ممکن نشد.', 503);
  }

  const teams = (Object.keys(TEAM_META) as TeamName[]).map(
    (team): ReportTeamEntry => {
      const meta = TEAM_META[team];
      const result = scores[team] ?? { score: 0, breakdown: [] };
      const hasData = !result.breakdown.every((b) => b.note === ERROR_NOTE);
      return {
        team,
        faName: meta.faName,
        score: result.score,
        trend: null,
        hasData,
        topSuggestions: hasData
          ? buildSuggestions(result.breakdown)
          : ['امتیاز این تیم خوانده نشد؛ اتصال دیتابیس یا جدول‌های دانش را بررسی کن.'],
      };
    },
  );

  const withData = teams.filter((t) => t.hasData);
  const averageScore =
    withData.length > 0
      ? Math.round((withData.reduce((s, t) => s + t.score, 0) / withData.length) * 10) / 10
      : 0;

  const weakest =
    withData.length > 0
      ? withData.reduce((a, b) => (b.score < a.score ? b : a))
      : null;
  const strongest =
    withData.length > 0
      ? withData.reduce((a, b) => (b.score > a.score ? b : a))
      : null;

  const summary: ReportSummary = {
    averageScore,
    weakestTeam: weakest
      ? {
          team: weakest.team,
          faName: weakest.faName,
          score: weakest.score,
          message: `تیم «${weakest.faName}» با امتیاز ${faNum(weakest.score)} ضعیف‌ترین حلقه است؛ مربی‌گری را از همین‌جا شروع کن.`,
        }
      : null,
    strongestTeam: strongest
      ? {
          team: strongest.team,
          faName: strongest.faName,
          score: strongest.score,
          message: `تیم «${strongest.faName}» با امتیاز ${faNum(strongest.score)} قوی‌ترین حلقه است؛ الگویش را به بقیه منتقل کن.`,
        }
      : null,
    message: averageMessage(averageScore),
  };

  const report: KnowledgeReport = {
    generatedAt: new Date().toISOString(),
    teams,
    summary,
  };

  return ok(report);
}
