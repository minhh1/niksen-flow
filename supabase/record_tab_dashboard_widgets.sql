-- "Custom dashboard" record tab type — a linked-table tab (same
-- linked_table_id/link_field_id convention as the "custom_table" grid tab,
-- see record_tab_grid_cells.sql) whose content is the same DashboardWidget[]
-- builder/renderer the standalone company_dashboards use, just scoped to the
-- rows of the linked table that point back at this record.
ALTER TABLE record_tabs DROP CONSTRAINT IF EXISTS record_tabs_tab_type_check;
ALTER TABLE record_tabs ADD CONSTRAINT record_tabs_tab_type_check
  CHECK (tab_type = ANY (ARRAY['fields'::text, 'sub_projects'::text, 'checklist'::text, 'calendar'::text, 'emails'::text, 'custom_table'::text, 'document_templates'::text, 'custom_dashboard'::text]));

CREATE TABLE IF NOT EXISTS record_tab_dashboard_widgets (
  tab_id uuid PRIMARY KEY REFERENCES record_tabs(id) ON DELETE CASCADE,
  widgets jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE record_tab_dashboard_widgets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS record_tab_dashboard_widgets_company_members ON record_tab_dashboard_widgets;
CREATE POLICY record_tab_dashboard_widgets_company_members ON record_tab_dashboard_widgets
  FOR ALL
  USING (tab_id IN (SELECT id FROM record_tabs WHERE company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid())))
  WITH CHECK (tab_id IN (SELECT id FROM record_tabs WHERE company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid())));
