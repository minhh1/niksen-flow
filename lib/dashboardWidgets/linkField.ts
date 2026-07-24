import type { CustomTableField } from "@/lib/hooks/useCustomTable";

export type ParentSystemTable = 'projects' | 'properties' | 'entities';

const FIELD_TYPE_BY_SYSTEM_TABLE: Record<ParentSystemTable, string> = {
  projects: 'project',
  properties: 'property',
  entities: 'entity',
};

// Fields on a linked custom table that could plausibly be "the" field that
// points back at a record-dashboard tab's parent record -- used by both
// GridTabEditor and RecordDashboardTab to auto-detect (and, when ambiguous,
// let an admin manually pick) which field to filter/link by.
//
// Scoped to the parent's own system table when known: a tab on a PROJECT
// record only offers project-relation fields, not some unrelated
// entity-relation field (e.g. "Staff") that happens to sit on the same
// linked table -- lumping every relation-ish field together made a table
// with exactly one project field but also an entity field look ambiguous
// (2 "candidates") even though only one of them could ever actually match
// this parent, which is why auto-detection was silently failing before this
// existed.
export function relationCandidates(
  fields: CustomTableField[],
  parentSystemTable?: ParentSystemTable
): CustomTableField[] {
  if (parentSystemTable) {
    const fieldType = FIELD_TYPE_BY_SYSTEM_TABLE[parentSystemTable];
    return fields.filter(f => f.field_type === fieldType || f.linked_system_table === parentSystemTable);
  }
  // Unknown parent type (e.g. a custom-table-backed record) -- fall back to
  // the broad set across every system-table relation kind.
  return fields.filter(f =>
    (['project', 'property', 'entity'] as string[]).includes(f.field_type) ||
    (['projects', 'properties', 'entities'] as string[]).includes(f.linked_system_table || '')
  );
}

export function parentKindLabel(parentSystemTable?: ParentSystemTable): string {
  if (parentSystemTable === 'projects') return 'project';
  if (parentSystemTable === 'properties') return 'property';
  if (parentSystemTable === 'entities') return 'entity';
  return 'record';
}
