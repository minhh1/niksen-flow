// Cross-field validation for a table's schema -- distinct from
// validateFieldConstraints in lib/services/customTableService.ts, which
// checks a single field's VALUE against its own is_required/is_unique
// (e.g. "this record's Email can't be blank"). This checks whether a
// candidate field even makes sense to ADD or EDIT given the table's other
// fields (e.g. "a table can't have two auto-numbered ID fields"), before
// any value is ever entered.
//
// No real conflicting-field cases have come up yet, so this starts with a
// small number of genuinely defensible structural rules rather than
// speculative business logic -- add a new one here (~10 lines) the moment a
// real case surfaces, rather than guessing at what future ones might be.
export interface FieldLike {
  id: string;
  field_type: string;
  is_unique: boolean;
}

export interface FieldCompatibilityRule {
  id: string;
  description: string;
  // `existingFields` excludes the candidate itself (on edit, the field's
  // own prior state isn't in this list). Returns an error message if the
  // candidate violates the rule, else null.
  check: (existingFields: FieldLike[], candidate: FieldLike) => string | null;
}

export const FIELD_COMPATIBILITY_RULES: FieldCompatibilityRule[] = [
  {
    id: 'single-auto-id',
    description: 'A table can only have one Auto ID field',
    check: (existingFields, candidate) => {
      if (candidate.field_type !== 'auto_id') return null;
      if (existingFields.some(f => f.field_type === 'auto_id')) {
        return 'This table already has an Auto ID field -- only one is allowed.';
      }
      return null;
    },
  },
  {
    id: 'unique-requires-scalar',
    description: '"Unique" only makes sense on a field with more than two possible values',
    check: (_existingFields, candidate) => {
      if (candidate.is_unique && candidate.field_type === 'boolean') {
        return '"Unique" doesn\'t apply to Yes/No fields -- every record but one would have to differ, which is impossible with only two values.';
      }
      return null;
    },
  },
];

export function validateFieldCompatibility(existingFields: FieldLike[], candidate: FieldLike): string[] {
  return FIELD_COMPATIBILITY_RULES
    .map(rule => rule.check(existingFields.filter(f => f.id !== candidate.id), candidate))
    .filter((msg): msg is string => !!msg);
}
