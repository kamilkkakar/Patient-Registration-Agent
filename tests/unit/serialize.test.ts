// The DOB day-shift guard (handoff § 7.2) and the sex enum mapping.
//
// This whole suite runs under TZ=America/Los_Angeles (see vitest.config.ts).
// A round-trip test that only passes at TZ=UTC has not tested anything.

import { describe, expect, it } from 'vitest';
import {
  formatDob,
  parseDobStrict,
  parseSex,
  sexToDisplay,
} from '../../src/lib/serialize.js';

describe('date of birth — UTC only', () => {
  it(`round-trips MM/DD/YYYY under TZ=${process.env.TZ ?? 'unset'}`, () => {
    for (const value of ['02/15/1992', '01/01/1900', '12/31/1999', '07/04/1978']) {
      const parsed = parseDobStrict(value);
      expect(parsed).not.toBeNull();
      expect(formatDob(parsed as Date)).toBe(value);
    }
  });

  it('stores UTC midnight, not local midnight', () => {
    const parsed = parseDobStrict('02/15/1992') as Date;
    expect(parsed.toISOString()).toBe('1992-02-15T00:00:00.000Z');
  });

  it('accepts the ISO form and normalizes it to the same instant', () => {
    expect((parseDobStrict('1992-02-15') as Date).toISOString()).toBe('1992-02-15T00:00:00.000Z');
    expect(formatDob(parseDobStrict('1992-02-15') as Date)).toBe('02/15/1992');
  });

  it('rejects impossible calendar dates instead of rolling them forward', () => {
    expect(parseDobStrict('02/30/1992')).toBeNull();
    expect(parseDobStrict('04/31/2000')).toBeNull();
    expect(parseDobStrict('02/29/1991')).toBeNull(); // 1991 is not a leap year
    expect(parseDobStrict('13/01/1990')).toBeNull();
  });

  it('accepts a real leap day', () => {
    expect(formatDob(parseDobStrict('02/29/1992') as Date)).toBe('02/29/1992');
  });

  it('rejects unparseable input', () => {
    expect(parseDobStrict('hello')).toBeNull();
    expect(parseDobStrict('2/15/1992')).toBeNull();
    expect(parseDobStrict('')).toBeNull();
  });
});

describe('sex enum mapping', () => {
  it('accepts both storage and display forms, case-insensitively', () => {
    expect(parseSex('Male')).toBe('MALE');
    expect(parseSex('female')).toBe('FEMALE');
    expect(parseSex('OTHER')).toBe('OTHER');
    expect(parseSex('Decline to Answer')).toBe('DECLINE_TO_ANSWER');
    expect(parseSex('decline to answer')).toBe('DECLINE_TO_ANSWER');
    expect(parseSex('DECLINE_TO_ANSWER')).toBe('DECLINE_TO_ANSWER');
    expect(parseSex('  decline_to_answer  ')).toBe('DECLINE_TO_ANSWER');
  });

  it('maps spoken aliases so voice slips still save', () => {
    // WHY: live call STT/model may pass "ma'am" / "sir" instead of the enum label.
    expect(parseSex("ma'am")).toBe('FEMALE');
    expect(parseSex('maam')).toBe('FEMALE');
    expect(parseSex('madam')).toBe('FEMALE');
    expect(parseSex('sir')).toBe('MALE');
    expect(parseSex('guy')).toBe('MALE');
    expect(parseSex('nonbinary')).toBe('OTHER');
    expect(parseSex('rather not say')).toBe('DECLINE_TO_ANSWER');
  });

  it('rejects anything else', () => {
    expect(parseSex('Yes')).toBeNull();
    expect(parseSex('')).toBeNull();
    // Do NOT map "mail" → Male; that is how "ma'am" was mis-handled in call 4.
    expect(parseSex('mail')).toBeNull();
  });

  it('always returns the display form', () => {
    expect(sexToDisplay('DECLINE_TO_ANSWER')).toBe('Decline to Answer');
    expect(sexToDisplay('MALE')).toBe('Male');
  });
});
