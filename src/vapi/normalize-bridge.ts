// THE bridge between what the caller SAID and what the database stores.
//
// The system prompt (prompts/intake-coordinator.md § 2.3) makes a hard promise:
// *the model decides which field a value belongs to; the server decides what
// format it takes*. So the model sends the caller's own words verbatim —
// "nine oh two, five five five, oh one four seven", "February fifteenth, ninety
// two", "my last name is spelled D-A-V-I-S, not D-A-V-I-E-S" — and this module
// is the only thing standing between those and Zod.
//
// Without it the contract collapses silently: `src/validation/patient.ts`
// carries an explicit scope note saying it does NOT do voice normalization, and
// its `toTenDigits` strips non-digits, so "nine oh two…" becomes "" and every
// registration 422s.
//
// Two rules, both load-bearing:
//
//  1. **A normalizer returning null passes the RAW value through.** null means
//     "shape unrecoverable", and the caller is owed a field-SPECIFIC error so
//     the model can re-prompt for that one field (§ 2.7). Dropping the key
//     instead would produce "required" — the model would re-ask from scratch,
//     or worse, silently omit an optional field the caller did give.
//  2. **Never introduce a key the model did not send.** A declined optional
//     field is absent, not null, not "". `preferred_language: null` is a 422
//     against a NOT NULL DEFAULT column.
//
// Free text is passed through untouched: `city`, `address_line_1`,
// `address_line_2`, `insurance_provider`, `emergency_contact_name`,
// `preferred_language`, and `sex` (the model maps that one itself — `parseSex`
// handles casing, not "I'm a guy").

import {
  normalizeDateOfBirth,
  normalizeEmail,
  normalizePhone,
  normalizeSpelledText,
  normalizeState,
  normalizeZip,
} from '../normalize/index.js';

/**
 * Wire key -> normalizer. Mirrors the table in
 * prompts/intake-coordinator.md § 2.3 exactly; if one side changes, change both.
 */
const NORMALIZERS: Record<string, ((value: string) => string | null) | undefined> = {
  phone_number: normalizePhone,
  emergency_contact_phone: normalizePhone,
  date_of_birth: normalizeDateOfBirth,
  email: normalizeEmail,
  zip_code: normalizeZip,
  state: normalizeState,
  first_name: normalizeSpelledText,
  last_name: normalizeSpelledText,
  insurance_member_id: normalizeSpelledText,
};

/** Which keys this bridge touches. Exported for the tests, not for callers. */
export const NORMALIZED_FIELDS: readonly string[] = Object.keys(NORMALIZERS);

/**
 * Map raw tool arguments through `src/normalize/` before Zod ever sees them.
 *
 * Non-string values (an explicit `null` clearing an optional field on update, a
 * number the model sent for a ZIP) are passed through untouched — the schema is
 * the right place to judge those, and a normalizer would only turn a precise
 * type error into a vague one.
 */
export function normalizeToolArguments(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    const normalize = NORMALIZERS[key];

    if (normalize === undefined || typeof value !== 'string') {
      out[key] = value;
      continue;
    }

    const normalized = normalize(value);

    // null -> keep the raw value. Zod then produces the field-specific message
    // the prompt's re-prompt ladder depends on.
    out[key] = normalized ?? value;
  }

  return out;
}
