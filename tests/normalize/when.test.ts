// Spoken times -> minutes past midnight, clinic-local.
//
// The rule doing most of the work: an ambiguous hour resolves against CLINIC
// HOURS. "One" is 1 PM because 1 AM is not a time this clinic offers. That
// single constraint removes most AM/PM ambiguity without asking the caller.

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
  // Ambiguous, resolved by clinic hours (9-5): the PM reading is the open one.
  ['three', 15 * 60],
  ['one', 13 * 60],
  // 9 is open in the morning, so it stays morning.
  ['nine', 9 * 60],
  // Neither reading is inside clinic hours.
  ['eleven at night', null],
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
