-- جدول ثبت بررسی خودکار گزارش تیم‌ها (report-reviewer).
-- هر team_run و هر bridge_patches نیازمند بررسی، یک ردیف می‌گیرد.

CREATE TABLE IF NOT EXISTS report_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- منبع بررسی: team_run یا bridge_patch
  source_type TEXT NOT NULL CHECK (source_type IN ('team_run', 'bridge_patch')),
  source_id UUID NOT NULL,
  team TEXT NOT NULL,
  cycle_id UUID,
  -- حکم: ok (سالم، نیازی به اقدام نیست) | attention (نیازمند توجه مسعود)
  --       | auto_fixed (خودکار حل شد) | escalated (به مسعود ارجاع شد)
  verdict TEXT NOT NULL CHECK (verdict IN ('ok', 'attention', 'auto_fixed', 'escalated')),
  -- دلیل فارسی کوتاه
  reason TEXT NOT NULL DEFAULT '',
  -- جزئیات ماشینی (یافته‌های چک‌ها)
  findings JSONB NOT NULL DEFAULT '[]',
  -- آیا به مسعود اطلاع داده شد؟
  notified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_report_reviews_source ON report_reviews (source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_report_reviews_team ON report_reviews (team, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_reviews_verdict ON report_reviews (verdict, created_at DESC);

-- واترمارک آخرین بررسی در settings
INSERT INTO settings (key, value, updated_at)
VALUES ('report_reviewer_watermark', '"1970-01-01T00:00:00Z"', NOW())
ON CONFLICT (key) DO NOTHING;
