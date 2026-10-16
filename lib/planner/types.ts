/**
 * lib/planner/types.ts — تایپ‌های مشترک planner هفتگی.
 *
 * planner ورودی (قوانین طلایی + سیگنال‌های داده) را به بک‌لاگ build_queue
 * تبدیل می‌کند؛ قرارداد با ارکستراتور فقط همین جدول است.
 */

export type PlannerTeamRole = 'builder' | 'reviewer';

/** یک تسک برنامه‌ریزی‌شده، آمادهٔ ثبت در build_queue با وضعیت pending. */
export interface PlannerTask {
  team: string;
  title: string;
  description: string;
  /** معیار قبولی تسک؛ در ستون acceptance می‌نشیند. */
  acceptance: string;
  /** برآورد تلاش: ۱=کم‌ریسک، ۲=متوسط، ۳=سنگین (قید DB همین بازه است). */
  estimate: 1 | 2 | 3;
  /** کلید یکتاسازی؛ همراه week_key در هر هفته یکتا می‌ماند. */
  dedupeKey: string;
  priority: 'low' | 'medium' | 'high';
}

export interface PlannerRunOptions {
  /** کلید هفته (مثل 2026-W42)؛ پیش‌فرض: هفتهٔ جاری ISO. */
  weekKey?: string;
}

export interface PlannerTeamResult {
  /** چند تسک برای تیم ساخته شد (پیش از dedupe). */
  generated: number;
  /** چند تسک واقعاً ثبت شد. */
  inserted: number;
  /** چند تسک به‌خاطر تکراری بودن رد شد. */
  skipped: number;
  /** اگر ثبت تیم شکست خورد، دلیلش این‌جاست (تیم‌های دیگر ادامه می‌دهند). */
  error?: string;
}

export interface PlannerRunResult {
  weekKey: string;
  teams: Record<string, PlannerTeamResult>;
}

/** منشأ تسک‌های planner در ستون source جدول build_queue. */
export const PLANNER_SOURCE = 'planner-weekly';

/** سقف تسک هر تیم در هر هفته. */
export const PLANNER_TASKS_PER_TEAM = 10;
