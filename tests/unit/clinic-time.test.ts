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
