import { describe, expect, it } from 'vitest';

import { normalizePhone } from '../../src/normalize/phone.js';

describe('normalizePhone', () => {
  it('passes through 10 bare digits', () => {
    expect(normalizePhone('5551234567')).toBe('5551234567');
  });

  it('strips punctuation and spaces', () => {
    expect(normalizePhone('(555) 123-4567')).toBe('5551234567');
    expect(normalizePhone('555.123.4567')).toBe('5551234567');
    expect(normalizePhone('  555 123 4567  ')).toBe('5551234567');
  });

  it('drops a +1 country prefix', () => {
    expect(normalizePhone('+1 555 123 4567')).toBe('5551234567');
    expect(normalizePhone('1-555-123-4567')).toBe('5551234567');
    expect(normalizePhone('+15551234567')).toBe('5551234567');
    expect(normalizePhone('plus one five five five one two three four five six seven'))
      .toBe('5551234567');
  });

  it('converts spoken digit words', () => {
    expect(normalizePhone('five five five one two three four five six seven'))
      .toBe('5551234567');
  });

  it('treats "oh" and a bare "o" as zero', () => {
    expect(normalizePhone('nine oh two one oh five five five one two'))
      .toBe('9021055512');
    expect(normalizePhone('nine o two one o five five five one two'))
      .toBe('9021055512');
  });

  it('expands "double" and "triple" repeats', () => {
    // 5,5,5 1,2,3 44 5,6
    expect(normalizePhone('five five five one two three double four five six'))
      .toBe('5551234456');
    // 5,5,5 000 1,2,3,4
    expect(normalizePhone('five five five triple oh one two three four'))
      .toBe('5550001234');
  });

  it('strips extensions and ignores them', () => {
    expect(normalizePhone('555-123-4567 ext 12')).toBe('5551234567');
    expect(normalizePhone('555-123-4567 ext. 12')).toBe('5551234567');
    expect(normalizePhone('555-123-4567 extension 1234')).toBe('5551234567');
    expect(normalizePhone('5551234567 x89')).toBe('5551234567');
  });

  it('handles a full conversational utterance', () => {
    expect(normalizePhone('my number is five five five, one two three, four five six seven'))
      .toBe('5551234567');
  });

  it('returns null when it cannot produce exactly 10 digits', () => {
    expect(normalizePhone('555')).toBeNull();
    expect(normalizePhone('55512345678901')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('   ')).toBeNull();
    expect(normalizePhone('no idea sorry')).toBeNull();
  });

  it('does not treat a leading 1 as a country code on a bare 10-digit number', () => {
    // Left intact so validation can reject the illegal area code explicitly.
    expect(normalizePhone('1551234567')).toBe('1551234567');
  });
});
