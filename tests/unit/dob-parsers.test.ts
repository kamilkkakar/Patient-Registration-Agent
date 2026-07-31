// Two DOB parsers, two roles, two names.
//
// `src/lib/serialize.ts` and `src/normalize/date.ts` both used to export a
// function called `parseDobInput`, with DIFFERENT behaviour — one strict
// (MM/DD/YYYY or YYYY-MM-DD only), one permissive (spoken forms, 2-digit years,
// single-digit months). Nothing was broken by that, because the validation
// layer happened to import the strict one. Phase 3 wires voice input in, and
// picking the wrong one of two identically-named exports is a silent bug that
// stores a wrong date of birth in a medical record.
//
// This file pins the split so it cannot re-collapse.

import { describe, expect, it } from 'vitest';

import * as serialize from '../../src/lib/serialize.js';
import * as normalizeDate from '../../src/normalize/date.js';
import * as normalizeBarrel from '../../src/normalize/index.js';
import { parseDobStrict } from '../../src/lib/serialize.js';
import { parseSpokenDob } from '../../src/normalize/date.js';

describe('no divergent duplicate exports', () => {
  it('shares no exported NAME between serialize and normalize/date unless it is the same function', () => {
    const shared = Object.keys(serialize).filter((key) => key in normalizeDate);

    for (const key of shared) {
      const fromSerialize = (serialize as Record<string, unknown>)[key];
      const fromDate = (normalizeDate as Record<string, unknown>)[key];

      // Identity, not just equal behaviour: a second implementation with the
      // same name is exactly the hazard, even when it currently agrees.
      expect(fromDate).toBe(fromSerialize);
    }
  });

  it('exposes neither module under the old ambiguous name', () => {
    expect(Object.keys(serialize)).not.toContain('parseDobInput');
    expect(Object.keys(normalizeDate)).not.toContain('parseDobInput');
    expect(Object.keys(normalizeBarrel)).not.toContain('parseDobInput');
  });

  it('has exactly one formatDob implementation', () => {
    expect(normalizeDate.formatDob).toBe(serialize.formatDob);
    expect(normalizeBarrel.formatDob).toBe(serialize.formatDob);
  });
});

describe('parseDobStrict — the REST boundary parser', () => {
  it('accepts the two wire formats', () => {
    expect(parseDobStrict('02/15/1992')?.toISOString()).toBe('1992-02-15T00:00:00.000Z');
    expect(parseDobStrict('1992-02-15')?.toISOString()).toBe('1992-02-15T00:00:00.000Z');
  });

  it('rejects everything the voice parser would happily accept', () => {
    expect(parseDobStrict('2/15/1992')).toBeNull();
    expect(parseDobStrict('March 5th 1985')).toBeNull();
    expect(parseDobStrict('the fifth of March nineteen eighty five')).toBeNull();
    expect(parseDobStrict('3 5 85')).toBeNull();
  });
});

describe('parseSpokenDob — the voice ingress parser', () => {
  it('still accepts the spoken forms', () => {
    expect(parseSpokenDob('2/15/1992')?.toISOString()).toBe('1992-02-15T00:00:00.000Z');
    expect(parseSpokenDob('the fifth of March nineteen eighty five')?.toISOString()).toBe(
      '1985-03-05T00:00:00.000Z',
    );
    expect(parseSpokenDob('oh three oh five eighty five')?.toISOString()).toBe(
      '1985-03-05T00:00:00.000Z',
    );
  });

  it('is reachable through the normalize barrel', () => {
    expect(normalizeBarrel.parseSpokenDob).toBe(parseSpokenDob);
  });

  it('is genuinely more permissive than the strict parser', () => {
    expect(parseDobStrict('2/15/1992')).toBeNull();
    expect(parseSpokenDob('2/15/1992')).not.toBeNull();
  });
});
