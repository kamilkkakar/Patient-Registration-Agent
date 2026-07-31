import { describe, expect, it } from 'vitest';

import { normalizeSpelledText } from '../../src/normalize/spelled.js';

describe('normalizeSpelledText', () => {
  describe('the challenge correction case', () => {
    it('extracts "Davis", not "Davies", from the correction utterance', () => {
      // Verbatim from voice-ai-agent-challenge.md § "Is the voice agent actually good?".
      // Two spellings are present; the one before "not" is the correct one.
      expect(
        normalizeSpelledText('Actually, my last name is spelled D-A-V-I-S, not D-A-V-I-E-S'),
      ).toBe('Davis');
    });

    it('handles the inverted phrasing where the correction comes last', () => {
      expect(normalizeSpelledText("It's not D-A-V-I-E-S, it's D-A-V-I-S")).toBe('Davis');
      expect(normalizeSpelledText('Not Davies, Davis')).toBe('Davis');
    });

    it('handles other negation markers', () => {
      expect(normalizeSpelledText('D-A-V-I-S instead of D-A-V-I-E-S')).toBe('Davis');
      expect(normalizeSpelledText('D-A-V-I-S rather than D-A-V-I-E-S')).toBe('Davis');
    });
  });

  describe('spelled forms', () => {
    it('joins a hyphenated spelling', () => {
      expect(normalizeSpelledText('D-A-V-I-S')).toBe('Davis');
      expect(normalizeSpelledText('s-m-i-t-h')).toBe('Smith');
    });

    it('joins space-separated letters', () => {
      expect(normalizeSpelledText('D A V I S')).toBe('Davis');
      expect(normalizeSpelledText('my last name is D A V I S')).toBe('Davis');
    });

    it('handles "X as in Y" disambiguation', () => {
      expect(
        normalizeSpelledText(
          'D as in dog, A as in apple, V as in victor, I as in india, S as in sam',
        ),
      ).toBe('Davis');
      expect(normalizeSpelledText('F for Frank, O for Oscar, X for X-ray')).toBe('Fox');
    });

    it('tolerates filler in the middle of a spelling', () => {
      expect(normalizeSpelledText('D, uh, A, V, I, S')).toBe('Davis');
    });
  });

  describe('casing', () => {
    it('title-cases names', () => {
      expect(normalizeSpelledText('davis')).toBe('Davis');
      expect(normalizeSpelledText('MARY-JANE')).toBe('Mary-Jane');
      expect(normalizeSpelledText("o'brien")).toBe("O'Brien");
    });

    it('keeps a plain spoken name', () => {
      expect(normalizeSpelledText('my last name is Davis')).toBe('Davis');
      expect(normalizeSpelledText('Ann Marie')).toBe('Ann Marie');
    });
  });

  describe('insurance member IDs', () => {
    it('uppercases mixed alphanumerics rather than title-casing them', () => {
      expect(normalizeSpelledText('B-C-1-2-3-4-5')).toBe('BC12345');
      expect(normalizeSpelledText('A B C 1 2 3')).toBe('ABC123');
      expect(normalizeSpelledText('bc123456789')).toBe('BC123456789');
    });

    it('reads spoken digits inside an ID', () => {
      expect(normalizeSpelledText('A B C one two three')).toBe('ABC123');
      expect(normalizeSpelledText('my member id is X Y zero nine')).toBe('XY09');
    });

    it('keeps "oh" as the letter O while spelling', () => {
      // In a spelling context that sound is the letter far more often than the
      // digit, so "B O B" must not become "B0B".
      expect(normalizeSpelledText('B-O-B')).toBe('Bob');
    });
  });

  describe('failure cases', () => {
    it('returns null when there is nothing to extract', () => {
      expect(normalizeSpelledText('')).toBeNull();
      expect(normalizeSpelledText('   ')).toBeNull();
      expect(normalizeSpelledText('um, uh')).toBeNull();
      expect(normalizeSpelledText('...')).toBeNull();
    });
  });
});
