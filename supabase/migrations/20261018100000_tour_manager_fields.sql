-- مایگریشن مدیر تور (فاز ۱): فیلدهای تازه روی tours
-- تصمیم‌های مسعود ۱۴۰۵/۰۷/۲۶: قیمت «از X»، تور لحظه‌آخری مجاز، تور منقضی نگه‌داشته می‌شود

ALTER TABLE tours
  ADD COLUMN IF NOT EXISTS season text DEFAULT 'همه‌فصل',
  ADD COLUMN IF NOT EXISTS departure_dates text[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS source text DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS priority int DEFAULT 100,
  ADD COLUMN IF NOT EXISTS is_last_minute boolean DEFAULT false;

-- ایندکس برای مرتب‌سازی نمایش در /tours
CREATE INDEX IF NOT EXISTS tours_priority_idx ON tours (priority ASC, active DESC);

COMMENT ON COLUMN tours.season IS 'فصل هدف تور: همه‌فصل، نوروز، تابستان، پاییز، زمستان';
COMMENT ON COLUMN tours.departure_dates IS 'تاریخ‌های حرکت (شمسی)؛ null یعنی هر هفته';
COMMENT ON COLUMN tours.source IS 'منبع تعریف تور: manual | competitor | keyword | tour-manager';
COMMENT ON COLUMN tours.priority IS 'اولویت نمایش در فهرست تورها؛ کمتر یعنی بالاتر';
COMMENT ON COLUMN tours.is_last_minute IS 'تور لحظه‌آخری؛ قیمت و ظرفیت شناور';
