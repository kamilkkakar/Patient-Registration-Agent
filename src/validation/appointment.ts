// Zod schemas for the appointment-scheduling tool arguments (bonus).
//
// These two schemas guard the VOICE ingress only — there is no REST write path
// for appointments, so unlike `validation/patient.ts` there is no body schema
// here. `.strict()` for the same reason it is used there: an argument the model
// invented is a fault to surface, not to ignore.
//
// Wire keys are snake_case, matching the tool definitions Vapi calls with.

import { z } from 'zod';

/**
 * The shape `src/services/appointment.ts` mints: `slot-YYYY-MM-DDTHH:MMZ`.
 *
 * Declared here, in the layer that rejects bad input, and imported by nothing
 * else — the service compares ids by string equality against the offered set
 * rather than parsing them, so this pattern is the only place the format is
 * asserted. `tests/unit/appointment-slots.test.ts` pins every generated id
 * against it, which is what stops the two drifting apart.
 */
export const SLOT_ID_PATTERN = /^slot-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/;

const patientIdSchema = z.string().uuid('Must be a valid patient id.');

/** `get_appointment_slots` arguments. */
export const getAppointmentSlotsSchema = z
  .object({
    patient_id: patientIdSchema,
  })
  .strict();

/** `book_appointment` arguments. */
export const bookAppointmentSchema = z
  .object({
    patient_id: patientIdSchema,
    slot_id: z
      .string()
      .trim()
      .regex(SLOT_ID_PATTERN, 'Must be one of the slot ids returned by get_appointment_slots.'),
  })
  .strict();

export type BookAppointmentWire = z.output<typeof bookAppointmentSchema>;
