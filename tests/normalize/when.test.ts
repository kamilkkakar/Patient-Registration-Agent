// Spoken times -> minutes past midnight, clinic-local.
//
// The rule doing most of the work: an AMBIGUOUS bare hour resolves against
// CLINIC HOURS. "One" is 1 PM because 1 AM is not a time this clinic offers.
// That single constraint removes most AM/PM ambiguity without asking the
// caller. It decides only between two readings of the SAME bare hour — it
// does not gate the result. Owner ruling (round-1 fix): parseSpokenTime
// reports the time it understood even when the clinic doesn't offer it, so
// the availability layer's `outsideClinicHours` flag can say "we're open 9
// to 5 — nearest I have is 4:30" instead of that message being unreachable.
// `null` is reserved for text that could not be parsed as a time at all.

import { describe, expect, it } from 'vitest';
import { parseSpokenTime } from '../../src/normalize/when.js';

const cases: [string, number | null][] = [
  ['1 PM', 13 * 60],
  ['one pm', 13 * 60],
  ['1:30 PM', 13 * 60 + 30],
  ['one thirty', 13 * 60 + 30],
  ['half past two', 14 * 60 + 30],
  ['quarter past nine', 9 * 60 + 15],
  ['quarter to three', 14 * 60 + 45],
  ['nine o clock', 9 * 60],
  ['9 AM', 9 * 60],
  ['noon', 12 * 60],
  ['ten in the morning', 10 * 60],
  ['four in the afternoon', 16 * 60],
  // Ambiguous bare hour, resolved by clinic hours (9-5): the PM reading is the
  // open one. These six cases (through 'one thirty' above) are the ones that
  // discriminate the feature — they prove the ambiguity rule exists at all.
  ['three', 15 * 60],
  ['one', 13 * 60],
  // 9 is open in the morning, so it stays morning.
  ['nine', 9 * 60],
  // "night" makes the meridiem explicit (PM), so this is NOT the ambiguous
  // case — there is only one reading, 23:00, and it is reported as-is even
  // though the clinic closes at 5 PM. outsideClinicHours is availability's
  // job to flag, not this parser's job to hide by returning null.
  ['eleven at night', 23 * 60],
  // Bare hour, no stated meridiem, and BOTH readings (7 AM, 7 PM) are outside
  // 9-5 — the case the owner ruling was written for. Still not null: a
  // reading is returned, with PM as the documented, deterministic tie-break
  // in resolveMeridiem (matches the morning-then-afternoon preference order).
  ['seven', 19 * 60],
  // TEEN_WORDS reaches the bare-hour loop directly, so a plain 24-hour word
  // ("eighteen" = 6 PM) is unambiguous and reported as-is, same as digital
  // 24-hour input — this is the "hour > 12" path flagged in round-1 review.
  ['eighteen', 18 * 60],
  ['gibberish', null],
  ['', null],
];

describe('parseSpokenTime', () => {
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${String(expected)}`, () => {
      expect(parseSpokenTime(input)).toBe(expected);
    });
  }
});
