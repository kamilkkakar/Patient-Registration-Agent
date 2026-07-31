import { describe, expect, it } from 'vitest';

import { normalizeEmail } from '../../src/normalize/email.js';

describe('normalizeEmail', () => {
  it('passes through an already-clean address', () => {
    expect(normalizeEmail('kamil@gmail.com')).toBe('kamil@gmail.com');
    expect(normalizeEmail('  Jane.Doe@Example.COM ')).toBe('jane.doe@example.com');
  });

  it('converts "at" to @ and "dot" to .', () => {
    expect(normalizeEmail('kamil at gmail dot com')).toBe('kamil@gmail.com');
    expect(normalizeEmail('kamil dot kakar at gmail dot com')).toBe('kamil.kakar@gmail.com');
  });

  it('accepts "period" and "at sign" as spoken punctuation', () => {
    expect(normalizeEmail('jane period doe at gmail period com')).toBe('jane.doe@gmail.com');
    expect(normalizeEmail('jane at sign gmail dot com')).toBe('jane@gmail.com');
  });

  it('handles letter-by-letter spelling', () => {
    expect(normalizeEmail('k a m i l at gmail dot com')).toBe('kamil@gmail.com');
    expect(normalizeEmail('K A M I L AT GMAIL DOT COM')).toBe('kamil@gmail.com');
  });

  it('handles spoken underscore, dash and plus', () => {
    expect(normalizeEmail('jane underscore doe at gmail dot com')).toBe('jane_doe@gmail.com');
    expect(normalizeEmail('jane dash doe at gmail dot com')).toBe('jane-doe@gmail.com');
    expect(normalizeEmail('jane plus clinic at gmail dot com')).toBe('jane+clinic@gmail.com');
  });

  it('strips a conversational lead-in', () => {
    expect(normalizeEmail('my email is jane at outlook dot com')).toBe('jane@outlook.com');
    expect(normalizeEmail('email address is jane at yahoo dot com')).toBe('jane@yahoo.com');
  });

  it('repairs a dropped "dot" before the TLD of a common domain', () => {
    expect(normalizeEmail('kamil at gmail com')).toBe('kamil@gmail.com');
    expect(normalizeEmail('jane at yahoo com')).toBe('jane@yahoo.com');
    expect(normalizeEmail('jane at hotmail com')).toBe('jane@hotmail.com');
    expect(normalizeEmail('jane at outlook com')).toBe('jane@outlook.com');
  });

  it('rejoins a common domain split across words', () => {
    expect(normalizeEmail('jane at g mail dot com')).toBe('jane@gmail.com');
    expect(normalizeEmail('jane at hot mail dot com')).toBe('jane@hotmail.com');
    expect(normalizeEmail('jane at ya hoo dot com')).toBe('jane@yahoo.com');
    expect(normalizeEmail('jane at out look dot com')).toBe('jane@outlook.com');
  });

  it('repairs phonetic manglings of common domains', () => {
    expect(normalizeEmail('jane at hotmale dot com')).toBe('jane@hotmail.com');
    expect(normalizeEmail('jane at gmial dot com')).toBe('jane@gmail.com');
    expect(normalizeEmail('jane at googlemail dot com')).toBe('jane@gmail.com');
    expect(normalizeEmail('jane at outlok dot com')).toBe('jane@outlook.com');
  });

  it('does not "repair" a local part that merely contains a domain name', () => {
    expect(normalizeEmail('gmailteam at example dot com')).toBe('gmailteam@example.com');
  });

  it('leaves words that merely contain "at" or "dot" alone', () => {
    expect(normalizeEmail('dotty at example dot com')).toBe('dotty@example.com');
    expect(normalizeEmail('nathan at example dot com')).toBe('nathan@example.com');
  });

  it('drops sentence-final punctuation', () => {
    expect(normalizeEmail('kamil at gmail dot com.')).toBe('kamil@gmail.com');
  });

  it('returns null when no plausible address results', () => {
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
    expect(normalizeEmail('I do not have one')).toBeNull();
    expect(normalizeEmail('kamil at')).toBeNull();
    expect(normalizeEmail('at gmail dot com')).toBeNull();
    expect(normalizeEmail('kamil at gmail at yahoo dot com')).toBeNull();
    expect(normalizeEmail('kamil at localhost')).toBeNull();
  });
});
