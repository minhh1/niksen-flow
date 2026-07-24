-- Template upgrade: a company that already installed a template can later
-- pick up tables/fields/dashboards added to the template catalog AFTER their
-- original install (e.g. the Law Firm template gained a Trust Transactions
-- table + new Invoices fields + bundled dashboards after some companies had
-- already installed it -- see template_law_firm_seed.sql). Mirrors
-- install_company_template's passes, but every step is an "only if missing"
-- check instead of an "already_installed short-circuits the whole thing"
-- check, so it's additive-only and safe to run repeatedly (a no-op once the
-- company is fully caught up).
CREATE OR REPLACE FUNCTION upgrade_company_template(
  p_company_id uuid,
  p_template_id uuid,
  p_resolutions jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  -- This function is SECURITY DEFINER and reachable directly via
  -- supabase.rpc() by any authenticated client -- see the same note on
  -- install_company_template in template_marketplace.sql.
  p_actor uuid := auth.uid();
  v_tbl RECORD;
  v_fld RECORD;
  v_sf RECORD;
  v_resolution text;
  v_existing_id uuid;
  v_new_table_id uuid;
  v_new_field_id uuid;
  v_new_slug text;
  v_new_key text;
  v_suffix int;
  v_linked_table_id uuid;
  v_target_table_id uuid;
  v_tables_created int := 0;
  v_fields_created int := 0;
  v_dashboards_created int := 0;
  v_formula_table_id uuid;
  v_a_id uuid;
  v_b_id uuid;
  v_rel_id uuid;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM company_memberships WHERE company_id = p_company_id AND user_id = p_actor
  ) THEN
    RAISE EXCEPTION 'not a member of this company';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM company_template_installs WHERE company_id = p_company_id AND template_id = p_template_id) THEN
    RAISE EXCEPTION 'template is not installed for this company -- use install_company_template first';
  END IF;

  -- Pass 1: any template table not yet mapped for this company (added to
  -- the template's catalog after this company's original install).
  FOR v_tbl IN SELECT * FROM template_definition_tables WHERE template_id = p_template_id ORDER BY display_order LOOP
    IF EXISTS (
      SELECT 1 FROM company_template_table_map
      WHERE company_id = p_company_id AND template_id = p_template_id AND source_template_table_id = v_tbl.id
    ) THEN
      CONTINUE;
    END IF;

    v_resolution := COALESCE(p_resolutions->'tables'->>v_tbl.slug, 'create_new');
    IF v_resolution = 'use_existing' THEN
      SELECT id INTO v_existing_id FROM company_tables WHERE company_id = p_company_id AND slug = v_tbl.slug AND deleted_at IS NULL LIMIT 1;
      IF v_existing_id IS NULL THEN
        RAISE EXCEPTION 'use_existing chosen for table % but no matching table exists', v_tbl.slug;
      END IF;
      INSERT INTO company_template_table_map (company_id, template_id, source_template_table_id, installed_company_table_id, resolution)
        VALUES (p_company_id, p_template_id, v_tbl.id, v_existing_id, 'used_existing');
    ELSE
      v_new_slug := v_tbl.slug;
      v_suffix := 1;
      WHILE EXISTS (SELECT 1 FROM company_tables WHERE company_id = p_company_id AND slug = v_new_slug AND deleted_at IS NULL) LOOP
        v_suffix := v_suffix + 1;
        v_new_slug := v_tbl.slug || '-' || v_suffix;
      END LOOP;

      INSERT INTO company_tables (company_id, name, slug, icon, color, primary_field_key, display_order, is_ledger)
        VALUES (p_company_id, v_tbl.name, v_new_slug, v_tbl.icon, v_tbl.color, v_tbl.primary_field_key, v_tbl.display_order, v_tbl.is_ledger)
        RETURNING id INTO v_new_table_id;
      v_tables_created := v_tables_created + 1;

      INSERT INTO company_template_table_map (company_id, template_id, source_template_table_id, installed_company_table_id, resolution)
        VALUES (p_company_id, p_template_id, v_tbl.id, v_new_table_id, 'created');

      INSERT INTO schema_change_log (company_id, actor_id, entity_type, entity_id, entity_label, action, after)
        VALUES (p_company_id, p_actor, 'company_table', v_new_table_id, v_tbl.name, 'create',
          jsonb_build_object('name', v_tbl.name, 'slug', v_new_slug, 'from_template', p_template_id, 'via', 'upgrade'));
    END IF;
  END LOOP;

  -- Pass 2: any template field not yet present on its mapped table -- covers
  -- both fields added to an already-installed table since original install,
  -- and every field of a table just mapped in Pass 1. Skipped for tables
  -- mapped 'used_existing' (same rule as install: never touch a tenant's
  -- own pre-existing table).
  FOR v_tbl IN SELECT * FROM template_definition_tables WHERE template_id = p_template_id LOOP
    SELECT installed_company_table_id, resolution INTO v_target_table_id, v_resolution
      FROM company_template_table_map
      WHERE company_id = p_company_id AND template_id = p_template_id AND source_template_table_id = v_tbl.id;
    IF v_target_table_id IS NULL OR v_resolution IS DISTINCT FROM 'created' THEN CONTINUE; END IF;

    FOR v_fld IN SELECT * FROM template_definition_table_fields WHERE template_table_id = v_tbl.id ORDER BY display_order LOOP
      IF EXISTS (SELECT 1 FROM company_table_fields WHERE table_id = v_target_table_id AND field_key = v_fld.field_key AND deleted_at IS NULL) THEN
        CONTINUE;
      END IF;

      v_linked_table_id := NULL;
      IF v_fld.linked_template_table_id IS NOT NULL THEN
        SELECT installed_company_table_id INTO v_linked_table_id FROM company_template_table_map
          WHERE company_id = p_company_id AND template_id = p_template_id AND source_template_table_id = v_fld.linked_template_table_id;
      END IF;

      INSERT INTO company_table_fields (
        company_id, table_id, field_key, label, field_type, select_options,
        linked_table_id, linked_system_table, linked_display_field,
        is_required, is_unique, show_in_table, display_order, section_name, help_text,
        auto_number_prefix, auto_number_start, auto_number_pad
      ) VALUES (
        p_company_id, v_target_table_id, v_fld.field_key, v_fld.label, v_fld.field_type, v_fld.select_options,
        v_linked_table_id, v_fld.linked_system_table, v_fld.linked_display_field,
        v_fld.is_required, v_fld.is_unique, v_fld.show_in_table, v_fld.display_order, v_fld.section_name, v_fld.help_text,
        v_fld.auto_number_prefix, v_fld.auto_number_start, v_fld.auto_number_pad
      );
      v_fields_created := v_fields_created + 1;
    END LOOP;
  END LOOP;

  -- Pass 3: (re)resolve formula wiring for any field that has formula_type
  -- in the catalog but not yet on the installed field -- covers fields just
  -- added in Pass 2, and any sum_related field whose related table wasn't
  -- installed until this upgrade.
  FOR v_tbl IN SELECT * FROM template_definition_tables WHERE template_id = p_template_id LOOP
    SELECT installed_company_table_id, resolution INTO v_target_table_id, v_resolution
      FROM company_template_table_map
      WHERE company_id = p_company_id AND template_id = p_template_id AND source_template_table_id = v_tbl.id;
    IF v_target_table_id IS NULL OR v_resolution IS DISTINCT FROM 'created' THEN CONTINUE; END IF;

    FOR v_fld IN SELECT * FROM template_definition_table_fields
      WHERE template_table_id = v_tbl.id AND formula_type IS NOT NULL LOOP

      IF EXISTS (
        SELECT 1 FROM company_table_fields
        WHERE table_id = v_target_table_id AND field_key = v_fld.field_key AND deleted_at IS NULL AND formula_type IS NOT NULL
      ) THEN CONTINUE; END IF;

      IF v_fld.formula_type = 'sum_related' THEN
        SELECT m.installed_company_table_id INTO v_formula_table_id
          FROM template_definition_tables tt
          JOIN company_template_table_map m ON m.source_template_table_id = tt.id AND m.company_id = p_company_id AND m.template_id = p_template_id
          WHERE tt.template_id = p_template_id AND tt.slug = v_fld.formula_related_table_slug;
      ELSE
        v_formula_table_id := v_target_table_id;
      END IF;
      IF v_formula_table_id IS NULL THEN CONTINUE; END IF;

      v_a_id := NULL; v_b_id := NULL; v_rel_id := NULL;
      SELECT id INTO v_a_id FROM company_table_fields
        WHERE table_id = v_formula_table_id AND field_key = v_fld.formula_field_a_key AND deleted_at IS NULL;
      IF v_fld.formula_field_b_key IS NOT NULL THEN
        SELECT id INTO v_b_id FROM company_table_fields
          WHERE table_id = v_formula_table_id AND field_key = v_fld.formula_field_b_key AND deleted_at IS NULL;
      END IF;
      IF v_fld.formula_relation_field_key IS NOT NULL THEN
        SELECT id INTO v_rel_id FROM company_table_fields
          WHERE table_id = v_formula_table_id AND field_key = v_fld.formula_relation_field_key AND deleted_at IS NULL;
      END IF;

      UPDATE company_table_fields SET
        formula_type = v_fld.formula_type,
        formula_field_a_id = v_a_id,
        formula_field_b_id = v_b_id,
        formula_percent = v_fld.formula_percent,
        formula_relation_field_id = v_rel_id
      WHERE table_id = v_target_table_id AND field_key = v_fld.field_key AND deleted_at IS NULL;
    END LOOP;
  END LOOP;

  -- Pass 4: dashboards. install_template_dashboards (see
  -- template_marketplace_dashboards_install.sql) already skips any
  -- template_definition_dashboards row already mapped for this company, so
  -- it's safe to call again here -- it only creates what's missing.
  SELECT install_template_dashboards(p_company_id, p_template_id) INTO v_dashboards_created;

  -- System fields (entities/projects/properties): any not yet mapped.
  FOR v_sf IN SELECT * FROM template_definition_system_fields WHERE template_id = p_template_id ORDER BY display_order LOOP
    IF EXISTS (
      SELECT 1 FROM company_template_field_map
      WHERE company_id = p_company_id AND template_id = p_template_id AND source_template_system_field_id = v_sf.id
    ) THEN
      CONTINUE;
    END IF;

    v_resolution := COALESCE(p_resolutions->'systemFields'->>(v_sf.table_name || ':' || v_sf.field_key), 'create_new');
    IF v_resolution = 'use_existing' THEN
      SELECT id INTO v_existing_id FROM company_custom_fields
        WHERE company_id = p_company_id AND table_name = v_sf.table_name AND field_key = v_sf.field_key AND deleted_at IS NULL LIMIT 1;
      IF v_existing_id IS NULL THEN
        RAISE EXCEPTION 'use_existing chosen for field %:% but no matching field exists', v_sf.table_name, v_sf.field_key;
      END IF;
      INSERT INTO company_template_field_map (company_id, template_id, source_template_system_field_id, target_table_name, installed_company_custom_field_id, resolution)
        VALUES (p_company_id, p_template_id, v_sf.id, v_sf.table_name, v_existing_id, 'used_existing');
    ELSE
      v_new_key := v_sf.field_key;
      v_suffix := 1;
      WHILE EXISTS (SELECT 1 FROM company_custom_fields WHERE company_id = p_company_id AND table_name = v_sf.table_name AND field_key = v_new_key AND deleted_at IS NULL) LOOP
        v_suffix := v_suffix + 1;
        v_new_key := v_sf.field_key || '_' || v_suffix;
      END LOOP;

      INSERT INTO company_custom_fields (
        company_id, table_name, field_key, label, field_type, select_options,
        is_required, is_unique, display_order, section_name, help_text, default_value,
        auto_generate, auto_generate_type, auto_generate_prefix,
        linked_table, linked_display_column, grid_width, show_in_table
      ) VALUES (
        p_company_id, v_sf.table_name, v_new_key, v_sf.label, v_sf.field_type, v_sf.select_options,
        v_sf.is_required, v_sf.is_unique, v_sf.display_order, v_sf.section_name, v_sf.help_text, v_sf.default_value,
        v_sf.auto_generate, v_sf.auto_generate_type, v_sf.auto_generate_prefix,
        v_sf.linked_table, v_sf.linked_display_column, 2, false
      ) RETURNING id INTO v_new_field_id;
      v_fields_created := v_fields_created + 1;

      INSERT INTO company_template_field_map (company_id, template_id, source_template_system_field_id, target_table_name, installed_company_custom_field_id, resolution)
        VALUES (p_company_id, p_template_id, v_sf.id, v_sf.table_name, v_new_field_id, 'created');

      INSERT INTO schema_change_log (company_id, actor_id, entity_type, entity_id, entity_label, action, after)
        VALUES (p_company_id, p_actor, 'company_custom_field', v_new_field_id, v_sf.label, 'create',
          jsonb_build_object('table_name', v_sf.table_name, 'field_key', v_new_key, 'from_template', p_template_id, 'via', 'upgrade'));
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'upgraded',
    'tables_created', v_tables_created, 'fields_created', v_fields_created, 'dashboards_created', v_dashboards_created
  );
END;
$$;
