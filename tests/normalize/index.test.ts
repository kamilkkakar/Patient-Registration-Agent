import { describe, expect, it } from 'vitest';

import * as normalize from '../../src/normalize/index.js';

describe('src/normalize barrel', () => {
  it('re-exports every normalizer', () => {
    expect(Object.keys(normalize).sort()).toEqual([
      'formatDob',
      'normalizeDateOfBirth',
      'normalizeEmail',
      'normalizePhone',
      'normalizeSpelledText',
      'normalizeState',
      'normalizeZip',
      'parseSpokenDob',
    ]);
  });

  it('normalizes a whole spoken registration through the barrel', () => {
    expect(normalize.normalizePhone('plus one, five five five, one two three, four five six seven'))
      .toBe('5551234567');
    expect(normalize.normalizeDateOfBirth('the fifth of March nineteen eighty five'))
      .toBe('03/05/1985');
    expect(normalize.normalizeEmail('k a m i l at gmail dot com')).toBe('kamil@gmail.com');
    expect(normalize.normalizeZip('nine oh two one oh')).toBe('90210');
    expect(normalize.normalizeState('Washington DC')).toBe('DC');
    expect(normalize.normalizeSpelledText('D-A-V-I-S, not D-A-V-I-E-S')).toBe('Davis');
  });
});
