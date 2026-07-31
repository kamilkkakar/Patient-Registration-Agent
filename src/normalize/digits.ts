/**
 * Shared spoken-number → digit-string conversion.
 *
 * Speech-to-text hands us what a human *said*, not what they would have typed.
 * A caller reading a phone number aloud produces "five five five, oh one double
 * two" — never "5550122". Phone and ZIP both need the same conversion, so it
 * lives here rather than being written twice and drifting.
 *
 * Pure: no I/O, no dependencies.
 */

const DIGIT_WORDS: Record<string, string | undefined> = {
  zero: '0',
  // People reading digits aloud say "oh" for zero ("nine oh two one oh"), and
  // STT transcribes that sound as the bare letter "o" roughly as often as it
  // writes "oh". Both must map to 0 or every third phone number is rejected.
  oh: '0',
  o: '0',
  nought: '0',
  naught: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  // Radio/aviation habit, common with older callers reading numbers back.
  niner: '9',
};

const TEEN_WORDS: Record<string, string | undefined> = {
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
};

const TENS_WORDS: Record<string, string | undefined> = {
  twenty: '20',
  thirty: '30',
  forty: '40',
  // "fourty" is a frequent STT spelling; accepting it costs one line.
  fourty: '40',
  fifty: '50',
  sixty: '60',
  seventy: '70',
  eighty: '80',
  ninety: '90',
};

// "double seven" / "triple oh" is how people compress a repeated digit aloud.
const REPEAT_WORDS: Record<string, number | undefined> = {
  double: 2,
  dbl: 2,
  triple: 3,
  treble: 3,
};

/**
 * Extract an ordered digit string from loosely-spoken input.
 *
 * Unrecognised words are skipped rather than failing the whole parse — the
 * transcript is full of filler ("um", "my number is", "area code") and the
 * caller should not have to repeat themselves because of it. Callers of this
 * function decide whether the resulting length is acceptable.
 */
export function spokenDigitsToDigits(input: string): string {
  const tokens = input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);

  let out = '';
  let repeat = 1;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;

    const repeatCount = REPEAT_WORDS[token];
    if (repeatCount !== undefined) {
      repeat = repeatCount;
      continue;
    }

    let chunk: string | undefined = DIGIT_WORDS[token];

    if (chunk === undefined) chunk = TEEN_WORDS[token];

    if (chunk === undefined) {
      const tens = TENS_WORDS[token];
      if (tens !== undefined) {
        // "eighty five" is one two-digit number, not 80 followed by 5. Look
        // ahead and merge, otherwise a ZIP said as "nine oh two eighty five"
        // gains an extra digit and fails the length check.
        const next = tokens[i + 1];
        const unit = next === undefined ? undefined : DIGIT_WORDS[next];
        if (unit !== undefined && unit !== '0') {
          chunk = tens.charAt(0) + unit;
          i += 1;
        } else {
          chunk = tens;
        }
      }
    }

    if (chunk === undefined && /^\d+$/.test(token)) chunk = token;

    if (chunk === undefined) {
      // Unknown word: ignore it, and drop any pending "double" that it
      // interrupted so the repeat cannot leak onto a later digit.
      repeat = 1;
      continue;
    }

    out += repeat > 1 ? chunk.repeat(repeat) : chunk;
    repeat = 1;
  }

  return out;
}
