// The three Vapi tool handlers.
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
import { zodIssuesToDetails } from '../lib/envelope.js';
import { NotFoundError } from '../lib/errors.js';
import { formatDob } from '../lib/serialize.js';
import { normalizePhone } from '../normalize/index.js';
import * as patientService from '../services/patient.js';
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

    return {
      result: oneLine(
        `Found ${String(patients.length)} patient${patients.length === 1 ? '' : 's'}: ${listed}.${overflow}`,
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
// Dispatch
// ---------------------------------------------------------------------------

type ToolHandler = (args: ToolCallArgs, context: ToolContext) => Promise<ToolOutcome>;

const HANDLERS: Record<string, ToolHandler | undefined> = {
  create_patient: createPatient,
  lookup_patient_by_phone: lookupPatientByPhone,
  update_patient: updatePatient,
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
