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
import { parseSpokenTime, parseWhen, type WhenQuery } from '../../src/normalize/when.js';

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
  // "four forty five" is 4:45. The tens word used to swallow the unit and
  // report 4:40 — a time the caller never said, offered back as if it were.
  ['four forty five', 16 * 60 + 45],
  // A 24-hour word with minutes. Same truncation, other end of the clock.
  ['eighteen thirty', 18 * 60 + 30],
  // A number is not a time just because it is a number. These are quantities,
  // and reading them as 2 PM / 3 PM would hand the caller a confident wrong
  // answer instead of the null that makes the model ask again.
  ['in two weeks', null],
  ['in three days', null],
  ['in two hours', null],
  // "ten" IS an hour word, so this one genuinely exercises the duration guard
  // rather than failing for want of vocabulary.
  ['in ten minutes', null],
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

// Monday 3 August 2026.
const TODAY = { year: 2026, month: 8, day: 3 };

describe('parseWhen', () => {
  it('reads a weekday as the soonest upcoming one', () => {
    expect(parseWhen('wednesday', TODAY)).toEqual({
      kind: 'day', date: { year: 2026, month: 8, day: 5 },
    });
  });

  it('treats "next Tuesday" as the soonest Tuesday', () => {
    // WHY documented rather than clever: "next Tuesday" means different things
    // to different people, and guessing "the week after" is wrong about as
    // often as it is right.
    expect(parseWhen('next tuesday', TODAY)).toEqual({
      kind: 'day', date: { year: 2026, month: 8, day: 4 },
    });
  });

  it('reads today when the caller names today', () => {
    expect(parseWhen('monday', TODAY)).toEqual({ kind: 'day', date: TODAY });
  });

  it('reads tomorrow', () => {
    expect(parseWhen('tomorrow', TODAY)).toEqual({
      kind: 'day', date: { year: 2026, month: 8, day: 4 },
    });
  });

  it('combines a day and a time', () => {
    expect(parseWhen('monday at 1 pm', TODAY)).toEqual({
      kind: 'time', date: TODAY, minutesOfDay: 13 * 60,
    });
  });

  it('reads a time with no day', () => {
    expect(parseWhen('half past two', TODAY)).toEqual({
      kind: 'time', date: null, minutesOfDay: 14 * 60 + 30,
    });
  });

  it('reads a daypart', () => {
    expect(parseWhen('tuesday morning', TODAY)).toEqual({
      kind: 'daypart', date: { year: 2026, month: 8, day: 4 }, part: 'morning',
    });
  });

  it('treats an open request as no preference', () => {
    expect(parseWhen('anything', TODAY)).toEqual({ kind: 'any' });
    expect(parseWhen('as soon as possible', TODAY)).toEqual({ kind: 'any' });
  });

  // Every case above asks for a weekday that is EQUAL TO or LATER IN THE WEEK
  // than `today` (Monday), so `delta = (weekday - clinicWeekday(today) + 7) % 7`
  // never needs the `+ 7` to stay non-negative — it would pass even if that
  // term were deleted. These cases sit on the other side of the arithmetic:
  // a weekday earlier in the week must still resolve to the soonest UPCOMING
  // occurrence, not a negative delta that lands in the past.
  it('rolls a backwards-looking weekday forward to next week', () => {
    expect(parseWhen('sunday', TODAY)).toEqual({
      kind: 'day', date: { year: 2026, month: 8, day: 9 },
    });
    expect(parseWhen('friday', TODAY)).toEqual({
      kind: 'day', date: { year: 2026, month: 8, day: 7 },
    });
  });

  it('rolls forward from late in the week too', () => {
    const FRIDAY = { year: 2026, month: 8, day: 7 };
    expect(parseWhen('tuesday', FRIDAY)).toEqual({
      kind: 'day', date: { year: 2026, month: 8, day: 11 },
    });
  });

  // The out-of-hours contract change (parseSpokenTime no longer nulls a time
  // outside 9-5) needs to survive through parseWhen too, since the caller
  // never sees parseSpokenTime directly — only the availability layer's
  // outsideClinicHours flag is supposed to catch this, not a null here.
  it('passes an out-of-hours time through instead of losing it', () => {
    expect(parseWhen('monday at 7 pm', TODAY)).toEqual({
      kind: 'time', date: TODAY, minutesOfDay: 19 * 60,
    });
  });

  it('returns null when nothing is recognisable', () => {
    expect(parseWhen('purple monkey', TODAY)).toBeNull();
  });
});

// A caller naming a date on the calendar rather than a weekday. Both spellings
// used to return null, so the model re-asked a question the caller had already
// answered. TODAY is Monday 3 August 2026.
describe('parseWhen — calendar dates', () => {
  const dateCases: [string, WhenQuery | null][] = [
    // Bare day-of-month: the next occurrence, this month or the next.
    ['the fifteenth', { kind: 'day', date: { year: 2026, month: 8, day: 15 } }],
    // The 1st has gone for August, so it rolls to September rather than
    // offering a date in the past.
    ['the first', { kind: 'day', date: { year: 2026, month: 9, day: 1 } }],
    // ORDINAL_WORDS has no entry past "twentieth"; without the compound rule
    // this reads as the FIRST — a wrong date, not an unparsed one.
    ['the twenty first', { kind: 'day', date: { year: 2026, month: 8, day: 21 } }],
    ['august twentieth', { kind: 'day', date: { year: 2026, month: 8, day: 20 } }],
    // Digits either side of the suffix, and the "of" phrasing.
    ['august 20th', { kind: 'day', date: { year: 2026, month: 8, day: 20 } }],
    ['the twentieth of august', { kind: 'day', date: { year: 2026, month: 8, day: 20 } }],
    // A month already past resolves into the coming year, never backwards.
    ['february tenth', { kind: 'day', date: { year: 2027, month: 2, day: 10 } }],
    // A date that does not exist stays unparsed rather than rolling into March.
    ['february thirtieth', null],
    // The day number is consumed by the date, so it cannot ALSO be read as an
    // hour: without that, "august 20" comes back as 8 PM.
    ['august 20', { kind: 'day', date: { year: 2026, month: 8, day: 20 } }],
    [
      'the fifteenth at three',
      { kind: 'time', date: { year: 2026, month: 8, day: 15 }, minutesOfDay: 15 * 60 },
    ],
    [
      'august twentieth in the morning',
      { kind: 'daypart', date: { year: 2026, month: 8, day: 20 }, part: 'morning' },
    ],
  ];

  for (const [input, expected] of dateCases) {
    it(`${JSON.stringify(input)}`, () => {
      expect(parseWhen(input, TODAY)).toEqual(expected);
    });
  }

  it('still lets a named weekday win over a date in the same sentence', () => {
    // The two ambiguity rules already tested must survive the new branch:
    // calendar parsing is only reached when no weekday, "today" or "tomorrow"
    // was said.
    expect(parseWhen('next tuesday', TODAY)).toEqual({
      kind: 'day', date: { year: 2026, month: 8, day: 4 },
    });
    expect(parseWhen('monday', TODAY)).toEqual({ kind: 'day', date: TODAY });
  });

  it('does not let "first available" become the first of the month', () => {
    // OPEN_REQUEST is tested before any date parsing; "first" is also an
    // ORDINAL_WORDS entry, so the ordering is load-bearing.
    expect(parseWhen('the first available', TODAY)).toEqual({ kind: 'any' });
  });
});
