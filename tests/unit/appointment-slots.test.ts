// Argument schemas for reschedule / cancel (bonus scheduling tools).
//
// The fixed mock slot catalogue this file used to test was deleted in favour
// of real availability (`src/services/availability.ts`, exercised in
// `tests/unit/availability-grid.test.ts` and `tests/api/availability.test.ts`,
// which hit a real database). What is left here is purely the Zod schema
// behaviour, which has no database dependency and belongs in `tests/unit`.

import { describe, expect, it } from 'vitest';
import {
  cancelAppointmentSchema,
  rescheduleAppointmentSchema,
} from '../../src/validation/appointment.js';

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
