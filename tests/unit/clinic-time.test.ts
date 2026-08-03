// Civil (wall-clock) time in the clinic's zone <-> UTC instants.
//
// WHY this suite is the one that matters: every slot the agent speaks is a
// clinic-local wall time, and every slot it stores is a UTC instant. If this
// conversion is wrong the agent offers 4 AM appointments in a confident voice —
// which is exactly what the fixed 09:00 UTC hour was doing before this change.

import { describe, expect, it } from 'vitest';
import {
  addClinicDays,
  clinicWeekday,
  utcToClinicDate,
  utcToClinicMinutes,
  zonedWallTimeToUtc,
} from '../../src/lib/clinic-time.js';
import { CLINIC_TIMEZONE } from '../../src/config/clinic.js';

const TZ = CLINIC_TIMEZONE; // America/Chicago

describe('zonedWallTimeToUtc', () => {
  it('maps 9 AM Central in summer to 14:00 UTC (CDT, UTC-5)', () => {
    const utc = zonedWallTimeToUtc({ year: 2026, month: 8, day: 3 }, 9 * 60, TZ);
    expect(utc.toISOString()).toBe('2026-08-03T14:00:00.000Z');
  });

  it('maps 9 AM Central in winter to 15:00 UTC (CST, UTC-6)', () => {
    // WHY both seasons: a fixed offset passes one and fails the other, which is
    // the whole reason this is not a constant.
    const utc = zonedWallTimeToUtc({ year: 2026, month: 1, day: 5 }, 9 * 60, TZ);
    expect(utc.toISOString()).toBe('2026-01-05T15:00:00.000Z');
  });

  it('handles the spring-forward day without drifting', () => {
    // 2026-03-08 is the US DST switch. 9 AM local is still 9 AM local.
    const utc = zonedWallTimeToUtc({ year: 2026, month: 3, day: 8 }, 9 * 60, TZ);
    expect(utcToClinicMinutes(utc, TZ)).toBe(9 * 60);
  });

  it('round-trips every clinic hour on the switch day', () => {
    for (let m = 9 * 60; m < 17 * 60; m += 30) {
      const utc = zonedWallTimeToUtc({ year: 2026, month: 11, day: 1 }, m, TZ);
      expect(utcToClinicMinutes(utc, TZ)).toBe(m);
    }
  });

  // WHY 2:00-7:00 AM: OPEN_MINUTES = 540 (9 AM) means the clinic never
  // actually offers a slot this early, so every assertion above stays inside
  // 9 AM-4:30 PM, where firstOffset === secondOffset on both 2026 transition
  // days — the second offsetMinutesAt call never fires and a one-pass mutant
  // (return firstGuess directly) would pass all of them unchanged. These two
  // tests are the ones that actually require the second pass. Unreachable
  // through today's opening hours, but the algorithm's correctness there is
  // real and becomes load-bearing the moment those hours change.
  it('corrects the second pass across the spring-forward gap (Mar 8, 07:00 local)', () => {
    // 2 AM CST becomes 3 AM CDT at 08:00Z. A one-pass guess evaluates the
    // offset before the jump and lands on 13:00Z; the second pass sees the
    // corrected (CDT) offset and lands on 12:00Z.
    const utc = zonedWallTimeToUtc({ year: 2026, month: 3, day: 8 }, 7 * 60, TZ);
    expect(utc.toISOString()).toBe('2026-03-08T12:00:00.000Z');
  });

  it('corrects the second pass across the fall-back overlap (Nov 1, 02:00 local)', () => {
    // 2 AM CDT becomes 1 AM CST at 07:00Z, so "02:00 local" is ambiguous. A
    // one-pass guess stops at the pre-transition (CDT) reading, 07:00Z; the
    // second pass resolves it to the post-transition (CST) reading, 08:00Z.
    const utc = zonedWallTimeToUtc({ year: 2026, month: 11, day: 1 }, 2 * 60, TZ);
    expect(utc.toISOString()).toBe('2026-11-01T08:00:00.000Z');
  });
});

describe('utcToClinicDate', () => {
  it('reports the clinic day, not the UTC day', () => {
    // 02:00Z on the 4th is 9 PM Central on the 3rd.
    expect(utcToClinicDate(new Date('2026-08-04T02:00:00.000Z'), TZ)).toEqual({
      year: 2026, month: 8, day: 3,
    });
  });
});

describe('clinicWeekday and addClinicDays', () => {
  it('reads a civil date as a weekday without timezone involvement', () => {
    expect(clinicWeekday({ year: 2026, month: 8, day: 3 })).toBe(1); // Monday
    expect(clinicWeekday({ year: 2026, month: 8, day: 8 })).toBe(6); // Saturday
  });

  it('rolls over month ends', () => {
    expect(addClinicDays({ year: 2026, month: 8, day: 31 }, 1)).toEqual({
      year: 2026, month: 9, day: 1,
    });
  });
});
