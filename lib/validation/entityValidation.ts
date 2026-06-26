/**
 * Validates an Australian Business Number using the official modulus-89
 * check-digit algorithm. Returns true only for an ABN that is genuinely
 * well-formed, not just 11 digits.
 */
export function isValidABN(abn: string): boolean {
  const cleaned = abn.replace(/\s/g, '');
  if (!/^\d{11}$/.test(cleaned)) return false;

  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const digits = cleaned.split('').map(Number);
  digits[0] -= 1; // first digit is reduced by 1 before weighting, per the ATO algorithm

  const sum = digits.reduce((acc, digit, i) => acc + digit * weights[i], 0);
  return sum % 89 === 0;
}

/**
 * Validates an Australian Company Number using its check-digit algorithm
 * (a weighted modulus-10 calculation over the first 8 digits, compared
 * against the 9th).
 */
export function isValidACN(acn: string): boolean {
  const cleaned = acn.replace(/\s/g, '');
  if (!/^\d{9}$/.test(cleaned)) return false;

  const weights = [8, 7, 6, 5, 4, 3, 2, 1];
  const digits = cleaned.slice(0, 8).split('').map(Number);
  const checkDigit = Number(cleaned[8]);

  const sum = digits.reduce((acc, digit, i) => acc + digit * weights[i], 0);
  const remainder = sum % 10;
  const expectedCheck = remainder === 0 ? 0 : 10 - remainder;

  return expectedCheck === checkDigit;
}

export interface FieldValidationRule {
  validate: (value: string) => string | null; // returns an error message, or null if valid
}

export const ENTITY_FIELD_VALIDATORS: Record<string, FieldValidationRule> = {
  name: {
    validate: (v) => (!v || !v.trim()) ? "Entity name can't be empty" : null,
  },
  entity_type: {
    validate: (v) => (!v || !v.trim()) ? "Entity type can't be empty" : null,
  },
  abn: {
    validate: (v) => {
      if (!v || !v.trim()) return null; // optional — empty is fine
      return isValidABN(v) ? null : "Not a valid ABN (must be 11 digits and pass the ABN checksum)";
    },
  },
  acn: {
    validate: (v) => {
      if (!v || !v.trim()) return null; // optional
      return isValidACN(v) ? null : "Not a valid ACN (must be 9 digits and pass the ACN checksum)";
    },
  },
};