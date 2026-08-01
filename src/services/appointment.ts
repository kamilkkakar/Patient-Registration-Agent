// Business logic for the Appointment resource (bonus: mock post-registration
// scheduling).
//
// Like `services/patient.ts`, this is a layer that MAY touch Prisma; the Vapi
// tool handlers and the routes must not.
//
// The slot catalogue is MOCK availability and is COMPUTED, not stored. The
// challenge asks for scheduling against mock data, so there is no clinic
// calendar to query — and Rule 5 says a deterministic transform belongs in
// code, never in the model. `getAvailableSlots` is therefore pure: no I/O, no
// randomness, no `Date.now()`. `now` is a parameter so a test pins the answer
// instead of chasing the clock.

import type { Appointment } from '@prisma/client';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { getPatientById } from './patient.js';

// ---------------------------------------------------------------------------
// Mock availability
// ---------------------------------------------------------------------------

/** How many slots are offered on one call. Three is what a caller can hold in their head. */
const SLOT_COUNT = 3;

/** Every mock slot is at this hour, UTC. There is no per-clinic timezone to model. */
const SLOT_HOUR_UTC = 9;

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

/** One offered slot. `slotId` is what the model hands back to `book_appointment`. */
export interface Slot {
  /**
   * Stable and self-describing: `slot-YYYY-MM-DDTHH:MMZ`. The id ENCODES the
   * instant, so booking needs no server-side session state — the same `now`
   * regenerates the same id.
   */
  slotId: string;
  scheduledFor: Date;
  /** Voice form, e.g. "Monday, August 3 at 9 AM". */
  spokenTime: string;
}

/** UTC components only — a local-time read would shift the slot by a day. */
function formatSlotId(scheduledFor: Date): string {
  const year = String(scheduledFor.getUTCFullYear()).padStart(4, '0');
  const month = String(scheduledFor.getUTCMonth() + 1).padStart(2, '0');
  const day = String(scheduledFor.getUTCDate()).padStart(2, '0');
  const hour = String(scheduledFor.getUTCHours()).padStart(2, '0');
  const minute = String(scheduledFor.getUTCMinutes()).padStart(2, '0');
  return `slot-${year}-${month}-${day}T${hour}:${minute}Z`;
}

/**
 * Exported because `cancel_appointment` has to say WHICH time it released, and
 * it only has the stored row — not a `Slot` from the offered catalogue.
 */
export function formatSpokenTime(scheduledFor: Date): string {
  // `?? ''` satisfies noUncheckedIndexedAccess; getUTCDay/getUTCMonth are
  // always in range, so the fallback is unreachable.
  const weekday = WEEKDAYS[scheduledFor.getUTCDay()] ?? '';
  const month = MONTHS[scheduledFor.getUTCMonth()] ?? '';
  const hour24 = scheduledFor.getUTCHours();
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const meridiem = hour24 < 12 ? 'AM' : 'PM';
  return `${weekday}, ${month} ${String(scheduledFor.getUTCDate())} at ${String(hour12)} ${meridiem}`;
}

/**
 * The next three weekday slots strictly after `now`.
 *
 * The walk starts at tomorrow, never today: a caller phoning at 08:00 must not
 * be offered a 09:00 slot the same morning, and "strictly after now" is the
 * only rule that holds however late in the day the call lands.
 *
 * Saturday and Sunday are skipped — a registration desk that books a Sunday is
 * obviously wrong, and this is the one domain rule the mock can get right.
 */
export function getAvailableSlots(now: Date): Slot[] {
  const slots: Slot[] = [];

  const cursor = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SLOT_HOUR_UTC),
  );

  while (slots.length < SLOT_COUNT) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);

    const weekday = cursor.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;

    const scheduledFor = new Date(cursor.getTime());
    slots.push({
      slotId: formatSlotId(scheduledFor),
      scheduledFor,
      spokenTime: formatSpokenTime(scheduledFor),
    });
  }

  return slots;
}

/**
 * Resolve a slot id the model sent back, by MEMBERSHIP of the currently offered
 * set — not by parsing the id into a date.
 *
 * Membership is the tighter check: it rejects a well-formed id for a Sunday, for
 * last month, or for 3 AM, all of which a parse would happily accept. It also
 * means no code path anywhere hands a string to `new Date()`.
 *
 * Known accepted edge: the offered set rolls over at UTC midnight, so a call
 * that spans midnight can be offered a slot and then have it rejected a moment
 * later. The caller is re-offered the current three and books again — the
 * failure is a field failure, which the model already knows how to re-prompt.
 */
export function findSlotById(slotId: string, now: Date): Slot | null {
  return getAvailableSlots(now).find((slot) => slot.slotId === slotId) ?? null;
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
 * Book one mock slot. `status` defaults to SCHEDULED in the schema.
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
    data: { scheduledFor: input.scheduledFor },
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
 * `now` is injected for the same reason `getAvailableSlots` takes it: a test pins
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
