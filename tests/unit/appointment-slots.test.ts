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
import { SLOT_ID_PATTERN } from '../../src/validation/appointment.js';

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
    expect(getAvailableSlots(FRIDAY_MIDDAY).map((slot) => slot.spokenTime)).toEqual([
      'Monday, August 10 at 9 AM',
      'Tuesday, August 11 at 9 AM',
      'Wednesday, August 12 at 9 AM',
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
