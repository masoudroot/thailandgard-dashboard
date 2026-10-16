/**
 * ورکر هفتگی planner — تولید بک‌لاگ build_queue.
 *
 * هر شنبه ساعت ۶:۳۰ تهران از ورک‌فلو planner-weekly.yml اجرا می‌شود:
 *  ۱. برای هر تیم رستر (۴ سازنده + ۳ بازبین)، تا ۱۰ تسک می‌سازد
 *     (قوانین طلایی → سیگنال‌های دادهٔ تازه → بهداشت هفتگی)؛
 *  ۲. تسک‌ها را با وضعیت pending و source='planner-weekly' در build_queue
 *     می‌نویسد تا مسعود تأیید کند — خودکار اجرا نمی‌شوند؛
 *  ۳. تسک تکراری (dedupe_key یکسان در همان week_key) نوشته نمی‌شود.
 *
 * قفل نمی‌گیرد؛ قرارداد با ارکستراتور فقط از طریق build_queue است.
 * اجرای دوباره امن است (idempotent).
 *
 * اجرا: npx tsx worker/planner-worker.ts
 * نیازمند: SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY در env
 * اختیاری: PLANNER_WEEK_KEY (مثل 2026-W42) برای اجرای دستی یک هفتهٔ خاص؛
 *          PLANNER_TEAMS (مثل "content:builder,brand:reviewer") برای بازنویسی رستر.
 */
import { runPlanner } from '../lib/planner/planner';

async function main(): Promise<void> {
  const weekKey = process.env.PLANNER_WEEK_KEY?.trim() || undefined;
  const result = await runPlanner(weekKey ? { weekKey } : {});

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  for (const [team, r] of Object.entries(result.teams)) {
    totalInserted += r.inserted;
    totalSkipped += r.skipped;
    if (r.error) totalFailed += 1;
    console.log(
      `[planner-weekly] team=${team} generated=${r.generated} ` +
        `inserted=${r.inserted} skipped=${r.skipped}` +
        (r.error ? ` error=${r.error}` : ''),
    );
  }
  console.log(
    `[planner-weekly] done week=${result.weekKey} ` +
      `inserted=${totalInserted} skipped=${totalSkipped} failed_teams=${totalFailed}`,
  );
  if (totalFailed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[planner-weekly] fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
