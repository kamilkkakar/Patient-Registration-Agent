import { spokenDigitsToDigits } from './digits.js';

/**
 * Normalize a spoken or typed U.S. ZIP code to "12345" or "12345-6789".
 *
 * Returns null unless exactly 5 or 9 digits are recovered. Nine digits are
 * always re-hyphenated, so "123456789" and "12345-6789" produce the same
 * stored value and the ZIP+4 regex in validation sees one canonical shape.
 */

// Said aloud, ZIP+4 is "one two three four five, plus four, six seven eight
// nine" or "... dash six seven eight nine". "plus four" and "dash" are spoken
// punctuation — if left in, "four" is read as a digit and the count goes to 10.
const SPOKEN_PUNCTUATION = /\b(?:plus\s*four|zip\s*(?:code)?|postal\s*code|dash|hyphen|minus)\b/gi;

export function normalizeZip(input: string): string | null {
  if (typeof input !== 'string') return null;

  const digits = spokenDigitsToDigits(input.replace(SPOKEN_PUNCTUATION, ' '));

  if (digits.length === 5) return digits;
  if (digits.length === 9) return `${digits.slice(0, 5)}-${digits.slice(5)}`;

  return null;
}
