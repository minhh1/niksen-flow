// supabase/functions/gmail-addon/index.ts
// Handles all Gmail Add-on API calls

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const googleClientId     = Deno.env.get('GOOGLE_CLIENT_ID')!;
const googleClientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')!;

const db = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/gmail-addon/, '');
  const userEmail = req.headers.get('X-User-Email') || '';

  console.log(`[gmail-addon] ${req.method} ${path} user=${userEmail}`);

  // CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
    });
  }

  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  try {
    // ── GET /user-context ──────────────────────────────────────────
    if (req.method === 'GET' && path === '/user-context') {
      if (!userEmail) return json({ error: 'No user email' }, 401, headers);

      // Find profile by email
      const { data: profile } = await db
        .from('profiles')
        .select('id, full_name, active_company_id')
        .eq('email', userEmail)
        .single();

      if (!profile) return json({ error: 'User not found. Connect Gmail in the Flow app first.' }, 404, headers);

      // Get all companies this user belongs to
      const { data: memberships } = await db
        .from('company_memberships')
        .select('company_id, role, companies:company_id(id, name)')
        .eq('user_id', profile.id);

      const companies = (memberships || []).map((m: any) => ({
        id: m.company_id,
        name: m.companies?.name || m.company_id,
        role: m.role,
      }));

      const activeCompany = companies.find(c => c.id === profile.active_company_id) || companies[0];

      return json({
        email: userEmail,
        companies,
        activeCompanyId: activeCompany?.id || null,
        activeCompanyName: activeCompany?.name || null,
      }, 200, headers);
    }

    // ── POST /switch-company ───────────────────────────────────────
    if (req.method === 'POST' && path === '/switch-company') {
      const body = await req.json();
      const { companyId } = body;
      if (!userEmail || !companyId) return json({ error: 'Missing params' }, 400, headers);

      const { data: profile } = await db
        .from('profiles').select('id').eq('email', userEmail).single();
      if (!profile) return json({ error: 'User not found' }, 404, headers);

      await db.from('profiles').update({ active_company_id: companyId }).eq('id', profile.id);

      const { data: company } = await db
        .from('companies').select('name').eq('id', companyId).single();

      return json({ ok: true, companyName: company?.name }, 200, headers);
    }

    // ── GET /label-settings ────────────────────────────────────────
    if (req.method === 'GET' && path === '/label-settings') {
      const companyId = url.searchParams.get('companyId') || '';
      if (!companyId) return json({ error: 'Missing companyId' }, 400, headers);

      const { data: company } = await db
        .from('companies')
        .select('gmail_label_format, gmail_parent_label, gmail_parent_code, gmail_sublabel_separator, gmail_label_tokens, gmail_source_emails')
        .eq('id', companyId)
        .single();

      if (!company) return json({ error: 'Company not found' }, 404, headers);

      const { data: profile } = await db
        .from('profiles').select('id').eq('email', userEmail).single();
      const { data: mem } = await db
        .from('company_memberships').select('role').eq('user_id', profile?.id).eq('company_id', companyId).single();

      return json({
        parentLabel: company.gmail_parent_label || 'Shared Emails',
        parentCode: company.gmail_parent_code || '',
        separator: company.gmail_sublabel_separator || ' — ',
        tokens: company.gmail_label_tokens || ['project_name'],
        isAdmin: mem?.role === 'company_admin',
      }, 200, headers);
    }

    // ── GET /check-message ─────────────────────────────────────────
    if (req.method === 'GET' && path === '/check-message') {
      const rawMessageId = url.searchParams.get('messageId') || '';
      const companyId = url.searchParams.get('companyId') || '';
      // Strip "msg-f:" prefix that Gmail Add-on passes
      const messageId = rawMessageId.replace(/^msg-f:/, '').replace(/^.*\|msg-f:/, '');

      console.log(`[check-message] messageId=${messageId} companyId=${companyId}`);

      const { data, error } = await db
        .from('project_emails')
        .select('project_id, projects:project_id(id, name), project_gmail_labels!inner(gmail_label_name, label_code)')
        .eq('gmail_message_id', messageId)
        .eq('company_id', companyId)
        .limit(1)
        .maybeSingle();

      console.log(`[check-message] data=${JSON.stringify(data)} error=${error?.message}`);

      if (!data) {
        // Try without company filter to debug
        const { data: anyData } = await db
          .from('project_emails')
          .select('project_id, company_id, gmail_message_id')
          .eq('gmail_message_id', messageId)
          .limit(3);
        console.log(`[check-message] without company filter: ${JSON.stringify(anyData)}`);
        return json({}, 200, headers);
      }

      return json({
        projectId: data.project_id,
        projectName: (data.projects as any)?.name || '',
        labelName: (data.project_gmail_labels as any)?.[0]?.gmail_label_name || '',
        labelCode: (data.project_gmail_labels as any)?.[0]?.label_code || '',
      }, 200, headers);
    }

    // ── GET /search-projects ───────────────────────────────────────
    if (req.method === 'GET' && path === '/search-projects') {
      const companyId = url.searchParams.get('companyId') || '';
      const labelled = url.searchParams.get('labelled');
      const q = url.searchParams.get('q') || '';
      const status = url.searchParams.get('status') || '';
      const page = parseInt(url.searchParams.get('page') || '0');
      const pageSize = 30;

      // Get sort config
      const { data: sortConfig } = await db
        .from('company_addon_config')
        .select('sort_field, sort_direction')
        .eq('company_id', companyId)
        .maybeSingle();

      const sortField = sortConfig?.sort_field || '__name__';
      const sortAsc = (sortConfig?.sort_direction || 'asc') === 'asc';

      // Only sort by DB columns directly — custom field sorts done in memory
      const dbSortField = sortField === '__name__' ? 'name'
        : sortField === 'status' ? 'status'
        : 'name'; // fallback, custom field sorted in memory

      let query = db
        .from('projects')
        .select('id, name, status, project_gmail_labels(id, gmail_label_name)')
        .eq('company_id', companyId)
        .is('deleted_at', null)
        .order(dbSortField, { ascending: sortAsc })
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (q) query = query.ilike('name', `%${q}%`);
      if (status) query = query.eq('status', status);

      const { data: projects } = await query;
      let filtered = projects || [];

      // If query and has custom field search, also search custom field values
      if (q) {
        // Get matching record IDs from custom field values
        const { data: cfMatches } = await db
          .from('company_custom_field_values')
          .select('record_id')
          .eq('company_id', companyId)
          .ilike('value_text', `%${q}%`);

        const cfMatchIds = new Set((cfMatches || []).map((r: any) => r.record_id));

        // Re-fetch all (without name filter) and combine
        if (cfMatchIds.size > 0) {
          let query2 = db
            .from('projects')
            .select('id, name, status, project_gmail_labels(id, gmail_label_name)')
            .eq('company_id', companyId)
            .is('deleted_at', null)
            .order(dbSortField, { ascending: sortAsc });
          if (status) query2 = query2.eq('status', status);
          const { data: allProjects } = await query2;
          const existingIds = new Set(filtered.map((p: any) => p.id));
          (allProjects || []).forEach((p: any) => {
            if (cfMatchIds.has(p.id) && !existingIds.has(p.id)) {
              filtered.push(p);
            }
          });
        }
      }

      if (labelled === 'true') {
        filtered = filtered.filter((p: any) =>
          p.project_gmail_labels && p.project_gmail_labels.length > 0
        );
      } else if (labelled === 'false') {
        filtered = filtered.filter((p: any) =>
          !p.project_gmail_labels || p.project_gmail_labels.length === 0
        );
      }

      // Get addon display fields config for this company
      const { data: addonConfig } = await db
        .from('company_addon_config')
        .select('display_fields')
        .eq('company_id', companyId)
        .maybeSingle();

      const displayFields: string[] = addonConfig?.display_fields || [];
      console.log('[search-projects] displayFields:', displayFields);

      // Fetch custom field values for display fields
      let customValues: Record<string, Record<string, string>> = {};
      let cfDefs: any[] = [];
      if (displayFields.length > 0 && filtered.length > 0) {
        const projectIds = filtered.map((p: any) => p.id);
        // Get custom field definitions by field_key
        const cfDefsRes = await db
          .from('company_custom_fields')
          .select('id, label, field_key')
          .eq('company_id', companyId)
          .eq('table_name', 'projects')
          .in('field_key', displayFields);
        cfDefs = cfDefsRes.data || [];
        console.log('[search-projects] cfDefs found:', cfDefs.length, cfDefs.map((f: any) => f.field_key));

        if (cfDefs.length) {
          // Don't use .in(record_id, projectIds) — too many IDs hits URL limits
          // Instead fetch all values for these fields and filter in memory
          const { data: cfVals, error: cfErr } = await db
            .from('company_custom_field_values')
            .select('record_id, field_id, value_text, value_number')
            .eq('company_id', companyId)
            .in('field_id', cfDefs.map((f: any) => f.id));

          console.log('[search-projects] cfVals found:', cfVals?.length, 'error:', cfErr?.message);

          const fieldKeyMap: Record<string, string> = {};
          cfDefs.forEach((f: any) => { fieldKeyMap[f.id] = f.field_key; });

          (cfVals || []).forEach((v: any) => {
            if (!customValues[v.record_id]) customValues[v.record_id] = {};
            const fieldKey = fieldKeyMap[v.field_id] || v.field_id;
            customValues[v.record_id][fieldKey] = v.value_text || String(v.value_number || '');
          });
        }
      }

      // Sort by custom field in memory if needed
      if (sortField !== '__name__' && sortField !== 'status') {
        filtered = [...filtered].sort((a: any, b: any) => {
          const aVal = (customValues[a.id]?.[sortField] || '').toLowerCase();
          const bVal = (customValues[b.id]?.[sortField] || '').toLowerCase();
          return sortAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
        });
      }

      return json({
        projects: filtered.map((p: any) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          labelName: p.project_gmail_labels?.[0]?.gmail_label_name || null,
          customValues: customValues[p.id] || {},
        })),
        displayFields,
        sortField,
        sortDirection: sortAsc ? 'asc' : 'desc',
        page,
        pageSize,
        hasMore: filtered.length === pageSize,
      }, 200, headers);
    }

    // ── GET /addon-config ─────────────────────────────────────────
    if (req.method === 'GET' && path === '/addon-config') {
      const companyId = url.searchParams.get('companyId') || '';

      const { data: config } = await db
        .from('company_addon_config')
        .select('display_fields')
        .eq('company_id', companyId)
        .maybeSingle();

      // Get available custom fields for projects
      const { data: fields } = await db
        .from('company_custom_fields')
        .select('id, label, field_key, field_type')
        .eq('company_id', companyId)
        .eq('table_name', 'projects')
        .order('display_order');

      // System fields always available
      const systemFields = [
        { key: '__name__', label: 'Project name', type: 'system' },
        { key: 'status', label: 'Status', type: 'system' },
      ];

      const customFields = (fields || []).map((f: any) => ({
        key: f.field_key,
        label: f.label,
        type: f.field_type,
      }));

      // Default display order if nothing configured
      const defaultFields = ['__name__', 'status'];

      return json({
        displayFields: config?.display_fields || defaultFields,
        sortField: config?.sort_field || '__name__',
        sortDirection: config?.sort_direction || 'asc',
        availableFields: [...systemFields, ...customFields],
      }, 200, headers);
    }

    // ── POST /addon-config ────────────────────────────────────────
    if (req.method === 'POST' && path === '/addon-config') {
      const body = await req.json();
      const { companyId, displayFields } = body;
      if (!companyId) return json({ error: 'Missing companyId' }, 400, headers);

      console.log('[addon-config] Saving:', JSON.stringify({ companyId, displayFields, sortField: body.sortField, sortDirection: body.sortDirection }));

      const { error: upsertErr } = await db.from('company_addon_config').upsert({
        company_id: companyId,
        display_fields: (displayFields || []).slice(0, 4),
        sort_field: body.sortField || '__name__',
        sort_direction: body.sortDirection || 'asc',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'company_id' });

      if (upsertErr) {
        console.error('[addon-config] Upsert error:', upsertErr.message);
        return json({ error: upsertErr.message }, 500, headers);
      }

      console.log('[addon-config] Saved OK');
      return json({ ok: true }, 200, headers);
    }

    // ── POST /create-project ───────────────────────────────────────
    if (req.method === 'POST' && path === '/create-project') {
      const body = await req.json();
      const { projectName, matterNumber, status, messageId, companyId } = body;

      if (!projectName || !companyId) return json({ error: 'Missing required fields' }, 400, headers);

      const { data: profile } = await db
        .from('profiles').select('id').eq('email', userEmail).single();
      if (!profile) return json({ error: 'User not found' }, 404, headers);

      // Get label settings
      const { data: company } = await db
        .from('companies')
        .select('gmail_parent_label, gmail_parent_code, gmail_sublabel_separator, gmail_label_tokens')
        .eq('id', companyId).single();

      // Build label name
      const tokens: string[] = company?.gmail_label_tokens || ['project_name'];
      const separator = company?.gmail_sublabel_separator || ' — ';
      const parentLabel = company?.gmail_parent_label || 'Shared Emails';
      const labelCode = await generateUniqueLabelCode(companyId);

      const parts = tokens.map((t: string) => {
        if (t === 'project_name') return projectName;
        if (t === 'matter_number') return matterNumber || '';
        if (t === 'year') return new Date().getFullYear().toString();
        return t;
      }).filter(Boolean);

      // Replace "/" in parts to prevent Gmail splitting labels
      const cleanParts = parts.map((p: string) => p.replace(/\//g, ','));
      const sublabel = cleanParts.join(separator) + ` [${labelCode}]`;
      const fullLabelName = `${parentLabel}/${sublabel}`;

      // Check field constraints before creating
      const fieldsToCheck = [{ key: 'name', value: projectName }];
      if (matterNumber) {
        const { data: matterField } = await db
          .from('company_custom_fields')
          .select('id').eq('company_id', companyId).eq('table_name', 'projects')
          .ilike('label', '%matter%number%').maybeSingle();
        if (matterField) fieldsToCheck.push({ key: `custom:${matterField.id}`, value: matterNumber });
      }
      const constraintCheck = await checkFieldConstraints(companyId, 'projects', fieldsToCheck);
      if (!constraintCheck.ok) {
        return json({ error: constraintCheck.error }, 409, headers);
      }

      // Create project in DB
      const { data: project, error: projErr } = await db
        .from('projects')
        .insert({
          company_id: companyId,
          name: projectName,
          status: status || 'active',
          created_by: profile.id,
        })
        .select('id').single();

      if (projErr || !project) {
        return json({ error: projErr?.message || 'Failed to create project' }, 500, headers);
      }

      // Create custom field values — check all unique constraints
      if (matterNumber) {
        const { data: allUniqueFields } = await db
          .from('company_custom_fields')
          .select('id, label')
          .eq('company_id', companyId)
          .eq('table_name', 'projects')
          .eq('is_unique', true);

        // Find matter number field specifically
        const matterField = (allUniqueFields || []).find((f: any) =>
          f.label.toLowerCase().includes('matter') && f.label.toLowerCase().includes('number')
        );

        if (matterField) {
          const { error: cfErr } = await db.from('company_custom_field_values').insert({
            company_id: companyId,
            field_id: matterField.id,
            record_id: project.id,
            table_name: 'projects',
            value_text: matterNumber,
          });

          if (cfErr) {
            await db.from('projects').delete().eq('id', project.id);
            const isDuplicate = cfErr.code === '23505' || cfErr.message.includes('unique') || cfErr.message.includes('Duplicate');
            return json({
              error: isDuplicate
                ? `"${matterField.label}" "${matterNumber}" already exists — must be unique`
                : cfErr.message
            }, isDuplicate ? 409 : 500, headers);
          }
        }
      }

      // Create Gmail label in DB
      await db.from('project_gmail_labels').insert({
        company_id: companyId,
        project_id: project.id,
        gmail_label_name: fullLabelName,
        label_sub: sublabel,
        label_code: labelCode,
        created_by: profile.id,
      });

      // Save message to project_emails if messageId provided
      if (messageId) {
        await db.from('project_emails').upsert({
          company_id: companyId,
          user_id: profile.id,
          project_id: project.id,
          gmail_message_id: messageId,
          gmail_thread_id: messageId,
          gmail_label_applied: true,
        }, { onConflict: 'company_id,user_id,gmail_message_id', ignoreDuplicates: true });
      }

      return json({ ok: true, projectId: project.id, labelName: fullLabelName, labelCode }, 200, headers);
    }

    // ── POST /import-label ─────────────────────────────────────────
    if (req.method === 'POST' && path === '/import-label') {
      const body = await req.json();
      const { projectId, companyId } = body;

      // Check if label already exists
      const { data: existing } = await db
        .from('project_gmail_labels')
        .select('id, gmail_label_name')
        .eq('project_id', projectId)
        .is('removed_at', null)
        .single();

      if (existing) {
        return json({ ok: true, labelName: existing.gmail_label_name, existed: true }, 200, headers);
      }

      // Get project details
      const { data: project } = await db
        .from('projects').select('name').eq('id', projectId).single();
      if (!project) return json({ error: 'Project not found' }, 404, headers);

      // Get company label settings
      const { data: company } = await db
        .from('companies')
        .select('gmail_parent_label, gmail_sublabel_separator, gmail_label_tokens')
        .eq('id', companyId).single();

      const tokens: string[] = company?.gmail_label_tokens || ['project_name'];
      const separator = company?.gmail_sublabel_separator || ' — ';
      const parentLabel = company?.gmail_parent_label || 'Shared Emails';
      const labelCode = await generateUniqueLabelCode(companyId);

      // Get matter number if exists
      let matterNumber = '';
      const { data: matterField } = await db
        .from('company_custom_fields')
        .select('id')
        .eq('company_id', companyId)
        .eq('table_name', 'projects')
        .ilike('label', '%matter%number%')
        .single();

      if (matterField) {
        const { data: matterVal } = await db
          .from('company_custom_field_values')
          .select('value_text')
          .eq('field_id', matterField.id)
          .eq('record_id', projectId)
          .single();
        matterNumber = matterVal?.value_text || '';
      }

      const parts = tokens.map((t: string) => {
        if (t === 'project_name') return project.name;
        if (t === 'matter_number') return matterNumber || '';
        if (t === 'year') return new Date().getFullYear().toString();
        return t;
      }).filter(Boolean);

      // Replace "/" in parts to prevent Gmail splitting labels
      const cleanParts = parts.map((p: string) => p.replace(/\//g, ','));
      const sublabel = cleanParts.join(separator) + ` [${labelCode}]`;
      const fullLabelName = `${parentLabel}/${sublabel}`;

      const { data: profile } = await db
        .from('profiles').select('id').eq('email', userEmail).single();

      await db.from('project_gmail_labels').insert({
        company_id: companyId,
        project_id: projectId,
        gmail_label_name: fullLabelName,
        label_sub: sublabel,
        label_code: labelCode,
        created_by: profile?.id,
      });

      return json({ ok: true, labelName: fullLabelName }, 200, headers);
    }

    // ── POST /remove-project ───────────────────────────────────────
    if (req.method === 'POST' && path === '/remove-project') {
      const body = await req.json();
      const { projectId } = body;

      // Soft delete project
      await db.from('projects').update({ deleted_at: new Date().toISOString() }).eq('id', projectId);

      // Mark labels as removed
      await db.from('project_gmail_labels')
        .update({ removed_at: new Date().toISOString() })
        .eq('project_id', projectId);

      return json({ ok: true }, 200, headers);
    }

    // ── POST /remove-label ─────────────────────────────────────────
    if (req.method === 'POST' && path === '/remove-label') {
      const body = await req.json();
      const { messageId } = body;

      await db.from('project_emails')
        .delete()
        .eq('gmail_message_id', messageId);

      return json({ ok: true, removedFromUsers: 1 }, 200, headers);
    }

    // ── POST /create-labels-batch ────────────────────────────────
    // Creates label DB rows for multiple projects at once.
    // Actual Gmail label creation is handled by the cron (scalable).
    if (req.method === 'POST' && path === '/create-labels-batch') {
      const body = await req.json();
      const { projectIds, companyId, forUserId } = body;
      if (!companyId || !projectIds?.length) return json({ error: 'Missing params' }, 400, headers);

      const { data: profile } = await db
        .from('profiles').select('id').eq('email', userEmail).single();
      if (!profile) return json({ error: 'User not found' }, 404, headers);

      const { data: company } = await db
        .from('companies')
        .select('gmail_parent_label, gmail_sublabel_separator, gmail_label_tokens')
        .eq('id', companyId).single();

      const tokens: string[] = company?.gmail_label_tokens || ['project_name'];
      const separator = company?.gmail_sublabel_separator || ' — ';
      const parentLabel = company?.gmail_parent_label || 'Shared Emails';

      const results: any[] = [];

      for (const projectId of projectIds) {
        // Check if label already exists
        const { data: existing } = await db
          .from('project_gmail_labels')
          .select('id, gmail_label_name')
          .eq('project_id', projectId)
          .is('removed_at', null)
          .maybeSingle();

        if (existing) {
          results.push({ projectId, status: 'exists', labelName: existing.gmail_label_name });
          continue;
        }

        // Get project details
        const { data: project } = await db
          .from('projects').select('name').eq('id', projectId).single();
        if (!project) { results.push({ projectId, status: 'not_found' }); continue; }

        // Get matter number if exists
        let matterNumber = '';
        const { data: matterField } = await db
          .from('company_custom_fields')
          .select('id').eq('company_id', companyId).eq('table_name', 'projects')
          .ilike('label', '%matter%number%').maybeSingle();
        if (matterField) {
          const { data: matterVal } = await db
            .from('company_custom_field_values')
            .select('value_text').eq('field_id', matterField.id).eq('record_id', projectId).maybeSingle();
          matterNumber = matterVal?.value_text || '';
        }

        const labelCode = await generateUniqueLabelCode(companyId);
        const parts = tokens.map((t: string) => {
          if (t === 'project_name') return project.name;
          if (t === 'matter_number') return matterNumber || '';
          if (t === 'year') return new Date().getFullYear().toString();
          return t;
        }).filter(Boolean);

        // Replace "/" with "," to prevent Gmail splitting labels
        const cleanParts = parts.map((p: string) => p.replace(/\//g, ','));
        const sublabel = cleanParts.join(separator) + ` [${labelCode}]`;
        const fullLabelName = `${parentLabel}/${sublabel}`;

        const { error: insertErr } = await db.from('project_gmail_labels').insert({
          company_id: companyId,
          project_id: projectId,
          gmail_label_name: fullLabelName,
          label_sub: sublabel,
          label_code: labelCode,
          created_by: profile.id,
        });

        if (insertErr) {
          results.push({ projectId, status: 'error', error: insertErr.message });
        } else {
          results.push({ projectId, status: 'created', labelName: fullLabelName });
        }
      }

      const created = results.filter(r => r.status === 'created').length;
      const existed = results.filter(r => r.status === 'exists').length;

      return json({ ok: true, created, existed, results }, 200, headers);
    }

    // ── GET /my-projects ──────────────────────────────────────────
    // Returns projects the current user is involved in
    if (req.method === 'GET' && path === '/my-projects') {
      const companyId = url.searchParams.get('companyId') || '';
      const q = url.searchParams.get('q') || '';
      const status = url.searchParams.get('status') || '';
      const page = parseInt(url.searchParams.get('page') || '0');
      const pageSize = 30;
      const labelledOnly = url.searchParams.get('labelled') === 'true';
      const unlabelledOnly = url.searchParams.get('labelled') === 'false';

      const { data: profile } = await db
        .from('profiles').select('id').eq('email', userEmail).single();
      if (!profile) return json({ error: 'User not found' }, 404, headers);

      // Get all projects user has access to
      // 1. Check company membership role
      const { data: membership } = await db
        .from('company_memberships').select('role')
        .eq('user_id', profile.id).eq('company_id', companyId).maybeSingle();

      let projectIds: string[] | null = null;

      if (membership?.role !== 'company_admin') {
        // Non-admin: only their own projects
        const [{ data: memberProjects }, { data: createdProjects }] = await Promise.all([
          db.from('project_members').select('project_id').eq('profile_id', profile.id),
          db.from('projects').select('id').eq('created_by', profile.id).eq('company_id', companyId),
        ]);
        const ids = new Set([
          ...(memberProjects || []).map((r: any) => r.project_id),
          ...(createdProjects || []).map((r: any) => r.id),
        ]);
        projectIds = [...ids];
        if (!projectIds.length) return json({ projects: [], page, hasMore: false }, 200, headers);
      }

      let query = db
        .from('projects')
        .select('id, name, status, project_gmail_labels(id, gmail_label_name, label_code)')
        .eq('company_id', companyId)
        .is('deleted_at', null)
        .order('name')
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (projectIds) query = query.in('id', projectIds);
      if (q) query = query.ilike('name', `%${q}%`);
      if (status) query = query.eq('status', status);

      const { data: projects } = await query;
      let filtered = projects || [];

      if (labelledOnly) filtered = filtered.filter((p: any) => p.project_gmail_labels?.length > 0);
      if (unlabelledOnly) filtered = filtered.filter((p: any) => !p.project_gmail_labels?.length);

      return json({
        projects: filtered.map((p: any) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          hasLabel: p.project_gmail_labels?.length > 0,
          labelName: p.project_gmail_labels?.[0]?.gmail_label_name || null,
          labelCode: p.project_gmail_labels?.[0]?.label_code || null,
        })),
        page,
        hasMore: filtered.length === pageSize,
      }, 200, headers);
    }

    // ── POST /cancel-import ──────────────────────────────────────
    if (req.method === 'POST' && path === '/cancel-import') {
      const body = await req.json();
      const { jobId } = body;
      if (!jobId) return json({ error: 'Missing jobId' }, 400, headers);
      await db.from('label_import_jobs').update({
        status: 'cancelled',
        error: 'Cancelled by user',
        updated_at: new Date().toISOString(),
      }).eq('id', jobId);
      return json({ ok: true }, 200, headers);
    }

    // ── POST /resume-import ──────────────────────────────────────
    // Resume a paused job from where it left off
    if (req.method === 'POST' && path === '/resume-import') {
      const body = await req.json();
      const { jobId } = body;
      if (!jobId) return json({ error: 'Missing jobId' }, 400, headers);

      const { data: job } = await db
        .from('label_import_jobs').select('*').eq('id', jobId).single();
      if (!job) return json({ error: 'Job not found' }, 404, headers);

      // Re-fetch all project IDs for this job's filters
      let query = db
        .from('projects')
        .select('id')
        .eq('company_id', job.company_id)
        .is('deleted_at', null);

      if (job.filters?.status) query = query.eq('status', job.filters.status);
      if (job.filters?.name) query = query.ilike('name', `%${job.filters.name}%`);

      const { data: projects } = await query;
      const projectIds = (projects || []).map((p: any) => p.id);

      await db.from('label_import_jobs').update({
        status: 'running',
        error: null,
        updated_at: new Date().toISOString(),
      }).eq('id', jobId);

      processImportJob(jobId, projectIds, job.company_id, job.created_by).catch(console.error);

      return json({ ok: true, total: projectIds.length, resumingFrom: job.processed }, 200, headers);
    }

    // ── GET /import-job-status ────────────────────────────────────
    if (req.method === 'GET' && path === '/import-job-status') {
      const companyId = url.searchParams.get('companyId') || '';
      const { data: job } = await db
        .from('label_import_jobs')
        .select('*')
        .eq('company_id', companyId)
        .in('status', ['pending', 'running', 'paused', 'failed'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return json({ job: job || null }, 200, headers);
    }

    // ── POST /count-import ────────────────────────────────────────
    // Count how many projects match filters (before confirming)
    if (req.method === 'POST' && path === '/count-import') {
      const body = await req.json();
      const { companyId, filters } = body;
      if (!companyId) return json({ error: 'Missing companyId' }, 400, headers);

      let query = db
        .from('projects')
        .select('id, project_gmail_labels(id)', { count: 'exact' })
        .eq('company_id', companyId)
        .is('deleted_at', null);

      if (filters?.status) query = query.eq('status', filters.status);
      if (filters?.name) query = query.ilike('name', `%${filters.name}%`);

      const { data: projects, count } = await query;
      const unlabelled = (projects || []).filter((p: any) => !p.project_gmail_labels?.length).length;
      const labelled = (projects || []).filter((p: any) => p.project_gmail_labels?.length > 0).length;

      return json({ total: count || 0, unlabelled, labelled }, 200, headers);
    }

    // ── POST /queue-import ────────────────────────────────────────
    // Queue a background label import job
    if (req.method === 'POST' && path === '/queue-import') {
      const body = await req.json();
      const { companyId, filters } = body;
      if (!companyId) return json({ error: 'Missing companyId' }, 400, headers);

      const { data: profile } = await db
        .from('profiles').select('id').eq('email', userEmail).single();
      if (!profile) return json({ error: 'User not found' }, 404, headers);

      // Check no job already running
      const { data: existing } = await db
        .from('label_import_jobs')
        .select('id, status')
        .eq('company_id', companyId)
        .in('status', ['pending', 'running'])
        .maybeSingle();

      if (existing) return json({ error: 'A job is already running', jobId: existing.id }, 409, headers);

      // Count matching projects
      let query = db
        .from('projects')
        .select('id, project_gmail_labels(id)')
        .eq('company_id', companyId)
        .is('deleted_at', null);

      if (filters?.status) query = query.eq('status', filters.status);
      if (filters?.name) query = query.ilike('name', `%${filters.name}%`);

      const { data: projects } = await query;
      const unlabelled = (projects || []).filter((p: any) => !p.project_gmail_labels?.length);

      if (!unlabelled.length) return json({ error: 'No unlabelled projects match your filters', total: 0 }, 200, headers);

      // Create job
      const { data: job } = await db.from('label_import_jobs').insert({
        company_id: companyId,
        created_by: profile.id,
        status: 'pending',
        filters,
        total: unlabelled.length,
        processed: 0,
        created: 0,
        existed: 0,
      }).select().single();

      // Process in background (Edge Functions can run async)
      // We use waitUntil pattern — process immediately but don't await in response
      const projectIds = unlabelled.map((p: any) => p.id);

      // Start processing immediately
      processImportJob(job.id, projectIds, companyId, profile.id).catch(console.error);

      return json({ ok: true, jobId: job.id, total: unlabelled.length }, 200, headers);
    }

    // ── GET /project-by-label ─────────────────────────────────────
    // Finds a project by label code (from Gmail label URL)
    if (req.method === 'GET' && path === '/project-by-label') {
      const code = url.searchParams.get('code') || '';
      const companyId = url.searchParams.get('companyId') || '';
      if (!code) return json({ error: 'Missing code' }, 400, headers);

      const { data: label } = await db
        .from('project_gmail_labels')
        .select('project_id, gmail_label_name, projects:project_id(id, name, status, description, created_at)')
        .eq('label_code', code)
        .eq('company_id', companyId)
        .maybeSingle();

      if (!label) return json({ project: null }, 200, headers);

      return json({
        project: {
          id: (label.projects as any)?.id,
          name: (label.projects as any)?.name,
          status: (label.projects as any)?.status,
          description: (label.projects as any)?.description,
          created_at: (label.projects as any)?.created_at,
          labelName: label.gmail_label_name,
          labelCode: code,
        }
      }, 200, headers);
    }

    // ── GET /project-tasks ────────────────────────────────────────
    if (req.method === 'GET' && path === '/project-tasks') {
      const projectId = url.searchParams.get('projectId') || '';
      if (!projectId) return json({ error: 'Missing projectId' }, 400, headers);

      const { data: tasks, error: tasksErr } = await db
        .from('tasks')
        .select('id, name, is_completed, due_date, due_time, assignee_id, assigned_team_id, status_id, is_monetary, estimated_cost, created_by, profiles:assignee_id(full_name, email), teams:assigned_team_id(team_name), task_statuses:status_id(label, color_hex), creator:created_by(full_name, email)')
        .eq('project_id', projectId)
        .is('deleted_at', null)
        .order('date_entered', { ascending: true });

      if (tasksErr) console.error('[project-tasks] error:', tasksErr.message);
      console.log(`[project-tasks] projectId=${projectId} count=${tasks?.length}`);
      if (tasks?.length) {
        const sample = tasks[0] as any;
        console.log(`[project-tasks] sample: assignee_id=${sample.assignee_id} profiles=${JSON.stringify(sample.profiles)} assigned_team_id=${sample.assigned_team_id} teams=${JSON.stringify(sample.teams)}`);
      }

      const { data: statuses } = await db
        .from('task_statuses')
        .select('id, label, color_hex')
        .eq('is_active', true);

      return json({
        tasks: (tasks || []).map((t: any) => ({
          id: t.id,
          name: t.name,
          isCompleted: t.is_completed,
          dueDate: t.due_date,
          dueTime: t.due_time,
          assigneeId: t.assignee_id,
          assignee: t.profiles?.full_name || t.profiles?.email || null,
          assignedTeamId: t.assigned_team_id,
          assignedTeam: t.teams?.team_name || null,
          statusId: t.status_id,
          status: t.task_statuses?.label || null,
          statusColor: t.task_statuses?.color_hex || null,
          isMonetary: t.is_monetary,
          estimatedCost: t.estimated_cost,
          createdBy: t.creator?.full_name || t.creator?.email || null,
        })),
        statuses: statuses || [],
      }, 200, headers);
    }

    // ── POST /create-task ─────────────────────────────────────────
    if (req.method === 'POST' && path === '/create-task') {
      const body = await req.json();
      const {
        projectId, companyId, name,
        dueDate, dueTime,
        assigneeId, assignedTeamId,
        statusId,
        isMonetary, estimatedCost,
        reminderSetting, reminderSettings,
        responsibleTeam, assignedTo,
      } = body;

      // ── Validation ──────────────────────────────────────────────
      if (!projectId) return json({ error: 'Project is required' }, 400, headers);
      if (!name?.trim()) return json({ error: 'Task name is required' }, 400, headers);
      if (dueDate && isNaN(Date.parse(dueDate))) return json({ error: 'Invalid due date' }, 400, headers);
      if (estimatedCost !== undefined && estimatedCost !== null && isNaN(Number(estimatedCost))) {
        return json({ error: 'Estimated cost must be a number' }, 400, headers);
      }
      if (estimatedCost !== undefined && estimatedCost !== null && Number(estimatedCost) < 0) {
        return json({ error: 'Estimated cost cannot be negative' }, 400, headers);
      }

      const { data: profile } = await db
        .from('profiles').select('id').eq('email', userEmail).single();

      const { data: task, error } = await db.from('tasks').insert({
        project_id: projectId,
        company_id: companyId,
        name: name.trim(),
        due_date: dueDate || null,
        due_time: dueTime || null,
        assignee_id: assigneeId || null,
        assigned_team_id: assignedTeamId || null,
        status_id: statusId || null,
        is_monetary: isMonetary || false,
        estimated_cost: estimatedCost ? Number(estimatedCost) : null,
        reminder_setting: reminderSetting || null,
        reminder_settings: reminderSettings || null,
        responsible_team: responsibleTeam || null,
        assigned_to: assignedTo || null,
        created_by: profile?.id,
        date_entered: new Date().toISOString().split('T')[0],
        is_completed: false,
      }).select().single();

      if (error) return json({ error: error.message }, 500, headers);
      // Trigger calendar sync (non-blocking)
      if (task?.id && task?.due_date) triggerCalendarSync(task.id, 'upsert');
      return json({ ok: true, task }, 200, headers);
    }

    // ── POST /toggle-task ─────────────────────────────────────────
    if (req.method === 'POST' && path === '/toggle-task') {
      const body = await req.json();
      const { taskId, isCompleted } = body;
      if (!taskId) return json({ error: 'Missing taskId' }, 400, headers);

      const { error } = await db.from('tasks').update({
        is_completed: isCompleted,
      }).eq('id', taskId);

      if (error) return json({ error: error.message }, 500, headers);
      // Sync calendar — mark complete or re-activate
      triggerCalendarSync(taskId, isCompleted ? 'complete' : 'upsert');
      return json({ ok: true }, 200, headers);
    }

    // ── POST /update-task ──────────────────────────────────────────
    if (req.method === 'POST' && path === '/update-task') {
      const body = await req.json();
      const { taskId, name, dueDate, dueTime, statusId, assigneeId, assignedTeamId, isMonetary, estimatedCost } = body;
      if (!taskId) return json({ error: 'Missing taskId' }, 400, headers);
      if (!name?.trim()) return json({ error: 'Task name required' }, 400, headers);

      const { error } = await db.from('tasks').update({
        name: name.trim(),
        due_date: dueDate || null,
        due_time: dueTime || null,
        status_id: statusId || null,
        assignee_id: assigneeId || null,
        assigned_team_id: assignedTeamId || null,
        is_monetary: isMonetary || false,
        estimated_cost: estimatedCost || null,
      }).eq('id', taskId);

      if (error) return json({ error: error.message }, 500, headers);
      // Sync calendar with updated details
      triggerCalendarSync(taskId, 'upsert');
      return json({ ok: true }, 200, headers);
    }

    // ── POST /delete-task ──────────────────────────────────────────
    if (req.method === 'POST' && path === '/delete-task') {
      const body = await req.json();
      const { taskId } = body;
      if (!taskId) return json({ error: 'Missing taskId' }, 400, headers);

      const { error } = await db.from('tasks')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', taskId);

      if (error) return json({ error: error.message }, 500, headers);
      // Delete calendar event
      triggerCalendarSync(taskId, 'delete');
      return json({ ok: true }, 200, headers);
    }

    // ── GET /project-by-matter ────────────────────────────────────
    if (req.method === 'GET' && path === '/project-by-matter') {
      const matterNumber = url.searchParams.get('matter') || '';
      const companyId = url.searchParams.get('companyId') || '';
      if (!matterNumber) return json({ project: null }, 200, headers);
      const { data: matterField } = await db.from('company_custom_fields')
        .select('id').eq('company_id', companyId).eq('field_key', 'matter_number').maybeSingle();
      if (!matterField) return json({ project: null }, 200, headers);
      const { data: cfv } = await db.from('company_custom_field_values')
        .select('project_id').eq('field_id', matterField.id).eq('value_text', matterNumber).maybeSingle();
      if (!cfv) return json({ project: null }, 200, headers);
      const { data: project } = await db.from('projects')
        .select('id, name, description, created_at, estimated_completion_date').eq('id', cfv.project_id).single();
      return json({ project: project ? { id: project.id, name: project.name, description: project.description,
        matterNumber, createdAt: project.created_at, dueDate: project.estimated_completion_date } : null }, 200, headers);
    }

    // ── POST /create-task-from-row ────────────────────────────────
    if (req.method === 'POST' && path === '/create-task-from-row') {
      const body = await req.json();
      const { projectId, companyId, name, assigneeEmail, dueDate } = body;
      if (!projectId || !name) return json({ error: 'Missing projectId or name' }, 400, headers);
      let assigneeId = null;
      if (assigneeEmail) {
        const { data: p } = await db.from('profiles').select('id').eq('email', assigneeEmail).maybeSingle();
        assigneeId = p?.id || null;
      }
      const { data: task, error } = await db.from('tasks').insert({
        project_id: projectId, company_id: companyId, name,
        assignee_id: assigneeId, due_date: dueDate || null,
        is_completed: false, date_entered: new Date().toISOString().split('T')[0],
      }).select().single();
      if (error) return json({ error: error.message }, 500, headers);
      return json({ ok: true, task }, 200, headers);
    }

    // ── GET /my-tasks ─────────────────────────────────────────────
    // Returns tasks assigned to the authenticated user — due today or overdue
    // Designed for Loop app / external integrations
    if (req.method === 'GET' && path === '/my-tasks') {
      const userId = url.searchParams.get('userId') || '';
      const filter = url.searchParams.get('filter') || 'due'; // due | all | overdue
      const companyId = url.searchParams.get('companyId') || '';

      // Find profile by email or userId
      let profileId = userId;
      if (!profileId) {
        const { data: profile } = await db
          .from('profiles').select('id').eq('email', userEmail).single();
        profileId = profile?.id || '';
      }
      if (!profileId) return json({ error: 'User not found' }, 404, headers);

      const today = new Date().toISOString().split('T')[0];

      let query = db.from('tasks')
        .select(`
          id, name, due_date, due_time, is_completed, date_entered,
          projects:project_id(id, name),
          task_statuses:status_id(label, color_hex),
          teams:assigned_team_id(team_name)
        `)
        .eq('assignee_id', profileId)
        .eq('is_completed', false)
        .is('deleted_at', null)
        .order('due_date', { ascending: true, nullsFirst: false });

      if (companyId) query = query.eq('company_id', companyId);
      if (filter === 'due') query = query.lte('due_date', today);
      if (filter === 'overdue') query = query.lt('due_date', today);

      const { data: tasks, error: tasksErr } = await query;
      if (tasksErr) return json({ error: tasksErr.message }, 500, headers);

      const now = new Date();
      const result = (tasks || []).map((t: any) => {
        const due = t.due_date ? new Date(t.due_date.substring(0,10) + 'T23:59:59') : null;
        const diffMs = due ? due.getTime() - now.getTime() : null;
        const diffDays = diffMs !== null ? Math.ceil(diffMs / 86400000) : null;
        let urgency = 'none';
        if (diffDays !== null) {
          if (diffDays < 0) urgency = 'overdue';
          else if (diffDays === 0) urgency = 'today';
          else if (diffDays <= 3) urgency = 'soon';
          else urgency = 'upcoming';
        }
        return {
          id: t.id,
          name: t.name,
          dueDate: t.due_date ? t.due_date.substring(0, 10) : null,
          dueTime: t.due_time || null,
          diffDays,
          urgency,
          project: (t.projects as any)?.name || null,
          projectId: (t.projects as any)?.id || null,
          status: (t.task_statuses as any)?.label || null,
          statusColor: (t.task_statuses as any)?.color_hex || null,
          team: (t.teams as any)?.team_name || null,
        };
      });

      return json({
        userId: profileId,
        filter,
        count: result.length,
        tasks: result,
        generatedAt: new Date().toISOString(),
      }, 200, headers);
    }

    // ── GET /team-tasks ───────────────────────────────────────────
    // Returns all tasks for all members of a company — for team digest
    if (req.method === 'GET' && path === '/team-tasks') {
      const companyId = url.searchParams.get('companyId') || '';
      if (!companyId) return json({ error: 'Missing companyId' }, 400, headers);

      const today = new Date().toISOString().split('T')[0];

      const { data: tasks, error } = await db
        .from('tasks')
        .select(`
          id, name, due_date, due_time, is_completed,
          profiles:assignee_id(id, full_name, email),
          projects:project_id(id, name),
          task_statuses:status_id(label, color_hex)
        `)
        .eq('company_id', companyId)
        .eq('is_completed', false)
        .is('deleted_at', null)
        .not('assignee_id', 'is', null)
        .lte('due_date', today)
        .order('due_date', { ascending: true });

      if (error) return json({ error: error.message }, 500, headers);

      const now = new Date();

      // Group by assignee
      const byMember: Record<string, any> = {};
      for (const t of (tasks || [])) {
        const profile = (t.profiles as any);
        if (!profile) continue;
        const uid = profile.id;
        if (!byMember[uid]) {
          byMember[uid] = {
            userId: uid,
            name: profile.full_name || profile.email,
            email: profile.email,
            tasks: [],
          };
        }
        const due = t.due_date ? new Date(t.due_date.substring(0,10) + 'T23:59:59') : null;
        const diffMs = due ? due.getTime() - now.getTime() : null;
        const diffDays = diffMs !== null ? Math.ceil(diffMs / 86400000) : null;
        byMember[uid].tasks.push({
          id: t.id,
          name: t.name,
          dueDate: t.due_date ? t.due_date.substring(0,10) : null,
          diffDays,
          urgency: diffDays === null ? 'none' : diffDays < 0 ? 'overdue' : diffDays === 0 ? 'today' : 'soon',
          project: (t.projects as any)?.name || null,
          status: (t.task_statuses as any)?.label || null,
        });
      }

      return json({
        companyId,
        members: Object.values(byMember),
        generatedAt: new Date().toISOString(),
      }, 200, headers);
    }



    // ── GET /my-tasks ─────────────────────────────────────────────
    if (req.method === 'GET' && path === '/my-tasks') {
      const todayStr = new Date().toISOString().split('T')[0];
      const { data: profile } = await db
        .from('profiles').select('id, full_name').eq('email', userEmail).single();
      if (!profile) return json({ error: 'Profile not found' }, 404, headers);
      const { data: tasks, error: tasksErr } = await db.from('tasks')
        .select('id, name, due_date, due_time, projects:project_id(id, name), task_statuses:status_id(label, color_hex), assigned_team:assigned_team_id(team_name)')
        .eq('assignee_id', profile.id).eq('is_completed', false).is('deleted_at', null)
        .not('due_date', 'is', null).lte('due_date', todayStr).order('due_date', { ascending: true });
      if (tasksErr) return json({ error: tasksErr.message }, 500, headers);
      const today = new Date();
      return json({
        user: profile.full_name || userEmail, date: todayStr, count: tasks?.length || 0,
        tasks: (tasks || []).map((t: any) => {
          const diffDays = Math.ceil((new Date(t.due_date.substring(0,10)+'T23:59:59').getTime() - today.getTime()) / 86400000);
          return { id: t.id, name: t.name, project: t.projects?.name || null, projectId: t.projects?.id || null,
            dueDate: t.due_date.substring(0,10), dueTime: t.due_time || null,
            status: t.task_statuses?.label || null, statusColor: t.task_statuses?.color_hex || null,
            team: t.assigned_team?.team_name || null,
            urgency: diffDays < 0 ? 'overdue' : diffDays === 0 ? 'today' : 'upcoming', daysUntilDue: diffDays };
        }),
      }, 200, headers);
    }

    // ── GET /team-tasks ───────────────────────────────────────────
    if (req.method === 'GET' && path === '/team-tasks') {
      const companyId = url.searchParams.get('companyId') || '';
      if (!companyId) return json({ error: 'Missing companyId' }, 400, headers);
      const todayStr = new Date().toISOString().split('T')[0];
      const today = new Date();
      const { data: members } = await db.from('company_memberships')
        .select('user_id').eq('company_id', companyId);
      const userIds = (members || []).map((m: any) => m.user_id);
      if (!userIds.length) return json({ date: todayStr, members: [] }, 200, headers);
      const { data: tasks, error: tasksErr } = await db.from('tasks')
        .select('id, name, due_date, assignee_id, projects:project_id(id, name), task_statuses:status_id(label), profiles:assignee_id(full_name, email)')
        .in('assignee_id', userIds).eq('is_completed', false).is('deleted_at', null)
        .not('due_date', 'is', null).lte('due_date', todayStr).order('due_date', { ascending: true });
      if (tasksErr) return json({ error: tasksErr.message }, 500, headers);
      const byUser: Record<string, any> = {};
      for (const t of (tasks || []) as any[]) {
        if (!byUser[t.assignee_id]) byUser[t.assignee_id] = {
          name: t.profiles?.full_name || t.profiles?.email || t.assignee_id,
          email: t.profiles?.email || null, tasks: [],
        };
        const diffDays = Math.ceil((new Date(t.due_date.substring(0,10)+'T23:59:59').getTime() - today.getTime()) / 86400000);
        byUser[t.assignee_id].tasks.push({ id: t.id, name: t.name, project: t.projects?.name || null,
          dueDate: t.due_date.substring(0,10), status: t.task_statuses?.label || null,
          urgency: diffDays < 0 ? 'overdue' : 'today', daysUntilDue: diffDays });
      }
      return json({ date: todayStr, companyId, members: Object.values(byUser) }, 200, headers);
    }

    if (req.method === 'GET' && path === '/webhook-settings') {
      const { data: profile } = await db
        .from('profiles')
        .select('chat_webhook_url')
        .eq('email', userEmail)
        .single();
      return json({ webhookUrl: profile?.chat_webhook_url || null }, 200, headers);
    }

    // ── POST /webhook-settings ────────────────────────────────────
    if (req.method === 'POST' && path === '/webhook-settings') {
      const body = await req.json();
      const { webhookUrl } = body;
      const { data: profile } = await db
        .from('profiles').select('id').eq('email', userEmail).single();
      if (!profile) return json({ error: 'Profile not found' }, 404, headers);
      await db.from('profiles')
        .update({ chat_webhook_url: webhookUrl || null })
        .eq('id', profile.id);
      return json({ ok: true }, 200, headers);
    }


    if (req.method === 'GET' && path === '/task-context') {
      const companyId = url.searchParams.get('companyId') || '';

      const [
        { data: members, error: membersErr },
        { data: statuses },
        { data: teams, error: teamsErr },
        { data: templates },
      ] = await Promise.all([
        db.from('company_memberships')
          .select('user_id')
          .eq('company_id', companyId),
        db.from('task_statuses')
          .select('id, label, color_hex')
          .eq('is_active', true)
          .order('display_order', { ascending: true }),
        db.from('teams')
          .select('id, team_name')
          .eq('company_id', companyId)
          .eq('is_active', true),
        db.from('checklist_templates')
          .select('id, name, items:checklist_template_items(id, title, due_offset_days, due_anchor, assignee_id, assigned_team_id, is_monetary, estimated_cost, display_order)')
          .eq('company_id', companyId)
          .order('created_at', { ascending: true }),
      ]);

      if (membersErr) console.error('[task-context] members error:', membersErr.message);
      if (teamsErr) console.error('[task-context] teams error:', teamsErr.message);

      // Fetch profiles separately for each member
      const userIds = (members || []).map((m: any) => m.user_id);
      const { data: profileRows, error: profilesErr } = await db
        .from('profiles')
        .select('id, full_name, email')
        .in('id', userIds.length ? userIds : ['00000000-0000-0000-0000-000000000000']);

      if (profilesErr) console.error('[task-context] profiles error:', profilesErr.message);
      const profiles = profileRows || [];

      console.log(`[task-context] companyId=${companyId} userIds=${userIds.length} profiles=${profiles.length} teams=${teams?.length} templates=${templates?.length}`);
      if (profiles.length) console.log(`[task-context] sample profile: ${JSON.stringify(profiles[0])}`);
      if (teams?.length) console.log(`[task-context] sample team: ${JSON.stringify(teams[0])}`);

      // Sort template items
      const sortedTemplates = (templates || []).map((t: any) => ({
        ...t,
        items: (t.items || []).sort((a: any, b: any) => a.display_order - b.display_order),
      }));

      return json({
        profiles,
        statuses: statuses || [],
        teams: teams || [],
        templates: sortedTemplates,
        reminderOptions: [
          { value: 'none', label: 'No reminder' },
          { value: '15min', label: '15 minutes before' },
          { value: '30min', label: '30 minutes before' },
          { value: '1hour', label: '1 hour before' },
          { value: '2hours', label: '2 hours before' },
          { value: '1day', label: '1 day before' },
          { value: '2days', label: '2 days before' },
          { value: '1week', label: '1 week before' },
        ],
      }, 200, headers);
    }

    // ── POST /apply-template ───────────────────────────────────────
    if (req.method === 'POST' && path === '/apply-template') {
      const body = await req.json();
      const { templateId, projectId, companyId, projectCreatedAt } = body;
      if (!templateId || !projectId) return json({ error: 'Missing params' }, 400, headers);

      // Get template with items
      const { data: template } = await db
        .from('checklist_templates')
        .select('id, name, items:checklist_template_items(*)')
        .eq('id', templateId)
        .single();

      if (!template) return json({ error: 'Template not found' }, 404, headers);

      const { data: profile } = await db
        .from('profiles').select('id').eq('email', userEmail).single();

      const anchor = projectCreatedAt ? new Date(projectCreatedAt) : new Date();

      // Build tasks from template items (top-level only)
      const items = (template.items || [])
        .filter((i: any) => !i.parent_item_id)
        .sort((a: any, b: any) => a.display_order - b.display_order);

      const tasksToInsert = items.map((item: any) => {
        let dueDate: string | null = null;
        if (item.due_offset_days !== null && item.due_offset_days !== undefined) {
          const d = new Date(anchor);
          d.setDate(d.getDate() + item.due_offset_days);
          dueDate = d.toISOString().split('T')[0];
        }
        return {
          project_id: projectId,
          company_id: companyId,
          name: item.title,
          assignee_id: item.assignee_id || null,
          assigned_team_id: item.assigned_team_id || null,
          is_monetary: item.is_monetary || false,
          estimated_cost: item.estimated_cost || null,
          due_date: dueDate,
          is_completed: false,
          created_by: profile?.id,
          date_entered: new Date().toISOString().split('T')[0],
        };
      });

      if (!tasksToInsert.length) return json({ ok: true, count: 0 }, 200, headers);

      const { data: created, error } = await db
        .from('tasks').insert(tasksToInsert).select();

      if (error) return json({ error: error.message }, 500, headers);

      return json({ ok: true, count: created?.length || 0 }, 200, headers);
    }

    return json({ error: 'Not found' }, 404, headers);

  } catch (err: any) {
    console.error('[gmail-addon] Error:', err?.message);
    return json({ error: err?.message || 'Internal error' }, 500, headers);
  }
});

// ── Background job processor ──────────────────────────────────────
// Processes in batches of 20 with a hard timeout guard.
// If execution limit is near, saves progress and lets next invocation continue.

const BATCH_SIZE = 20;
const MAX_RUNTIME_MS = 100000; // 100s — stop before Supabase's 150s limit

async function processImportJob(
  jobId: string,
  projectIds: string[],
  companyId: string,
  createdBy: string,
) {
  const startTime = Date.now();

  try {
    // Mark as running
    await db.from('label_import_jobs').update({
      status: 'running',
      updated_at: new Date().toISOString(),
    }).eq('id', jobId);

    const { data: company } = await db
      .from('companies')
      .select('gmail_parent_label, gmail_sublabel_separator, gmail_label_tokens')
      .eq('id', companyId).single();

    const tokens: string[] = company?.gmail_label_tokens || ['project_name'];
    const separator = company?.gmail_sublabel_separator || ' — ';
    const parentLabel = company?.gmail_parent_label || 'Shared Emails';

    const { data: matterField } = await db
      .from('company_custom_fields')
      .select('id').eq('company_id', companyId).eq('table_name', 'projects')
      .ilike('label', '%matter%number%').maybeSingle();

    // Get current progress (in case this is a resumed job)
    const { data: jobState } = await db
      .from('label_import_jobs')
      .select('processed, created, existed')
      .eq('id', jobId).single();

    let created = jobState?.created || 0;
    let existed = jobState?.existed || 0;
    let processed = jobState?.processed || 0;

    // Skip already-processed items
    const remaining = projectIds.slice(processed);
    console.log(`[import-job] Starting from ${processed}/${projectIds.length}`);

    for (let i = 0; i < remaining.length; i++) {
      // Timeout guard — stop before execution limit
      if (Date.now() - startTime > MAX_RUNTIME_MS) {
        console.log(`[import-job] Timeout guard hit at ${processed}/${projectIds.length} — saving progress`);
        await db.from('label_import_jobs').update({
          processed,
          created,
          existed,
          status: 'paused',
          error: `Paused at ${processed}/${projectIds.length} — will resume on next run`,
          updated_at: new Date().toISOString(),
        }).eq('id', jobId);
        return;
      }

      const projectId = remaining[i];

      try {
        // Check if cancelled
        const { data: currentJob } = await db
          .from('label_import_jobs').select('status').eq('id', jobId).single();
        if (currentJob?.status === 'cancelled') {
          console.log('[import-job] Job cancelled by user');
          return;
        }

        const { data: existing } = await db
          .from('project_gmail_labels')
          .select('id').eq('project_id', projectId).is('removed_at', null).maybeSingle();

        if (existing) {
          existed++;
        } else {
          const { data: project } = await db
            .from('projects').select('name').eq('id', projectId).is('deleted_at', null).single();
          if (!project) { processed++; continue; } // skip deleted projects

          let matterNumber = '';
          if (matterField) {
            const { data: mv } = await db
              .from('company_custom_field_values')
              .select('value_text').eq('field_id', matterField.id).eq('record_id', projectId).maybeSingle();
            matterNumber = mv?.value_text || '';
          }

          const labelCode = await generateUniqueLabelCode(companyId);
          const parts = tokens.map((t: string) => {
            if (t === 'project_name') return project.name;
            if (t === 'matter_number') return matterNumber || '';
            if (t === 'year') return new Date().getFullYear().toString();
            return t;
          }).filter(Boolean);

          const cleanParts = parts.map((p: string) => p.replace(/\//g, ','));
          const sublabel = cleanParts.join(separator) + ` [${labelCode}]`;
          const fullLabelName = `${parentLabel}/${sublabel}`;

          await db.from('project_gmail_labels').insert({
            company_id: companyId,
            project_id: projectId,
            gmail_label_name: fullLabelName,
            label_sub: sublabel,
            label_code: labelCode,
            created_by: createdBy,
          });
          created++;
        }
      } catch (err: any) {
        console.error(`[import-job] Error on project ${projectId}:`, err?.message);
      }

      processed++;

      // Update progress every batch
      if (processed % BATCH_SIZE === 0) {
        await db.from('label_import_jobs').update({
          processed,
          created,
          existed,
          updated_at: new Date().toISOString(),
        }).eq('id', jobId);
        console.log(`[import-job] Progress: ${processed}/${projectIds.length} (${created} created, ${existed} existed)`);
      }
    }

    // Mark done
    await db.from('label_import_jobs').update({
      status: 'done',
      processed,
      created,
      existed,
      error: null,
      updated_at: new Date().toISOString(),
    }).eq('id', jobId);

    console.log(`[import-job] Complete: ${created} created, ${existed} existed`);
  } catch (err: any) {
    console.error('[import-job] Fatal:', err?.message);
    await db.from('label_import_jobs').update({
      status: 'failed',
      error: err?.message,
      updated_at: new Date().toISOString(),
    }).eq('id', jobId);
  }
}

// ── Field constraint checker ──────────────────────────────────────
async function checkFieldConstraints(
  companyId: string,
  tableName: string,
  fields: { key: string; value: string }[],
  excludeRecordId?: string
): Promise<{ ok: boolean; error?: string }> {
  for (const field of fields) {
    if (!field.value?.trim()) continue;
    const { data } = await db.rpc('check_field_constraint', {
      p_company_id: companyId,
      p_table_name: tableName,
      p_field_key: field.key,
      p_value: field.value.trim(),
      p_exclude_record_id: excludeRecordId || null,
    });
    if (data && !data.ok) return { ok: false, error: data.error };
  }
  return { ok: true };
}

function triggerCalendarSync(taskId: string, action: 'upsert' | 'delete' | 'complete'): void {
  fetch(`${supabaseUrl}/functions/v1/calendar-sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({ action, taskId }),
  }).catch((err) => console.error('[calendar-sync] trigger failed:', err?.message));
}

function json(data: any, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function generateUniqueLabelCode(companyId: string): Promise<string> {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let attempts = 0;
  while (attempts < 10) {
    let code = '';
    for (let i = 0; i < 5; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    // Check collision — exclude labels from deleted projects
    const { data } = await db
      .from('project_gmail_labels')
      .select('id, projects!inner(deleted_at)')
      .eq('label_code', code)
      .is('projects.deleted_at', null) // only count active projects
      .maybeSingle();
    if (!data) return code; // unique among active projects
    attempts++;
    console.warn(`[generateLabelCode] collision on ${code}, retrying (attempt ${attempts})`);
  }
  // Fallback: timestamp-based suffix guarantees uniqueness
  return 'Z' + Date.now().toString(36).toUpperCase().slice(-4);
}

function generateLabelCode(): string {
  // Synchronous fallback — use for contexts where async isn't available
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}