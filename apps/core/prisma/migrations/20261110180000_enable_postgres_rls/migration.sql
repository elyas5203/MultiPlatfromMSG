-- ==============================================================================
-- Migration: 20261110180000_enable_postgres_rls
-- Purpose: Enable Row-Level Security (RLS) and FORCE RLS on all tenant-scoped tables
-- Condition: current_setting('app.current_tenant_id', true) = tenant_id
-- Target Tables: brands, staff, teams, staff_teams, sessions, contacts, tags, contact_tags, suppression_entries
-- ==============================================================================

-- 1. brands
ALTER TABLE "brands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brands" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_policy" ON "brands"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

-- 2. staff
ALTER TABLE "staff" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_policy" ON "staff"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

-- 3. teams
ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "teams" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_policy" ON "teams"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

-- 4. staff_teams
ALTER TABLE "staff_teams" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_teams" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_policy" ON "staff_teams"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

-- 5. sessions
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_policy" ON "sessions"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

-- 6. contacts
ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_policy" ON "contacts"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

-- 7. tags
ALTER TABLE "tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tags" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_policy" ON "tags"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

-- 8. contact_tags
ALTER TABLE "contact_tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_tags" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_policy" ON "contact_tags"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

-- 9. suppression_entries
ALTER TABLE "suppression_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "suppression_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_policy" ON "suppression_entries"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));
