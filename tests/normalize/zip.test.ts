import { describe, expect, it } from 'vitest';

import { normalizeZip } from '../../src/normalize/zip.js';

describe('normalizeZip', () => {
  it('passes through a 5-digit ZIP', () => {
    expect(normalizeZip('78701')).toBe('78701');
    expect(normalizeZip('  78701 ')).toBe('78701');
  });

  it('converts spoken digit words', () => {
    expect(normalizeZip('seven eight seven zero one')).toBe('78701');
    expect(normalizeZip('one two three four five')).toBe('12345');
  });

  it('treats "oh" as zero', () => {
    expect(normalizeZip('nine oh two one oh')).toBe('90210');
    expect(normalizeZip('nine o two one o')).toBe('90210');
  });

  it('expands "double" repeats', () => {
    // 1, 00, 2, 3
    expect(normalizeZip('one double oh two three')).toBe('10023');
  });

  it('keeps a hyphenated ZIP+4', () => {
    expect(normalizeZip('12345-6789')).toBe('12345-6789');
  });

  it('adds the hyphen to a 9-digit ZIP+4 that lacks one', () => {
    expect(normalizeZip('123456789')).toBe('12345-6789');
    expect(normalizeZip('12345 6789')).toBe('12345-6789');
  });

  it('handles a spoken ZIP+4', () => {
    expect(normalizeZip('one two three four five dash six seven eight nine'))
      .toBe('12345-6789');
    expect(normalizeZip('one two three four five plus four six seven eight nine'))
      .toBe('12345-6789');
  });

  it('ignores a spoken "zip code" prefix', () => {
    expect(normalizeZip('zip code seven eight seven zero one')).toBe('78701');
  });

  it('returns null for any other digit count', () => {
    expect(normalizeZip('1234')).toBeNull();
    expect(normalizeZip('123456')).toBeNull();
    expect(normalizeZip('1234567890')).toBeNull();
    expect(normalizeZip('')).toBeNull();
    expect(normalizeZip('   ')).toBeNull();
    expect(normalizeZip('not sure')).toBeNull();
  });
});
