/**
 * تیم تستی موقت برای تست حلقهٔ بازبینی منتقد (فقط در تست استفاده می‌شود).
 * رفتار از REVIEW_LOOP_SCRIPT خوانده می‌شود: آرایه‌ای مثل ["reject","approve"].
 * ورودی هر دور (round، reviewDirective) در REVIEW_LOOP_LOG ثبت می‌شود.
 * این فایل بعد از تست حذف می‌شود و جزئی از محصول نیست.
 */
import fs from 'node:fs';

export const TEAM = '__reviewlooptest';

export async function runTeam(input: any): Promise<any> {
  const script: string[] = JSON.parse(process.env.REVIEW_LOOP_SCRIPT || '["approve"]');
  const logPath = process.env.REVIEW_LOOP_LOG || '/tmp/review-loop-log.json';
  let log: any[] = [];
  try {
    log = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
  } catch {
    log = [];
  }
  const round: number = input.round ?? 1;
  const behavior = script[round - 1] ?? 'approve';
  log.push({
    round,
    ts: Date.now(),
    pid: process.pid,
    behavior,
    hasDirective: !!input.reviewDirective,
    directivePreview: String(input.reviewDirective || '').slice(0, 120),
    ragHasDirective: String(input.ragContext || '').includes('دستور منتقد'),
  });
  fs.writeFileSync(logPath, JSON.stringify(log));
  if (behavior === 'reject') {
    const faRound = String(round).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
    return {
      team: '__reviewlooptest',
      summary: `خلاصهٔ دور ${faRound}`,
      blockers: [`دلیل رد دور ${faRound}: کیفیت خروجی کافی نیست؛ بخش دوم ناقص است`],
      tasks: [],
      approved: false,
    };
  }
  return {
    team: '__reviewlooptest',
    summary: 'انجام شد',
    blockers: [],
    tasks: [],
    approved: true,
  };
}
