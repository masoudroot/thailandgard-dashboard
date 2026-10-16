-- فیدرهای داده (قدم صفر): جدول‌های page_analytics و gsc_queries +
-- تنگ‌تر کردن RLS روی intel_feed (نوشتن anon بسته، خواندن باز می‌ماند)

-- ۱) page_analytics: بازدید روزانهٔ هر مسیر (منبع: Search Console، clicks به‌عنوان views)
CREATE TABLE IF NOT EXISTS page_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_path TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  avg_position DOUBLE PRECISION,
  date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (page_path, date)
);
CREATE INDEX IF NOT EXISTS idx_page_analytics_date ON page_analytics (date DESC);
ALTER TABLE page_analytics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role full access" ON page_analytics;
CREATE POLICY "service_role full access" ON page_analytics
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ۲) gsc_queries: کوئری‌های روزانهٔ سرچ کنسول
CREATE TABLE IF NOT EXISTS gsc_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  ctr DOUBLE PRECISION,
  avg_position DOUBLE PRECISION,
  date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (query, date)
);
CREATE INDEX IF NOT EXISTS idx_gsc_queries_date ON gsc_queries (date DESC);
ALTER TABLE gsc_queries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role full access" ON gsc_queries;
CREATE POLICY "service_role full access" ON gsc_queries
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ۳) team_golden_rules: هم‌ردیف بقیهٔ جدول‌ها، فقط service_role
ALTER TABLE team_golden_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role full access" ON team_golden_rules;
CREATE POLICY "service_role full access" ON team_golden_rules
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ۴) intel_feed: بستن نوشتن anon؛ فقط خواندن می‌ماند
-- (سایت با SUPABASE_SERVICE_ROLE_KEY می‌نویسد و RLS شاملش نمی‌شود)
DROP POLICY IF EXISTS agents_intel_all ON intel_feed;
CREATE POLICY "intel_feed anon read" ON intel_feed
  FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "service_role full access" ON intel_feed;
CREATE POLICY "service_role full access" ON intel_feed
  FOR ALL TO service_role USING (true) WITH CHECK (true);
