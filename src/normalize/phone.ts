import { spokenDigitsToDigits } from './digits.js';

/**
 * Normalize a spoken or typed U.S. phone number to 10 bare digits.
 *
 * 10 bare digits is the canonical storage form for this project (phase-2
 * handoff, decision D3) — no `+1`, no punctuation — so duplicate lookup stays a
 * plain equality check.
 *
 * Returns null if the input does not yield exactly 10 digits. Validation, not
 * normalization, decides whether those 10 digits are a *legal* NANP number
 * (area/exchange codes may not start with 0 or 1); this layer only canonicalizes.
 */

// Everything from an extension marker onward is cut *before* digits are read.
// "555-123-4567 ext 12" otherwise yields 12 digits and fails, or worse, silently
// stores the extension as part of the subscriber number.
const EXTENSION_WORD = /\b(?:extension|extn|ext)\b[\s\S]*$/i;
// Bare "x1234" at the end is the written shorthand for the same thing. It must
// require trailing digits, or the letter x in ordinary text would truncate.
const EXTENSION_SHORTHAND = /\bx\s*\d[\d\s-]*$/i;

export function normalizePhone(input: string): string | null {
  if (typeof input !== 'string') return null;

  const withoutExtension = input
    .replace(EXTENSION_WORD, ' ')
    .replace(EXTENSION_SHORTHAND, ' ');

  let digits = spokenDigitsToDigits(withoutExtension);

  // A leading 1 is the U.S. country code, whether the caller said "plus one",
  // "one", or typed "+1". It is only a country code when what remains is a full
  // 10-digit number — a bare 10-digit number starting with 1 is invalid anyway
  // and is left alone so validation can reject it explicitly.
  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  }

  return digits.length === 10 ? digits : null;
}
