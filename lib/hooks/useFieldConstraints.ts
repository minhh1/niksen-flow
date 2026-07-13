// lib/hooks/useFieldConstraints.ts
// Hook to check field constraints before saving records.
// Usage:
//   const { checkConstraint, checkConstraints } = useFieldConstraints(companyId, 'projects');
//   const result = await checkConstraint('custom:uuid', value, recordId);
//   if (!result.ok) toast.error(result.error);

import { useCallback } from 'react';
import { supabase } from '@/lib/supabase';

interface ConstraintResult {
  ok: boolean;
  error?: string;
  field?: string;
}

export function useFieldConstraints(companyId: string, tableName: string) {
  const checkConstraint = useCallback(async (
    fieldKey: string,
    value: string,
    excludeRecordId?: string
  ): Promise<ConstraintResult> => {
    if (!value?.trim()) return { ok: true };

    const { data, error } = await supabase.rpc('check_field_constraint', {
      p_company_id: companyId,
      p_table_name: tableName,
      p_field_key: fieldKey,
      p_value: value.trim(),
      p_exclude_record_id: excludeRecordId || null,
    });

    if (error) return { ok: true }; // fail open on DB error
    return data as ConstraintResult;
  }, [companyId, tableName]);

  // Check multiple fields at once — returns first violation found
  const checkConstraints = useCallback(async (
    fields: { key: string; value: string }[],
    excludeRecordId?: string
  ): Promise<ConstraintResult> => {
    for (const f of fields) {
      const result = await checkConstraint(f.key, f.value, excludeRecordId);
      if (!result.ok) return result;
    }
    return { ok: true };
  }, [checkConstraint]);

  return { checkConstraint, checkConstraints };
}