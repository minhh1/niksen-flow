-- Lets the template catalog carry computed fields, auto-numbering and
-- ledger (append-only) tables, so the Law Firm template installs with
-- Amount = Rate x Hours, GST = 10% of Subtotal, consecutive trust receipt
-- numbers and an append-only Trust Transactions table already wired up.
-- Catalog fields reference each other by field_key (ids only exist after
-- install); install_company_template resolves keys to the installed
-- company_table_fields ids in a third pass. See:
--   supabase/company_table_fields_formula.sql + _formula_extend.sql (live formula columns)
--   supabase/company_table_field_sequences.sql (auto_number_prefix)
--   supabase/company_table_ledger.sql (is_ledger)

ALTER TABLE template_definition_tables ADD COLUMN IF NOT EXISTS is_ledger boolean NOT NULL DEFAULT false;

ALTER TABLE template_definition_table_fields ADD COLUMN IF NOT EXISTS formula_type text
  CHECK (formula_type IN ('multiply', 'percentage_of', 'add', 'sum_related'));
ALTER TABLE template_definition_table_fields ADD COLUMN IF NOT EXISTS formula_field_a_key text;
ALTER TABLE template_definition_table_fields ADD COLUMN IF NOT EXISTS formula_field_b_key text;
ALTER TABLE template_definition_table_fields ADD COLUMN IF NOT EXISTS formula_percent numeric;
-- sum_related only: the related table (by template slug) whose rows are
-- summed; formula_field_a_key and formula_relation_field_key are then keys
-- on THAT table (the field to sum, and its relation field pointing back).
ALTER TABLE template_definition_table_fields ADD COLUMN IF NOT EXISTS formula_related_table_slug text;
ALTER TABLE template_definition_table_fields ADD COLUMN IF NOT EXISTS formula_relation_field_key text;
ALTER TABLE template_definition_table_fields ADD COLUMN IF NOT EXISTS auto_number_prefix text;
ALTER TABLE template_definition_table_fields ADD COLUMN IF NOT EXISTS auto_number_start bigint;
ALTER TABLE template_definition_table_fields ADD COLUMN IF NOT EXISTS auto_number_pad int;

-- Re-declared in full from template_marketplace.sql; changes are marked
-- with "formula/ledger:" comments.
CREATE OR REPLACE FUNCTION install_company_template(
  p_company_id uuid,
  p_template_id uuid,
  p_resolutions jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
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
  v_install_id uuid;
  v_overrides jsonb;
  v_apply_overrides boolean;
  v_tables_created int := 0;
  v_fields_created int := 0;
  -- formula/ledger: pass-3 resolution locals
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

  IF EXISTS (SELECT 1 FROM company_template_installs WHERE company_id = p_company_id AND template_id = p_template_id) THEN
    RETURN jsonb_build_object('status', 'already_installed');
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS tmp_template_table_map (source_id uuid PRIMARY KEY, installed_id uuid) ON COMMIT DROP;
  TRUNCATE tmp_template_table_map;

  -- Pass 1: tables
  FOR v_tbl IN SELECT * FROM template_definition_tables WHERE template_id = p_template_id ORDER BY display_order LOOP
    v_resolution := COALESCE(p_resolutions->'tables'->>v_tbl.slug, 'create_new');

    IF v_resolution = 'use_existing' THEN
      SELECT id INTO v_existing_id FROM company_tables WHERE company_id = p_company_id AND slug = v_tbl.slug AND deleted_at IS NULL LIMIT 1;
      IF v_existing_id IS NULL THEN
        RAISE EXCEPTION 'use_existing chosen for table % but no matching table exists', v_tbl.slug;
      END IF;
      INSERT INTO tmp_template_table_map (source_id, installed_id) VALUES (v_tbl.id, v_existing_id);
      INSERT INTO company_template_table_map (company_id, template_id, source_template_table_id, installed_company_table_id, resolution)
        VALUES (p_company_id, p_template_id, v_tbl.id, v_existing_id, 'used_existing');
    ELSE
      v_new_slug := v_tbl.slug;
      v_suffix := 1;
      WHILE EXISTS (SELECT 1 FROM company_tables WHERE company_id = p_company_id AND slug = v_new_slug AND deleted_at IS NULL) LOOP
        v_suffix := v_suffix + 1;
        v_new_slug := v_tbl.slug || '-' || v_suffix;
      END LOOP;

      -- formula/ledger: carry is_ledger onto the installed table
      INSERT INTO company_tables (company_id, name, slug, icon, color, primary_field_key, display_order, is_ledger)
        VALUES (p_company_id, v_tbl.name, v_new_slug, v_tbl.icon, v_tbl.color, v_tbl.primary_field_key, v_tbl.display_order, v_tbl.is_ledger)
        RETURNING id INTO v_new_table_id;
      v_tables_created := v_tables_created + 1;

      INSERT INTO tmp_template_table_map (source_id, installed_id) VALUES (v_tbl.id, v_new_table_id);
      INSERT INTO company_template_table_map (company_id, template_id, source_template_table_id, installed_company_table_id, resolution)
        VALUES (p_company_id, p_template_id, v_tbl.id, v_new_table_id, 'created');

      INSERT INTO schema_change_log (company_id, actor_id, entity_type, entity_id, entity_label, action, after)
        VALUES (p_company_id, p_actor, 'company_table', v_new_table_id, v_tbl.name, 'create',
          jsonb_build_object('name', v_tbl.name, 'slug', v_new_slug, 'from_template', p_template_id));
    END IF;
  END LOOP;

  -- Pass 2: fields, only for tables actually created this install
  FOR v_tbl IN SELECT * FROM template_definition_tables WHERE template_id = p_template_id LOOP
    SELECT installed_id INTO v_target_table_id FROM tmp_template_table_map WHERE source_id = v_tbl.id;
    SELECT resolution INTO v_resolution FROM company_template_table_map
      WHERE company_id = p_company_id AND template_id = p_template_id AND source_template_table_id = v_tbl.id;

    IF v_resolution = 'created' THEN
      FOR v_fld IN SELECT * FROM template_definition_table_fields WHERE template_table_id = v_tbl.id ORDER BY display_order LOOP
        v_linked_table_id := NULL;
        IF v_fld.linked_template_table_id IS NOT NULL THEN
          SELECT installed_id INTO v_linked_table_id FROM tmp_template_table_map WHERE source_id = v_fld.linked_template_table_id;
        END IF;

        -- formula/ledger: carry auto_number_prefix; formulas resolved in pass 3
        INSERT INTO company_table_fields (
          company_id, table_id, field_key, label, field_type, select_options,
          linked_table_id, linked_system_table, linked_display_field,
          is_required, is_unique, show_in_table, display_order, section_name, help_text,
          auto_number_prefix
        ) VALUES (
          p_company_id, v_target_table_id, v_fld.field_key, v_fld.label, v_fld.field_type, v_fld.select_options,
          v_linked_table_id, v_fld.linked_system_table, v_fld.linked_display_field,
          v_fld.is_required, v_fld.is_unique, v_fld.show_in_table, v_fld.display_order, v_fld.section_name, v_fld.help_text,
          v_fld.auto_number_prefix
        );
      END LOOP;
    END IF;
  END LOOP;

  -- formula/ledger Pass 3: resolve formula field keys to installed field ids.
  -- Only for created tables -- a 'used_existing' table keeps its own setup.
  FOR v_tbl IN SELECT * FROM template_definition_tables WHERE template_id = p_template_id LOOP
    SELECT installed_id INTO v_target_table_id FROM tmp_template_table_map WHERE source_id = v_tbl.id;
    SELECT resolution INTO v_resolution FROM company_template_table_map
      WHERE company_id = p_company_id AND template_id = p_template_id AND source_template_table_id = v_tbl.id;
    IF v_resolution IS DISTINCT FROM 'created' THEN CONTINUE; END IF;

    FOR v_fld IN SELECT * FROM template_definition_table_fields
      WHERE template_table_id = v_tbl.id AND formula_type IS NOT NULL LOOP

      -- For sum_related the a/relation keys live on the related table;
      -- for the arithmetic kinds they live on this table.
      IF v_fld.formula_type = 'sum_related' THEN
        SELECT m.installed_id INTO v_formula_table_id
          FROM template_definition_tables tt JOIN tmp_template_table_map m ON m.source_id = tt.id
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

  -- System fields (entities/projects/properties)
  FOR v_sf IN SELECT * FROM template_definition_system_fields WHERE template_id = p_template_id ORDER BY display_order LOOP
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
          jsonb_build_object('table_name', v_sf.table_name, 'field_key', v_new_key, 'from_template', p_template_id));
    END IF;
  END LOOP;

  -- Optional label overrides
  v_apply_overrides := COALESCE((p_resolutions->>'applyLabelOverrides')::boolean, false);
  IF v_apply_overrides THEN
    SELECT suggested_label_overrides INTO v_overrides FROM template_definitions WHERE id = p_template_id;
    IF v_overrides IS NOT NULL AND v_overrides <> '{}'::jsonb THEN
      UPDATE companies SET table_label_overrides = table_label_overrides || v_overrides WHERE id = p_company_id;
    END IF;
  END IF;

  INSERT INTO company_template_installs (company_id, template_id, installed_by, label_overrides_applied)
    VALUES (p_company_id, p_template_id, p_actor, v_apply_overrides)
    RETURNING id INTO v_install_id;

  INSERT INTO schema_change_log (company_id, actor_id, entity_type, entity_id, entity_label, action, after)
    VALUES (p_company_id, p_actor, 'company_template_install', v_install_id,
      (SELECT name FROM template_definitions WHERE id = p_template_id), 'create',
      jsonb_build_object('template_id', p_template_id));

  RETURN jsonb_build_object('status', 'installed', 'install_id', v_install_id, 'tables_created', v_tables_created, 'fields_created', v_fields_created);
END;
$$;
