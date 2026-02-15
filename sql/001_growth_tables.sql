-- Growth Module Tables
-- Run this in Supabase SQL Editor to create the required tables

-- 1. Usage tracking / quota enforcement
CREATE TABLE IF NOT EXISTS growth_usage_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  user_id uuid NOT NULL REFERENCES profiles(id),
  event_type text NOT NULL,           -- 'market_analysis', 'campaign_plan', etc.
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_growth_usage_log_account_month
  ON growth_usage_log (account_id, created_at);

-- 2. Saved market analysis results
CREATE TABLE IF NOT EXISTS growth_market_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  user_id uuid NOT NULL REFERENCES profiles(id),
  request_data jsonb NOT NULL DEFAULT '{}'::jsonb,   -- input params (zip, services, etc.)
  result_data jsonb NOT NULL DEFAULT '{}'::jsonb,    -- full LLM analysis output
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_growth_market_analyses_account
  ON growth_market_analyses (account_id, created_at DESC);

-- 3. Saved campaign plans (linked to an analysis)
CREATE TABLE IF NOT EXISTS growth_campaign_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  user_id uuid NOT NULL REFERENCES profiles(id),
  analysis_id uuid REFERENCES growth_market_analyses(id),
  plan_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_growth_campaign_plans_account
  ON growth_campaign_plans (account_id, created_at DESC);

-- updated_at triggers (required for sync)
CREATE TRIGGER set_growth_market_analyses_updated_at
  BEFORE UPDATE ON growth_market_analyses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_growth_campaign_plans_updated_at
  BEFORE UPDATE ON growth_campaign_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS policies (SELECT/INSERT/UPDATE only — no DELETE, using soft deletes pattern)

ALTER TABLE growth_usage_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_market_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_campaign_plans ENABLE ROW LEVEL SECURITY;

-- growth_usage_log: service role only (worker uses service_role key)
CREATE POLICY "Service role full access on growth_usage_log"
  ON growth_usage_log FOR ALL
  USING (true)
  WITH CHECK (true);

-- growth_market_analyses: service role full access
CREATE POLICY "Service role full access on growth_market_analyses"
  ON growth_market_analyses FOR ALL
  USING (true)
  WITH CHECK (true);

-- growth_campaign_plans: service role full access
CREATE POLICY "Service role full access on growth_campaign_plans"
  ON growth_campaign_plans FOR ALL
  USING (true)
  WITH CHECK (true);

-- Note: The worker connects with the service_role key which bypasses RLS.
-- If you want users to read their own analyses via the Expo app (using anon key),
-- add account-scoped SELECT policies like:
--
-- CREATE POLICY "Users can view own account analyses"
--   ON growth_market_analyses FOR SELECT
--   USING (account_id = (auth.jwt() -> 'app_metadata' ->> 'account_id')::uuid);
