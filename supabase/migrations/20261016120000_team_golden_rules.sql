-- قوانین طلایی هر تیم (حداکثر ۱۰ قانون پرتأثیر)
CREATE TABLE IF NOT EXISTS team_golden_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team TEXT NOT NULL,
  rule TEXT NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  impact_score INTEGER NOT NULL DEFAULT 50,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(team, rule)
);

CREATE INDEX IF NOT EXISTS idx_golden_rules_team_score
  ON team_golden_rules(team, impact_score DESC);
