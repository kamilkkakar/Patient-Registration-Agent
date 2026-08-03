// The clinic day, as a set of instants. Pure: no clock, no database.

import { describe, expect, it } from 'vitest';
import { clinicDayGrid } from '../../src/services/availability.js';
import { utcToClinicMinutes } from '../../src/lib/clinic-time.js';
import { CLINIC_TIMEZONE } from '../../src/config/clinic.js';

describe('clinicDayGrid', () => {
  it('offers sixteen half-hour slots from 9 AM to 4:30 PM', () => {
    const grid = clinicDayGrid({ year: 2026, month: 8, day: 3 }); // Monday
    expect(grid).toHaveLength(16);
    expect(utcToClinicMinutes(grid[0]!, CLINIC_TIMEZONE)).toBe(9 * 60);
    expect(utcToClinicMinutes(grid[15]!, CLINIC_TIMEZONE)).toBe(16 * 60 + 30);
  });

  it('is empty at the weekend', () => {
    expect(clinicDayGrid({ year: 2026, month: 8, day: 8 })).toEqual([]); // Sat
    expect(clinicDayGrid({ year: 2026, month: 8, day: 9 })).toEqual([]); // Sun
  });

  it('still starts at 9 AM local on the Monday after a DST switch', () => {
    // Be precise about what this proves. US DST transitions land on a SUNDAY, so
    // a clinic day never contains one — the grid cannot gain or lose an hour
    // mid-day. What DOES change is the offset from one week to the next, and a
    // hard-coded offset silently shifts every slot by an hour from here on.
    //
    // 2026-11-01 is the fall-back; this is the Monday after it.
    const grid = clinicDayGrid({ year: 2026, month: 11, day: 2 });
    expect(grid).toHaveLength(16);
    expect(utcToClinicMinutes(grid[0]!, CLINIC_TIMEZONE)).toBe(9 * 60);
    // 9 AM CST is 15:00Z; before the switch the same wall time was 14:00Z.
    expect(grid[0]!.toISOString()).toBe('2026-11-02T15:00:00.000Z');
  });

  it('produces strictly increasing instants', () => {
    const grid = clinicDayGrid({ year: 2026, month: 8, day: 3 });
    const times = grid.map((d) => d.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
  });
});
