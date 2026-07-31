import { describe, expect, it } from 'vitest';

import { formatDob, normalizeDateOfBirth, parseSpokenDob } from '../../src/normalize/date.js';

describe('normalizeDateOfBirth', () => {
  it('passes through MM/DD/YYYY', () => {
    expect(normalizeDateOfBirth('02/15/1992')).toBe('02/15/1992');
    expect(normalizeDateOfBirth('2/5/1992')).toBe('02/05/1992');
  });

  it('accepts ISO YYYY-MM-DD', () => {
    expect(normalizeDateOfBirth('1992-02-15')).toBe('02/15/1992');
  });

  it('handles a month name with an ordinal suffix', () => {
    expect(normalizeDateOfBirth('March 5th 1985')).toBe('03/05/1985');
    expect(normalizeDateOfBirth('march 5th 1985')).toBe('03/05/1985');
    expect(normalizeDateOfBirth('Mar 5 1985')).toBe('03/05/1985');
    expect(normalizeDateOfBirth('January 1st 2000')).toBe('01/01/2000');
  });

  it('handles bare separated numbers', () => {
    expect(normalizeDateOfBirth('3 5 85')).toBe('03/05/1985');
    expect(normalizeDateOfBirth('12 25 1990')).toBe('12/25/1990');
  });

  it('handles a fully spoken digit-by-digit date', () => {
    expect(normalizeDateOfBirth('oh three oh five eighty five')).toBe('03/05/1985');
    expect(normalizeDateOfBirth('oh three oh five nineteen eighty five')).toBe('03/05/1985');
  });

  it('handles the day-of-month-first spoken form', () => {
    expect(normalizeDateOfBirth('the fifth of March nineteen eighty five')).toBe('03/05/1985');
    expect(normalizeDateOfBirth('the twenty third of June nineteen seventy')).toBe('06/23/1970');
  });

  it('handles a conversational lead-in', () => {
    expect(normalizeDateOfBirth('I was born on March 5th 1985')).toBe('03/05/1985');
    expect(normalizeDateOfBirth('my date of birth is 02/15/1992')).toBe('02/15/1992');
  });

  it('rolls a 2-digit year back a century when the current century is in the future', () => {
    // A DOB cannot be 2085 — nobody has been born then yet.
    expect(normalizeDateOfBirth('3 5 85')).toBe('03/05/1985');
    expect(normalizeDateOfBirth('12 31 99')).toBe('12/31/1999');
    // ...but a 2-digit year that has already happened stays in this century.
    expect(normalizeDateOfBirth('01 02 10')).toBe('01/02/2010');
  });

  it('does NOT reject future dates — that is validation\'s job', () => {
    const futureYear = new Date().getUTCFullYear() + 5;
    expect(normalizeDateOfBirth(`03/05/${futureYear}`)).toBe(`03/05/${futureYear}`);
  });

  it('rejects impossible calendar dates', () => {
    expect(normalizeDateOfBirth('02/30/1992')).toBeNull();
    expect(normalizeDateOfBirth('13/05/1992')).toBeNull();
    expect(normalizeDateOfBirth('00/10/1992')).toBeNull();
    expect(normalizeDateOfBirth('04/31/1992')).toBeNull();
  });

  it('applies the full leap-year rule', () => {
    expect(normalizeDateOfBirth('February 29 2000')).toBe('02/29/2000');
    expect(normalizeDateOfBirth('February 29 1992')).toBe('02/29/1992');
    // 1900 is divisible by 100 but not 400, so it is not a leap year.
    expect(normalizeDateOfBirth('February 29 1900')).toBeNull();
    expect(normalizeDateOfBirth('February 29 1985')).toBeNull();
  });

  it('returns null on unparseable input', () => {
    expect(normalizeDateOfBirth('')).toBeNull();
    expect(normalizeDateOfBirth('   ')).toBeNull();
    expect(normalizeDateOfBirth('sometime last spring')).toBeNull();
    expect(normalizeDateOfBirth('March')).toBeNull();
    expect(normalizeDateOfBirth('1985')).toBeNull();
  });
});

describe('parseSpokenDob', () => {
  it('builds a UTC-midnight Date so the day cannot shift by zone', () => {
    const parsed = parseSpokenDob('02/15/1992');
    expect(parsed).not.toBeNull();
    expect(parsed?.toISOString()).toBe('1992-02-15T00:00:00.000Z');
  });

  it('accepts the spoken forms too', () => {
    expect(parseSpokenDob('March 5th 1985')?.toISOString()).toBe('1985-03-05T00:00:00.000Z');
  });

  it('returns null when normalization fails', () => {
    expect(parseSpokenDob('nonsense')).toBeNull();
  });
});

describe('formatDob', () => {
  it('renders MM/DD/YYYY from UTC parts', () => {
    expect(formatDob(new Date(Date.UTC(1992, 1, 15)))).toBe('02/15/1992');
    expect(formatDob(new Date(Date.UTC(2000, 0, 1)))).toBe('01/01/2000');
  });

  it('round-trips with parseSpokenDob', () => {
    const parsed = parseSpokenDob('the fifth of March nineteen eighty five');
    expect(parsed).not.toBeNull();
    expect(parsed === null ? null : formatDob(parsed)).toBe('03/05/1985');
  });
});
