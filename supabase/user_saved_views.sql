CREATE TABLE IF NOT EXISTS user_saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  table_slug text NOT NULL,
  view_name text NOT NULL,
  filters jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, company_id, table_slug, view_name)
);

CREATE INDEX IF NOT EXISTS user_saved_views_lookup_idx ON user_saved_views(user_id, company_id, table_slug);

ALTER TABLE user_saved_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_saved_views_company_members ON user_saved_views;
CREATE POLICY user_saved_views_company_members ON user_saved_views
  FOR ALL
  USING (company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()))
  WITH CHECK (company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()));
