// The mock slot catalogue — pure, deterministic, no clock and no database.
//
// WHY this suite exists: the offered times are the one part of scheduling the
// model is NOT allowed to invent (Rule 5). If `getAvailableSlots` ever drifted
// into reading `Date.now()`, or stopped skipping the weekend, the failure would
// be a clinic booking a Sunday appointment on a live call — invisible to every
// other test in the suite, which never inspects a slot date.
//
// Every case pins `now` explicitly. The suite runs at TZ=America/Los_Angeles
// (vitest.config.ts), so a local-time reading of any of these dates lands on a
// different calendar day and the assertions fail — which is the point.

import { describe, expect, it } from 'vitest';
import { findSlotById, getAvailableSlots } from '../../src/services/appointment.js';
import {
  cancelAppointmentSchema,
  rescheduleAppointmentSchema,
  SLOT_ID_PATTERN,
} from '../../src/validation/appointment.js';

// 2026-08-07 is a Friday; 08-08 Saturday, 08-09 Sunday, 08-10 Monday.
const FRIDAY_MIDDAY = new Date('2026-08-07T12:00:00.000Z');
const SATURDAY_LATE = new Date('2026-08-08T23:30:00.000Z');
const MONDAY_EARLY = new Date('2026-08-10T08:00:00.000Z');

const NEXT_WEEK = ['2026-08-10T09:00:00.000Z', '2026-08-11T09:00:00.000Z', '2026-08-12T09:00:00.000Z'];

function instants(now: Date): string[] {
  return getAvailableSlots(now).map((slot) => slot.scheduledFor.toISOString());
}

describe('getAvailableSlots', () => {
  it('returns the same three slots for the same `now`, every time', () => {
    // Determinism is the contract: the id the model reads back must still
    // resolve on the next tool call, and there is no server-side state to fall
    // back on if it does not.
    expect(instants(FRIDAY_MIDDAY)).toEqual(instants(FRIDAY_MIDDAY));
    expect(getAvailableSlots(FRIDAY_MIDDAY)).toHaveLength(3);
  });

  it('skips the weekend from a Friday — the next slot is Monday, not Saturday', () => {
    expect(instants(FRIDAY_MIDDAY)).toEqual(NEXT_WEEK);
  });

  it('skips the weekend from a Saturday too', () => {
    // A call taken on the weekend must not offer "tomorrow" (Sunday).
    expect(instants(SATURDAY_LATE)).toEqual(NEXT_WEEK);
  });

  it('never offers a slot on the same day as the call, even at 08:00', () => {
    // 09:00 is an hour away when this call lands. Offering it would book a
    // patient into a slot they cannot reach.
    const first = instants(MONDAY_EARLY)[0];

    expect(first).toBe('2026-08-11T09:00:00.000Z');
    expect(new Date(first ?? 0).getTime()).toBeGreaterThan(MONDAY_EARLY.getTime());
  });

  it('offers 09:00 UTC on a weekday, always', () => {
    for (const slot of getAvailableSlots(SATURDAY_LATE)) {
      expect(slot.scheduledFor.getUTCHours()).toBe(9);
      expect(slot.scheduledFor.getUTCMinutes()).toBe(0);
      expect([1, 2, 3, 4, 5]).toContain(slot.scheduledFor.getUTCDay());
    }
  });

  it('mints ids the validation layer accepts — the two must not drift', () => {
    // `SLOT_ID_PATTERN` gates every incoming slot_id. If the minted format ever
    // stopped matching it, book_appointment would reject every id it just
    // handed out, and nothing else in the suite would notice.
    for (const slot of getAvailableSlots(FRIDAY_MIDDAY)) {
      expect(slot.slotId).toMatch(SLOT_ID_PATTERN);
    }
  });

  it('encodes the instant in the id and reads UTC, not local time', () => {
    expect(getAvailableSlots(FRIDAY_MIDDAY).map((slot) => slot.slotId)).toEqual([
      'slot-2026-08-10T09:00Z',
      'slot-2026-08-11T09:00Z',
      'slot-2026-08-12T09:00Z',
    ]);
  });

  it('spells the time out for the voice model to read aloud', () => {
    // `spokenTime` reads CLINIC-LOCAL time (formatSpokenTime, appointment.ts),
    // not the UTC hour these ids are stored at. 09:00 UTC in August is Central
    // Daylight Time (UTC-5), so the spoken hour is 4 AM, not 9 AM — the
    // mismatch between "stored at 09:00 UTC" and "read aloud at 9 AM" is
    // exactly the bug the clinic-availability feature fixed.
    expect(getAvailableSlots(FRIDAY_MIDDAY).map((slot) => slot.spokenTime)).toEqual([
      'Monday, August 10 at 4 AM',
      'Tuesday, August 11 at 4 AM',
      'Wednesday, August 12 at 4 AM',
    ]);
  });
});

describe('findSlotById', () => {
  it('resolves an id that is currently on offer', () => {
    const slot = findSlotById('slot-2026-08-11T09:00Z', FRIDAY_MIDDAY);

    expect(slot?.scheduledFor.toISOString()).toBe('2026-08-11T09:00:00.000Z');
  });

  it('rejects a well-formed id that is NOT on offer', () => {
    // Membership, not parsing: a Sunday, a past date and a 3 AM slot are all
    // syntactically fine and none of them may be booked.
    expect(findSlotById('slot-2026-08-09T09:00Z', FRIDAY_MIDDAY)).toBeNull();
    expect(findSlotById('slot-2020-01-06T09:00Z', FRIDAY_MIDDAY)).toBeNull();
    expect(findSlotById('slot-2026-08-11T03:00Z', FRIDAY_MIDDAY)).toBeNull();
  });

  it('rejects junk without throwing', () => {
    expect(findSlotById('', FRIDAY_MIDDAY)).toBeNull();
    expect(findSlotById('tuesday morning', FRIDAY_MIDDAY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// reschedule / cancel argument schemas
// ---------------------------------------------------------------------------

describe('reschedule and cancel argument schemas', () => {
  const APPOINTMENT_ID = '410bf206-148c-4b62-9c0c-5cdaee3e8b26';
  const PATIENT_ID = '2eff7f57-ec5f-449b-8c01-458685f03231';

  it('accepts a well-formed reschedule payload', () => {
    const parsed = rescheduleAppointmentSchema.safeParse({
      patient_id: PATIENT_ID,
      appointment_id: APPOINTMENT_ID,
      slot_id: 'slot-2026-08-03T09:00Z',
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects an extra property rather than ignoring it', () => {
    // WHY: .strict() is how an argument the model invented becomes a visible
    // fault instead of a silently dropped field. A tool definition that declares
    // a property the schema does not accept fails EVERY call, so this is the
    // test that catches the two drifting apart.
    const parsed = rescheduleAppointmentSchema.safeParse({
      patient_id: PATIENT_ID,
      appointment_id: APPOINTMENT_ID,
      slot_id: 'slot-2026-08-03T09:00Z',
      reason: 'work conflict',
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects a slot_id the model reformatted', () => {
    // WHY: the server resolves slots by MEMBERSHIP of the offered set, so a
    // reformatted id can never match. Catching it at the schema gives the caller
    // a field-specific re-prompt instead of a confusing miss.
    const parsed = rescheduleAppointmentSchema.safeParse({
      patient_id: PATIENT_ID,
      appointment_id: APPOINTMENT_ID,
      slot_id: '2026-08-03 09:00',
    });

    expect(parsed.success).toBe(false);
  });

  it('requires appointment_id to be a uuid on cancel', () => {
    // WHY: "the one on monday" is what a model produces when it did not read the
    // lookup result. Rejecting it here is cheaper than a database round trip.
    const parsed = cancelAppointmentSchema.safeParse({
      patient_id: PATIENT_ID,
      appointment_id: 'the one on monday',
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects a cancel payload carrying a slot_id', () => {
    // WHY: cancelling does not take a slot. A model sending one has confused the
    // two tools, and .strict() surfaces that rather than cancelling silently.
    const parsed = cancelAppointmentSchema.safeParse({
      patient_id: PATIENT_ID,
      appointment_id: APPOINTMENT_ID,
      slot_id: 'slot-2026-08-03T09:00Z',
    });

    expect(parsed.success).toBe(false);
  });
});
