-- حلقهٔ بازبینی منتقد (دستور مسعود): لاگ دورهای اجرای مجدد تیم
-- هر دور: شماره دور، تأیید/رد، دلیل رد، دستور منتقد
ALTER TABLE team_runs
  ADD COLUMN IF NOT EXISTS review_rounds JSONB;

COMMENT ON COLUMN team_runs.review_rounds IS
  'آرایه JSON از دورهای حلقه بازبینی منتقد: [{round, approved, reason, directive}]. دور ۱ اجرای اول؛ دور ۲ و ۳ بازاجرا با دستور منتقد.';
