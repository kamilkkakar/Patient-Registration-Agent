import { describe, expect, it } from 'vitest';

import { normalizeState } from '../../src/normalize/state.js';

/** Every code the normalizer is required to know: 50 states + DC + PR. */
const REQUIRED = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
  Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA',
  Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA',
  Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
  Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS',
  Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV',
  'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK',
  Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT',
  Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI',
  Wyoming: 'WY', 'District of Columbia': 'DC', 'Puerto Rico': 'PR',
} as const;

describe('normalizeState', () => {
  it('maps all 50 states plus DC and PR from their full names', () => {
    const entries = Object.entries(REQUIRED);
    expect(entries).toHaveLength(52);

    for (const [name, code] of entries) {
      expect(normalizeState(name)).toBe(code);
    }
  });

  it('is case-insensitive on full names', () => {
    expect(normalizeState('california')).toBe('CA');
    expect(normalizeState('CALIFORNIA')).toBe('CA');
    expect(normalizeState('New   York')).toBe('NY');
  });

  it('passes through valid 2-letter codes, uppercased', () => {
    expect(normalizeState('tx')).toBe('TX');
    expect(normalizeState('TX')).toBe('TX');
    expect(normalizeState(' ny ')).toBe('NY');
  });

  it('joins a code read aloud as separate letters', () => {
    expect(normalizeState('T X')).toBe('TX');
    expect(normalizeState('N. Y.')).toBe('NY');
  });

  it('resolves the DC variants without falling through to Washington', () => {
    expect(normalizeState('DC')).toBe('DC');
    expect(normalizeState('D.C.')).toBe('DC');
    expect(normalizeState('Washington DC')).toBe('DC');
    expect(normalizeState('Washington, D.C.')).toBe('DC');
    expect(normalizeState('District of Columbia')).toBe('DC');
  });

  it('distinguishes Washington the state from Washington DC', () => {
    expect(normalizeState('Washington')).toBe('WA');
    expect(normalizeState('Washington State')).toBe('WA');
    expect(normalizeState('State of Washington')).toBe('WA');
  });

  it('knows the remaining territories', () => {
    expect(normalizeState('Guam')).toBe('GU');
    expect(normalizeState('American Samoa')).toBe('AS');
    expect(normalizeState('Virgin Islands')).toBe('VI');
    expect(normalizeState('Northern Mariana Islands')).toBe('MP');
  });

  it('returns null for anything that is not a real state', () => {
    expect(normalizeState('')).toBeNull();
    expect(normalizeState('   ')).toBeNull();
    expect(normalizeState('Narnia')).toBeNull();
    expect(normalizeState('XX')).toBeNull();
    expect(normalizeState('ZZ')).toBeNull();
    expect(normalizeState('Mexico')).toBeNull();
    expect(normalizeState('Ontario')).toBeNull();
  });
});
