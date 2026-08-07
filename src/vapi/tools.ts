// The Vapi tool handlers.
//
// Each returns a ToolOutcome — never an HTTP status, never a thrown error that
// could escape to the global handler and become a 500. § G5 of the pinned
// contract is absolute: the tool endpoint answers HTTP 200 for every outcome.
//
// ERROR RETURN CONTRACT (prompts/intake-coordinator.md § 2.7):
//
//   Field validation failure -> `error` ONLY, no inline `message`.
//       Vapi's speech precedence is (1) inline `message` of type
//       `request-failed`, (2) a canned `request-failed` on the tool definition,
//       (3) a model-generated response. Field failures must fall through to (3)
//       so the model can produce the SPECIFIC re-prompt the challenge requires
//       ("that came through as only seven digits — could you give me the full
//       ten?"). An inline message here would pre-empt that on every field error
//       and make the per-field re-prompt requirement unreachable.
//
//   Infrastructure failure -> `error` WITH an inline `request-failed` message.
//       Determinism is what you want when the system is broken. A model
//       improvising around an unknown failure is worse than a fixed sentence,
//       and silence is the failure mode being designed against.
//
// This file calls the service layer only. It never touches Prisma.

import { z } from 'zod';
import { CLINIC_TIMEZONE } from '../config/clinic.js';
import { utcToClinicDate } from '../lib/clinic-time.js';
import { zodIssuesToDetails } from '../lib/envelope.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { formatDob } from '../lib/serialize.js';
import { normalizePhone } from '../normalize/index.js';
import { parseWhen } from '../normalize/when.js';
import * as appointmentService from '../services/appointment.js';
import * as availabilityService from '../services/availability.js';
import * as patientService from '../services/patient.js';
import {
  bookAppointmentSchema,
  cancelAppointmentSchema,
  getAppointmentSlotsSchema,
  rescheduleAppointmentSchema,
} from '../validation/appointment.js';
import {
  createPatientSchema,
  toCreateInput,
  toUpdateInput,
  updatePatientSchema,
} from '../validation/patient.js';
import { normalizeToolArguments } from './normalize-bridge.js';
import type { ToolCallArgs } from './parse-tool-call.js';

// ---------------------------------------------------------------------------
// Outcome shape
// ---------------------------------------------------------------------------

/** Mirrors the writable half of `[SPEC]` ToolCallResult. Both fields are strings. */
export interface ToolOutcome {
  result?: string;
  error?: string;
  /** Only ever set for infrastructure failures — see the header. */
  message?: { type: 'request-failed'; content: string };
}

/**
 * The fixed sentence for a broken backend, lifted from the prompt's own script
 * so what the caller hears matches what the prompt documents.
 */
const INFRA_SPEECH =
  "I'm sorry — I've got all your details but our system isn't saving them right now. Let me try once more.";

/**
 * `result` and `error` must be SINGLE-LINE strings; a line break is a parse
 * error on Vapi's side (§ G4). Everything leaving this module goes through here.
 */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function infraFailure(error: string): ToolOutcome {
  return {
    error: oneLine(error),
    message: { type: 'request-failed', content: INFRA_SPEECH },
  };
}

/** Bare `error`, no inline message. The model writes the re-prompt. */
function fieldFailure(error: string): ToolOutcome {
  return { error: oneLine(error) };
}

/**
 * Turn Zod issues into one model-readable instruction.
 *
 * `zodIssuesToDetails` is reused so `.strict()`'s `unrecognized_keys` issue —
 * whose `path` is empty and whose keys live on `issue.keys` — names the actual
 * offending field instead of reading as a failure on "body".
 */
function issuesToError(issues: readonly z.ZodIssue[]): string {
  const details = zodIssuesToDetails(issues);
  const summary = details.map((d) => `${d.field}: ${d.message}`).join('; ');
  return `${summary} Ask the caller again for only the field or fields named here, then save.`;
}

/**
 * What the handlers know about the call the tool call arrived on, as opposed to
 * the arguments the model produced.
 *
 * `vapiCallId` is OPTIONAL and every handler must work without it: two of the
 * three published `tool-calls` shapes carry no `message.call` at all, and a tool
 * call replayed by hand or by a test has none either. Missing means "store no
 * linkage", never "fail".
 */
export interface ToolContext {
  /** `message.call.id` — the call this tool call was made on. */
  vapiCallId?: string | undefined;
}

/** A patient rendered short. § G14: keep result strings small — the token budget is tight. */
function describePatient(patient: {
  patientId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
}): string {
  return `${patient.firstName} ${patient.lastName}, born ${formatDob(patient.dateOfBirth)}, patient_id ${patient.patientId}`;
}

// ---------------------------------------------------------------------------
// create_patient
// ---------------------------------------------------------------------------

async function createPatient(args: ToolCallArgs, context: ToolContext): Promise<ToolOutcome> {
  const parsed = createPatientSchema.safeParse(normalizeToolArguments(args));

  if (!parsed.success) {
    return fieldFailure(issuesToError(parsed.error.issues));
  }

  try {
    // The call id is stamped on the row here and nowhere else. It is what the
    // end-of-call report later resolves the transcript's `patient_id` from, so
    // the linkage survives a restart in a way an in-memory map would not.
    //
    // Deduplication is FULL-ROW: only when every demographic field matches an
    // existing live patient do we skip the insert. Same phone or same name alone
    // still creates a new row (households share numbers).
    const { patient, created } = await patientService.createPatient(
      toCreateInput(parsed.data),
      context.vapiCallId,
    );
    if (!created) {
      return {
        result: `Already registered. Identical record on file. Patient ID ${patient.patientId}.`,
      };
    }
    return { result: `Registered. Patient ID ${patient.patientId}.` };
  } catch {
    return infraFailure('The registration could not be saved because the record store is unavailable.');
  }
}

// ---------------------------------------------------------------------------
// lookup_patient_by_phone
// ---------------------------------------------------------------------------

/** How many matches are described in full before the rest are just counted. */
const MAX_LOOKUP_MATCHES = 3;

/**
 * Phone lookup for the returning-caller UPDATE offer — not the duplicate gate.
 *
 * A shared household number can return several people; that is NOT a duplicate
 * registration. Deduplication (identical full demographic row) happens only
 * inside `create_patient`.
 *
 * The result MUST carry `patient_id` — it is the only way the model can learn an
 * id, and without it `update_patient` is unreachable on a live call.
 */
async function lookupPatientByPhone(args: ToolCallArgs): Promise<ToolOutcome> {
  const raw = args['phone_number'];

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return fieldFailure('phone_number is required; ask the caller for the phone number on their record.');
  }

  const phoneNumber = normalizePhone(raw);

  if (phoneNumber === null) {
    return fieldFailure(
      'phone_number: could not be read as a U.S. 10-digit number; ask the caller to say it again, digit by digit.',
    );
  }

  try {
    const patients = await patientService.listPatients({ phoneNumber });

    if (patients.length === 0) {
      return { result: 'No patient is registered with that phone number.' };
    }

    // Households share a number, so more than one match is normal, not an error.
    // Capped: every described match is another person's name and DOB flowing
    // into the model context, the transcript, the summary and the logs — and an
    // unbounded result string is also the one place this handler could blow the
    // tool token budget (§ G14). Three is enough to disambiguate by voice.
    const shown = patients.slice(0, MAX_LOOKUP_MATCHES);
    const listed = shown.map(describePatient).join('; ');
    const overflow =
      patients.length > shown.length
        ? ` Plus ${String(patients.length - shown.length)} more — ask the caller for their name to narrow it down.`
        : '';

    // Upcoming bookings ride along on the lookup the agent already makes at the
    // start of every call, so changing an appointment costs no extra round trip
    // — which the caller would hear as a pause before Nora says anything useful.
    //
    // ONLY for an unambiguous single match. On a shared household number there
    // is no way to know whose appointments to read out, and guessing would speak
    // one person's schedule to another.
    const only = patients.length === 1 ? patients[0] : undefined;
    let upcoming = '';

    if (only !== undefined) {
      // Capped like the match list above, and for the same reason: this string is
      // read by a model on a token budget (§ G14), and a patient with a long tail
      // of bookings would push the rest of the result out of usefulness.
      const appointments = (
        await appointmentService.listUpcomingAppointmentsForPatient(only.patientId, new Date())
      ).slice(0, MAX_LOOKUP_MATCHES);

      upcoming =
        appointments.length === 0
          ? ' No upcoming appointments.'
          : ` Upcoming: ${appointments
              .map(
                (appointment) =>
                  `${appointmentService.formatSpokenTime(appointment.scheduledFor)} — appointment_id ${appointment.id}`,
              )
              .join('; ')}.`;
    }

    return {
      result: oneLine(
        `Found ${String(patients.length)} patient${patients.length === 1 ? '' : 's'}: ${listed}.${overflow}${upcoming}`,
      ),
    };
  } catch {
    return infraFailure('The patient lookup failed because the record store is unavailable.');
  }
}

// ---------------------------------------------------------------------------
// update_patient
// ---------------------------------------------------------------------------

const patientIdSchema = z.string().uuid();

async function updatePatient(args: ToolCallArgs): Promise<ToolOutcome> {
  // `patient_id` addresses the row; it is NOT a body field. `updatePatientSchema`
  // is `.strict()`, so leaving it in the object would fail as an unknown key on
  // every single call.
  const { patient_id: rawId, ...fields } = args;

  const id = patientIdSchema.safeParse(rawId);
  if (!id.success) {
    return fieldFailure(
      'patient_id is missing or is not a valid id; look the patient up by phone number first.',
    );
  }

  const parsed = updatePatientSchema.safeParse(normalizeToolArguments(fields));
  if (!parsed.success) {
    return fieldFailure(issuesToError(parsed.error.issues));
  }

  try {
    const patient = await patientService.updatePatient(id.data, toUpdateInput(parsed.data));
    return { result: `Updated. Patient ID ${patient.patientId}.` };
  } catch (error) {
    // A missing row is the caller's problem to resolve conversationally, not an
    // outage — so it gets the bare-error treatment, not the canned apology.
    if (error instanceof NotFoundError) {
      return fieldFailure('No patient exists with that patient_id; look the patient up by phone number again.');
    }
    return infraFailure('The update could not be saved because the record store is unavailable.');
  }
}

// ---------------------------------------------------------------------------
// get_appointment_slots / book_appointment — bonus: mock scheduling
// ---------------------------------------------------------------------------

/** Both appointment handlers fail on `patient_id` identically. */
const PATIENT_ID_INVALID =
  'patient_id is missing or is not a valid id; register the caller or look them up by phone number first.';
const PATIENT_ID_UNKNOWN =
  'No patient exists with that patient_id; look the patient up by phone number again.';
const SLOT_ID_UNKNOWN =
  'slot_id is not one of the times currently on offer; call get_appointment_slots again and read the caller the options it returns.';

/**
 * Pick the re-prompt for an appointment tool's arguments.
 *
 * The two named fields get purpose-written instructions: `issuesToError`'s
 * generic "…then save" tail is wrong here, nothing is being saved, and a caller
 * cannot be asked to repeat a slot id they never said. Anything else is
 * `.strict()` rejecting an argument these tools do not accept — a model error,
 * and `issuesToError` names the offending key exactly.
 */
function appointmentArgsError(issues: readonly z.ZodIssue[]): string {
  const fields = new Set(zodIssuesToDetails(issues).map((detail) => detail.field));

  if (fields.has('slot_id')) return SLOT_ID_UNKNOWN;
  if (fields.has('appointment_id')) return APPOINTMENT_UNKNOWN;
  if (fields.has('patient_id')) return PATIENT_ID_INVALID;
  return issuesToError(issues);
}

async function getAppointmentSlots(args: ToolCallArgs): Promise<ToolOutcome> {
  const parsed = getAppointmentSlotsSchema.safeParse(args);

  if (!parsed.success) {
    return fieldFailure(appointmentArgsError(parsed.error.issues));
  }

  try {
    // Reading the patient first is the whole reason this tool takes an id:
    // offering times to a record that does not exist only defers the failure to
    // book_appointment, after the caller has already chosen one.
    await patientService.getPatientById(parsed.data.patient_id);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return fieldFailure(PATIENT_ID_UNKNOWN);
    }
    return infraFailure('The appointment times could not be read because the record store is unavailable.');
  }

  // § G14: the result carries up to three slots and their ids and nothing
  // else — no patient name, no confirmation preamble.
  const now = new Date();
  let preference: availabilityService.AvailabilityPreference = { kind: 'any' };

  if (parsed.data.when !== undefined) {
    const today = utcToClinicDate(now, CLINIC_TIMEZONE);
    const query = parseWhen(parsed.data.when, today);

    // null means "could not parse at all" — the one case that field-fails.
    // An out-of-hours time (e.g. "seven PM") is NOT this: parseWhen returns a
    // real WhenQuery for it, and findAvailability's outsideClinicHours branch
    // below is what turns that into "the clinic is open 9 to 5" rather than a
    // re-ask.
    if (query === null) {
      return fieldFailure(
        'Could not tell what day or time the caller meant; ask them which day suits, then call this again.',
      );
    }
    preference = query;
  }

  // `findAvailability` reads real bookings, so a throw here reaches the
  // belt-and-braces catch in routes.ts rather than a bespoke one — there is
  // no field-specific recovery to offer for "the availability query itself
  // failed".
  const availability = await availabilityService.findAvailability({ now, preference });

  const describe = (slot: availabilityService.Slot): string =>
    `${slot.spokenTime} — slot_id ${slot.slotId}`;

  // Facts, not sentences: "booked solid" and "we're closed" are the same empty
  // list and completely different things to say.
  if (availability.matched !== null) {
    return { result: oneLine(`Available: ${describe(availability.matched)}.`) };
  }

  const alternatives = availability.alternatives.map(describe).join('; ');
  if (alternatives.length === 0) {
    return { result: oneLine('Nothing is open in the next two weeks.') };
  }

  // One sentence per reason, chosen by `unmetReason` rather than by guessing
  // from `matched === null`. `matched` is only ever set on the `time` branch,
  // so for `any`, `day` and `daypart` a null match means "the caller named no
  // time" — offering times IS the answer there, and it must not borrow the
  // wording for a time that was asked for and lost.
  switch (availability.unmetReason) {
    case 'closed':
      return {
        result: oneLine(`The clinic is open 9 to 5, weekdays. Nearest open: ${alternatives}.`),
      };
    case 'beyond-horizon':
      return {
        result: oneLine(`Bookings only open two weeks ahead. Nearest open: ${alternatives}.`),
      };
    case 'fully-booked':
      return { result: oneLine(`That day is fully booked. Next open: ${alternatives}.`) };
    case 'day-over':
      return { result: oneLine(`That day is already over. Next open: ${alternatives}.`) };
    case 'time-passed':
      return { result: oneLine(`That time has already passed. Nearest open: ${alternatives}.`) };
    case 'time-taken':
      return { result: oneLine(`That exact time is taken. Nearest open: ${alternatives}.`) };
    case null:
      return { result: oneLine(`Available: ${alternatives}.`) };
  }
}

async function bookAppointment(args: ToolCallArgs): Promise<ToolOutcome> {
  const parsed = bookAppointmentSchema.safeParse(args);

  if (!parsed.success) {
    return fieldFailure(appointmentArgsError(parsed.error.issues));
  }

  // ONE clock read, resolved once and passed down. Re-reading the clock later in
  // this handler could straddle a grid boundary and book a slot that was never
  // validated.
  const slot = await availabilityService.resolveOpenSlot(parsed.data.slot_id, new Date());

  if (slot === null) {
    return fieldFailure(SLOT_ID_UNKNOWN);
  }

  try {
    await appointmentService.bookAppointment({
      patientId: parsed.data.patient_id,
      scheduledFor: slot.scheduledFor,
    });
    return { result: `Booked. Appointment on ${slot.spokenTime}.` };
  } catch (error) {
    // Losing the race for a slot is ordinary conversation, not an outage. A
    // FIELD failure lets the model offer another time in its own words.
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002') {
      return fieldFailure(
        'That time was taken while the caller was deciding. Call get_appointment_slots again and offer what it returns.',
      );
    }
    // Unknown or soft-deleted patient — the caller's problem to resolve
    // conversationally, not an outage. Same split as `update_patient`.
    if (error instanceof NotFoundError) {
      return fieldFailure(PATIENT_ID_UNKNOWN);
    }
    return infraFailure('The appointment could not be booked because the record store is unavailable.');
  }
}

/**
 * Deliberately says "not on file for this patient" and never "that belongs to
 * someone else". The service refuses an unknown id and another patient's id
 * identically, and this string must not leak the difference the query hides.
 */
const APPOINTMENT_UNKNOWN =
  'No appointment with that id is on file for this patient; call lookup_patient_by_phone again and read the caller what it returns.';

async function rescheduleAppointment(args: ToolCallArgs): Promise<ToolOutcome> {
  const parsed = rescheduleAppointmentSchema.safeParse(args);

  if (!parsed.success) {
    return fieldFailure(appointmentArgsError(parsed.error.issues));
  }

  // ONE clock read for the whole handler, same as book_appointment: re-reading
  // it could straddle a grid boundary and move the booking to a slot that was
  // never validated.
  const now = new Date();
  const slot = await availabilityService.resolveOpenSlot(parsed.data.slot_id, now);

  if (slot === null) {
    return fieldFailure(SLOT_ID_UNKNOWN);
  }

  try {
    await appointmentService.rescheduleAppointment({
      appointmentId: parsed.data.appointment_id,
      patientId: parsed.data.patient_id,
      scheduledFor: slot.scheduledFor,
      now,
    });

    // "THIS appointment is now on ..." rather than "New appointment on ...".
    // The old wording implied a second booking had been created, which is
    // exactly the reading that led a live call to offer to cancel the
    // "original" and destroy the caller's only appointment. Same row, moved.
    return { result: oneLine(`Rescheduled. This appointment is now on ${slot.spokenTime}.`) };
  } catch (error) {
    // Losing the race for a slot is ordinary conversation, not an outage. A
    // FIELD failure lets the model offer another time in its own words.
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002') {
      return fieldFailure(
        'That time was taken while the caller was deciding. Call get_appointment_slots again and offer what it returns.',
      );
    }
    // Unknown patient, unknown appointment, someone else's appointment: all the
    // caller's problem to resolve conversationally, none an outage.
    if (error instanceof NotFoundError) return fieldFailure(APPOINTMENT_UNKNOWN);
    if (error instanceof ValidationError) return fieldFailure(oneLine(error.message));
    return infraFailure('The appointment could not be changed because the record store is unavailable.');
  }
}

async function cancelAppointment(args: ToolCallArgs): Promise<ToolOutcome> {
  const parsed = cancelAppointmentSchema.safeParse(args);

  if (!parsed.success) {
    return fieldFailure(appointmentArgsError(parsed.error.issues));
  }

  try {
    const cancelled = await appointmentService.cancelAppointment({
      appointmentId: parsed.data.appointment_id,
      patientId: parsed.data.patient_id,
      now: new Date(),
    });

    // Say which time was released. "Cancelled." alone leaves a caller who has
    // two bookings unsure which one just went.
    return {
      result: oneLine(
        `Cancelled the appointment on ${appointmentService.formatSpokenTime(cancelled.scheduledFor)}.`,
      ),
    };
  } catch (error) {
    if (error instanceof NotFoundError) return fieldFailure(APPOINTMENT_UNKNOWN);
    if (error instanceof ValidationError) return fieldFailure(oneLine(error.message));
    return infraFailure('The appointment could not be cancelled because the record store is unavailable.');
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

type ToolHandler = (args: ToolCallArgs, context: ToolContext) => Promise<ToolOutcome>;

const HANDLERS: Record<string, ToolHandler | undefined> = {
  create_patient: createPatient,
  lookup_patient_by_phone: lookupPatientByPhone,
  update_patient: updatePatient,
  get_appointment_slots: getAppointmentSlots,
  book_appointment: bookAppointment,
  reschedule_appointment: rescheduleAppointment,
  cancel_appointment: cancelAppointment,
};

export const TOOL_NAMES: readonly string[] = Object.keys(HANDLERS);

/**
 * Route one parsed tool call to its handler.
 *
 * An unknown name is a configuration error (a tool exists in the Vapi dashboard
 * that this deployment does not implement), not a caller error — but it still
 * returns 200 with an `error`, because anything else is invisible to Vapi.
 */
export async function dispatchTool(
  name: string,
  args: ToolCallArgs,
  context: ToolContext = {},
): Promise<ToolOutcome> {
  const handler = HANDLERS[name];

  if (handler === undefined) {
    return infraFailure(`Unknown tool "${name}". This deployment implements: ${TOOL_NAMES.join(', ')}.`);
  }

  return handler(args, context);
}
