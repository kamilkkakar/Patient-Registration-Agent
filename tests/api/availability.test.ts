// Availability against a real database.
//
// The ranking is the point: sorting by distance from what the caller asked for
// is what turns "do you have Monday at 1 PM?" into "not at one, but I could do
// half past one" — instead of "those are the only three times I have".

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  clinicDayGrid,
  findAvailability,
  parseSlotId,
  resolveOpenSlot,
} from '../../src/services/availability.js';
import { bookAppointment, formatSpokenTime } from '../../src/services/appointment.js';
import { zonedWallTimeToUtc, utcToClinicMinutes } from '../../src/lib/clinic-time.js';
import { CLINIC_TIMEZONE } from '../../src/config/clinic.js';
import { api, purgeTestPatients, startTestApp, testLastName, validPayload } from '../helpers.js';

let app: FastifyInstance;

// A Friday well clear of other suites' fixtures.
const NOW = new Date('2026-12-03T12:00:00.000Z'); // Thursday
const MONDAY = { year: 2026, month: 12, day: 7 };
const at = (minutes: number): Date => zonedWallTimeToUtc(MONDAY, minutes, CLINIC_TIMEZONE);

beforeAll(async () => {
  await purgeTestPatients();
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
  await purgeTestPatients();
});

async function createPatient(suffix: string): Promise<string> {
  const res = await api(app).post('/patients').send(validPayload({ last_name: testLastName(suffix) }));
  expect(res.status).toBe(201);
  return String((res.body.data as Record<string, unknown>)['patient_id']);
}

describe('findAvailability', () => {
  it('returns the exact time when it is open', async () => {
    const result = await findAvailability({
      now: NOW,
      preference: { kind: 'time', date: MONDAY, minutesOfDay: 13 * 60 },
    });

    expect(result.matched).not.toBeNull();
    expect(utcToClinicMinutes(result.matched!.scheduledFor, CLINIC_TIMEZONE)).toBe(13 * 60);
    expect(result.outsideClinicHours).toBe(false);
  });

  it('offers the NEAREST open times when the exact one is taken', async () => {
    // WHY: this is the failed call, encoded. The caller asked for 1 PM; the
    // useful answer is 12:30 or 1:30, not "those are the only times I have".
    const patientId = await createPatient('Availnearest');
    await bookAppointment({ patientId, scheduledFor: at(13 * 60) });

    const result = await findAvailability({
      now: NOW,
      preference: { kind: 'time', date: MONDAY, minutesOfDay: 13 * 60 },
    });

    expect(result.matched).toBeNull();
    expect(result.alternatives.length).toBeGreaterThan(0);
    const offered = result.alternatives.map((s) => utcToClinicMinutes(s.scheduledFor, CLINIC_TIMEZONE));
    expect(offered).toContain(12 * 60 + 30);
    expect(offered).toContain(13 * 60 + 30);
  });

  it('distinguishes a booked-out day from a closed one', async () => {
    // WHY: same empty result, completely different sentence. The model cannot
    // tell them apart from an empty array.
    const closed = await findAvailability({
      now: NOW,
      preference: { kind: 'time', date: MONDAY, minutesOfDay: 20 * 60 },
    });

    expect(closed.outsideClinicHours).toBe(true);
    expect(closed.dayFullyBooked).toBe(false);
    expect(closed.alternatives.length).toBeGreaterThan(0);
  });

  it('reports dayFullyBooked only when every remaining grid slot is actually taken', async () => {
    // WHY: the ONLY state that should ever produce dayFullyBooked: true — a
    // working day that still has slots ahead of `now`, and all 16 are booked.
    // Nothing before fix round 2 ever drove this to true; every prior test
    // (and the whole codebase) only asserted `false`.
    const TUESDAY = { year: 2026, month: 12, day: 8 };
    const patientId = await createPatient('Availfullybooked');
    for (const instant of clinicDayGrid(TUESDAY)) {
      await bookAppointment({ patientId, scheduledFor: instant });
    }

    const result = await findAvailability({
      now: NOW,
      preference: { kind: 'day', date: TUESDAY },
    });

    expect(result.dayFullyBooked).toBe(true);
    expect(result.outsideClinicHours).toBe(false);
    // A fully booked Tuesday does not stop the model offering a different day.
    expect(result.alternatives.length).toBeGreaterThan(0);

    // Discriminating check: SAME date, SAME 16 bookings above — only `now`
    // moves past Tuesday's close. The old logic
    // (`isWorkingDay && onDay.length === 0`) never looked at whether a grid
    // slot was still ahead of `now`, so it would read `true` here too; only
    // the "remaining grid" gate this fix added tells "booked out" apart from
    // "nothing left to book because the day is over".
    const afterTuesdayClose = zonedWallTimeToUtc(TUESDAY, 17 * 60, CLINIC_TIMEZONE);
    const pastClose = await findAvailability({
      now: afterTuesdayClose,
      preference: { kind: 'day', date: TUESDAY },
    });
    expect(pastClose.dayFullyBooked).toBe(false);
  });

  it('does NOT report dayFullyBooked for "closed for today" — fix round 2\'s bug', async () => {
    // Reviewer's exact scenario (fix round 2): `now` sits right at closing
    // time on the requested day, and nothing was ever booked. The old logic
    // conflated "no future grid slots left today" with "booked out", so it
    // reported dayFullyBooked: true — the agent would say "Monday is
    // completely booked up" for a day that had simply ended.
    //
    // The correct pair of flags here is BOTH false, and each says a different
    // true thing: outsideClinicHours stays false because Monday itself is a
    // normal working day (the flag answers "is the requested day/time ever
    // open", not "has today already happened") — dayFullyBooked is false
    // because there is nothing left TO book out; `remainingOnDay` (today's
    // grid slots still ahead of `now`) is empty. Neither sentence is "fully
    // booked"; the correct one is simply "we're closed for today".
    const closingTime = at(17 * 60); // 17:00 Central = clinic just closed

    const dayResult = await findAvailability({
      now: closingTime,
      preference: { kind: 'day', date: MONDAY },
    });
    expect(dayResult.dayFullyBooked).toBe(false);
    expect(dayResult.outsideClinicHours).toBe(false);
    // Alternatives come from Wednesday Dec 9 onward regardless of whether the
    // preceding test's Tuesday-fully-booked fixture has run — Monday itself
    // contributes nothing (day is over) and Tuesday may or may not be full,
    // but the 14-day search window always has an open day further out. Not an
    // ordering dependency on the test above, only a shared date range.
    expect(dayResult.alternatives.length).toBeGreaterThan(0);

    // Same bug, the `kind: 'time'` branch — the reviewer's scenario applies to
    // both, not just `kind: 'day'`.
    const timeResult = await findAvailability({
      now: closingTime,
      preference: { kind: 'time', date: MONDAY, minutesOfDay: 13 * 60 },
    });
    expect(timeResult.dayFullyBooked).toBe(false);
    expect(timeResult.outsideClinicHours).toBe(false);
    expect(timeResult.matched).toBeNull();
  });

  it('never offers a slot in the past', async () => {
    const result = await findAvailability({ now: NOW, preference: { kind: 'any' } });
    for (const slot of result.alternatives) {
      expect(slot.scheduledFor.getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it('caps what it returns so the tool result stays speakable', async () => {
    const result = await findAvailability({ now: NOW, preference: { kind: 'any' } });
    expect(result.alternatives.length).toBeLessThanOrEqual(3);
  });
});

describe('formatSpokenTime — clinic-local, not UTC', () => {
  // WHY this exists: `findAvailability` builds slots by converting
  // clinic-local wall time to UTC (`zonedWallTimeToUtc`). `formatSpokenTime`
  // used to read UTC components straight off that instant — correct for the
  // OLD fixed-UTC mock catalogue, wrong the moment a clinic-local instant is
  // fed in: clinic-local 1 PM Central would be announced as "7 PM". A single
  // hard-coded offset cannot be right in both seasons, so this pins one winter
  // case (CST, UTC-6) and one summer case (CDT, UTC-5).
  it('speaks clinic-local time in winter (CST, UTC-6)', () => {
    const winterSlot = zonedWallTimeToUtc(MONDAY, 13 * 60, CLINIC_TIMEZONE);
    expect(winterSlot.toISOString()).toBe('2026-12-07T19:00:00.000Z');
    expect(formatSpokenTime(winterSlot)).toBe('Monday, December 7 at 1 PM');
  });

  it('speaks clinic-local time in summer (CDT, UTC-5)', () => {
    const JULY_MONDAY = { year: 2026, month: 7, day: 6 };
    const summerSlot = zonedWallTimeToUtc(JULY_MONDAY, 13 * 60, CLINIC_TIMEZONE);
    expect(summerSlot.toISOString()).toBe('2026-07-06T18:00:00.000Z');
    expect(formatSpokenTime(summerSlot)).toBe('Monday, July 6 at 1 PM');
  });

  it('renders a :30 slot with minutes included', () => {
    const halfHourSlot = zonedWallTimeToUtc(MONDAY, 9 * 60 + 30, CLINIC_TIMEZONE);
    expect(formatSpokenTime(halfHourSlot)).toBe('Monday, December 7 at 9:30 AM');
  });

  it('renders an on-the-hour slot without :00', () => {
    const onTheHourSlot = zonedWallTimeToUtc(MONDAY, 9 * 60, CLINIC_TIMEZONE);
    expect(formatSpokenTime(onTheHourSlot)).not.toContain(':00');
  });

  it('makes two adjacent 30-minute slots sound different', () => {
    const slot1 = zonedWallTimeToUtc(MONDAY, 9 * 60, CLINIC_TIMEZONE);
    const slot2 = zonedWallTimeToUtc(MONDAY, 9 * 60 + 30, CLINIC_TIMEZONE);
    const time1 = formatSpokenTime(slot1);
    const time2 = formatSpokenTime(slot2);
    expect(time1).not.toBe(time2);
  });
});

describe('parseSlotId', () => {
  it('rebuilds the instant without handing the string to new Date()', () => {
    expect(parseSlotId('slot-2026-12-07T19:00Z')?.toISOString()).toBe('2026-12-07T19:00:00.000Z');
  });

  it('rejects a malformed id', () => {
    expect(parseSlotId('2026-12-07 13:00')).toBeNull();
    expect(parseSlotId('slot-2026-13-45T99:99Z')).toBeNull();
  });
});

describe('resolveOpenSlot', () => {
  it('refuses an id that is well-formed but not on the clinic grid', async () => {
    // WHY: validation is no longer membership of a just-offered set, so the grid
    // check is what stops a caller booking 9:07 or a Sunday.
    expect(await resolveOpenSlot('slot-2026-12-07T19:07Z', NOW)).toBeNull();
    expect(await resolveOpenSlot('slot-2026-12-06T15:00Z', NOW)).toBeNull(); // Sunday
  });

  it('refuses an id that is already booked', async () => {
    const patientId = await createPatient('Availtaken');
    const slot = at(15 * 60);
    await bookAppointment({ patientId, scheduledFor: slot });

    // toISOString().slice(0, 16) is already "YYYY-MM-DDTHH:MM" — the same shape
    // toSlot builds ids from.
    const id = `slot-${slot.toISOString().slice(0, 16)}Z`;
    expect(await resolveOpenSlot(id, NOW)).toBeNull();
  });
});
