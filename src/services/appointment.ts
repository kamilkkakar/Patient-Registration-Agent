// Business logic for the Appointment resource (bonus: post-registration
// scheduling), plus the WEEKDAYS/MONTHS tables and `formatSpokenTime` that
// `src/services/availability.ts` reuses to speak a slot back to the caller.
//
// Like `services/patient.ts`, this is a layer that MAY touch Prisma; the Vapi
// tool handlers and the routes must not.
//
// The slot catalogue itself — which instants are open — now lives in
// `availability.ts`, derived from clinic hours minus live bookings (see its
// header comment). This file no longer offers or resolves slots; it only
// persists what availability already validated.

import type { Appointment } from '@prisma/client';
import { CLINIC_TIMEZONE } from '../config/clinic.js';
import { clinicWeekday, utcToClinicDate, utcToClinicMinutes } from '../lib/clinic-time.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { getPatientById } from './patient.js';

// ---------------------------------------------------------------------------
// Spoken time formatting — shared with availability.ts
// ---------------------------------------------------------------------------

/**
 * Hand-rolled rather than `Intl.DateTimeFormat`, for the same reason
 * `src/lib/serialize.ts` builds its own MM/DD/YYYY: ICU output varies by Node
 * build and locale data, and this string is asserted in tests and read aloud on
 * a live call. Indexed by `getUTCDay()` / `getUTCMonth()`.
 */
const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * Exported because `cancel_appointment` has to say WHICH time it released, and
 * it only has the stored row — not a `Slot` from `availability.ts`.
 *
 * Reads CLINIC-LOCAL components, not UTC. Every caller of this function deals
 * in clinic-local wall time: `src/services/availability.ts` builds its slots
 * by converting clinic-local hours to UTC instants (`zonedWallTimeToUtc`).
 * Reading `getUTCHours()` here would announce a 1 PM Central slot as "7 PM" on
 * a live call — the offset is silent in the data and only shows up in what
 * gets spoken. Do not "simplify" this back to the UTC getters.
 */
export function formatSpokenTime(scheduledFor: Date): string {
  const clinicDate = utcToClinicDate(scheduledFor, CLINIC_TIMEZONE);
  const clinicMinutes = utcToClinicMinutes(scheduledFor, CLINIC_TIMEZONE);

  // `?? ''` satisfies noUncheckedIndexedAccess; clinicWeekday and month are
  // always in range, so the fallback is unreachable.
  const weekday = WEEKDAYS[clinicWeekday(clinicDate)] ?? '';
  const month = MONTHS[clinicDate.month - 1] ?? '';
  const hour24 = Math.floor(clinicMinutes / 60);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const meridiem = hour24 < 12 ? 'AM' : 'PM';
  const minute = clinicMinutes % 60;

  // Include minutes only when non-zero. Slots are every 30 minutes; on-the-hour
  // times like "9 AM" are how people speak them, and "9:00 AM" read by TTS is
  // worse. Off-hour times like "9:30 AM" disambiguate adjacent 30-minute slots.
  const timeStr = minute === 0
    ? `${String(hour12)} ${meridiem}`
    : `${String(hour12)}:${String(minute).padStart(2, '0')} ${meridiem}`;

  return `${weekday}, ${month} ${String(clinicDate.day)} at ${timeStr}`;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * The statuses that count as a live booking.
 *
 * A WHITELIST, deliberately, rather than a blacklist of CANCELLED. COMPLETED is
 * equally not-upcoming and equally unreachable today, and a whitelist keeps a
 * status added later from silently counting as active. The dashboard applies the
 * same rule in `public/dashboard-helpers.js`, so voice and UI agree on what
 * "upcoming" means.
 */
export const ACTIVE_APPOINTMENT_STATUSES = ['SCHEDULED', 'CONFIRMED'] as const;

export interface BookAppointmentInput {
  patientId: string;
  scheduledFor: Date;
}

/**
 * Book one open slot. `status` defaults to SCHEDULED in the schema.
 *
 * `getPatientById` is what enforces the soft-delete rule here: it throws
 * NotFoundError for both "no such patient" and "tombstoned patient", so a
 * deleted record is unbookable exactly as it is unreadable. Anything else would
 * let a row that is invisible on every read path acquire new children.
 *
 * Read-then-write, unlike `updatePatient` — and it cannot be collapsed. Prisma's
 * `connect` matches on unique fields only, so the `deleted_at IS NULL` predicate
 * cannot travel with the INSERT. The residual race is a delete landing between
 * the check and the insert; the appointment is then attached to a tombstoned
 * patient, where it is unreachable (`GET /patients/:id/appointments` 404s) and
 * harmless.
 */
export async function bookAppointment(input: BookAppointmentInput): Promise<Appointment> {
  await getPatientById(input.patientId);

  return prisma.appointment.create({
    data: { patientId: input.patientId, scheduledFor: input.scheduledFor },
  });
}

/**
 * Every appointment for one patient, furthest-out first.
 *
 * The live-patient check lives HERE, not in the route — unlike
 * `listCallTranscriptsByPatientId`, whose caller does it. `bookAppointment`
 * needs the same rule and cannot delegate it upwards, so both functions in this
 * module enforce it and there is one place to review. A patient with no
 * appointments returns an empty array; an unknown or deleted one throws.
 */
export async function listAppointmentsForPatient(patientId: string): Promise<Appointment[]> {
  await getPatientById(patientId);

  return prisma.appointment.findMany({
    where: { patientId },
    orderBy: { scheduledFor: 'desc' },
  });
}

export interface ChangeAppointmentInput {
  appointmentId: string;
  patientId: string;
  /** Injected so a test pins "past" instead of chasing the clock. */
  now: Date;
}

/**
 * Load an appointment this patient is allowed to change, or throw.
 *
 * The query is scoped to BOTH ids on purpose, and that is not belt-and-braces.
 * Appointment ids reach this layer from a language model on a phone call; an id
 * it invented, misheard, or carried over from earlier in the conversation would
 * otherwise modify a stranger's booking. Ownership is enforced in the WHERE
 * clause rather than checked afterwards, so there is no window between the read
 * and the decision.
 *
 * "No such appointment" and "not yours" throw the SAME NotFoundError with the
 * same message. Telling them apart would turn this into an oracle for whether an
 * arbitrary appointment id exists.
 */
async function requireChangeableAppointment(input: ChangeAppointmentInput): Promise<Appointment> {
  // Throws for unknown AND soft-deleted, so a tombstoned patient's appointments
  // are unreachable here exactly as they are on every other read path.
  await getPatientById(input.patientId);

  const appointment = await prisma.appointment.findFirst({
    where: { id: input.appointmentId, patientId: input.patientId },
  });

  if (appointment === null) {
    throw new NotFoundError('No appointment with that id exists for this patient.');
  }

  if (appointment.status === 'CANCELLED') {
    throw new ValidationError('That appointment was already cancelled.', [
      { field: 'appointment_id', message: 'Already cancelled.' },
    ]);
  }

  if (appointment.scheduledFor <= input.now) {
    throw new ValidationError('That appointment has already passed.', [
      { field: 'appointment_id', message: 'Already passed.' },
    ]);
  }

  return appointment;
}

/**
 * Move an existing appointment to a new slot.
 *
 * In place: one appointment, one row. `created_at` is deliberately untouched, so
 * the record still says when the caller rang in to book; `updated_at` moves on
 * its own via @updatedAt.
 *
 * Rescheduling to the slot already held is allowed and is a no-op write. A
 * caller confirming the time they already have has not made a mistake, and
 * refusing it would produce a confusing re-prompt for a harmless request.
 */
export async function rescheduleAppointment(
  input: ChangeAppointmentInput & { scheduledFor: Date },
): Promise<Appointment> {
  const existing = await requireChangeableAppointment(input);

  return prisma.appointment.update({
    where: { id: existing.id },
    data: {
      scheduledFor: input.scheduledFor,
      // Where it came FROM, so a moved booking stays legible. The update is in
      // place, so without this the row is indistinguishable afterwards from one
      // booked at the new time. Overwritten on each move — one hop, not a history.
      rescheduledFrom: existing.scheduledFor,
    },
  });
}

/**
 * Cancel an appointment without deleting it.
 *
 * `scheduled_for` is deliberately left alone: the row should still show WHICH
 * slot was given up, which is the only thing that makes a cancellation legible
 * afterwards. Nothing in this project hard-deletes — patients get `deleted_at`,
 * appointments get a status.
 *
 * The row stays visible in `GET /appointments`, labelled. Filtering it out there
 * would destroy the reason for keeping it.
 */
export async function cancelAppointment(input: ChangeAppointmentInput): Promise<Appointment> {
  const existing = await requireChangeableAppointment(input);

  return prisma.appointment.update({
    where: { id: existing.id },
    data: { status: 'CANCELLED' },
  });
}

/**
 * Future, still-live appointments for one patient, soonest first.
 *
 * Distinct from `listAppointmentsForPatient`, which returns the lot newest-first
 * for the REST read path. This one answers a different question — "what can the
 * caller still change?" — so it filters to the active statuses and to slots that
 * have not happened yet, and orders ASCENDING because the soonest is the one a
 * caller means when they say "my appointment".
 *
 * `now` is injected for the same reason `findAvailability` takes it: a test pins
 * the answer instead of chasing the clock.
 */
export async function listUpcomingAppointmentsForPatient(
  patientId: string,
  now: Date,
): Promise<Appointment[]> {
  await getPatientById(patientId);

  return prisma.appointment.findMany({
    where: {
      patientId,
      status: { in: [...ACTIVE_APPOINTMENT_STATUSES] },
      scheduledFor: { gt: now },
    },
    orderBy: { scheduledFor: 'asc' },
  });
}

/**
 * Every appointment in the registry, soonest first.
 *
 * The soft-delete rule travels as a RELATION filter, so a tombstoned patient's
 * appointments never leave Postgres. Fetching everything and dropping the dead
 * ones in JS would give the same answer today and the wrong one the moment the
 * query grows a `take` — the rule has to be part of the predicate.
 *
 * Ascending, unlike `listAppointmentsForPatient`. That view answers "what was
 * booked", newest first; this one answers "what is coming up", which is the
 * order the dashboard reads to find each patient's next appointment.
 */
export async function listAllAppointments(): Promise<Appointment[]> {
  return prisma.appointment.findMany({
    where: { patient: { deletedAt: null } },
    orderBy: { scheduledFor: 'asc' },
  });
}
