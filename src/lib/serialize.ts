// The SOLE owner of the DB <-> wire transform.
//
// If a second place ever formats a patient for output, `date_of_birth` will
// regress to ISO form in one code path and not the other, and the `sex` display
// mapping will drift. Nothing outside this module may build the response shape,
// map the sex enum, or format/parse a date of birth.
//
// Both directions live here on purpose: `parseSex`/`parseDobStrict` are the
// input half, `sexToDisplay`/`formatDob`/`toPatientResponse` the output half.
// Keeping the pair adjacent is what stops them diverging.
//
// TWO DOB PARSERS EXIST, ON PURPOSE, WITH DIFFERENT NAMES.
//   `parseDobStrict` (here)                — the REST boundary. MM/DD/YYYY or
//     YYYY-MM-DD, nothing else. A typed API client gets a 422 for "2/15/1992".
//   `parseSpokenDob` (src/normalize/date.ts) — the VOICE ingress. Spoken forms,
//     month names, 2-digit years, single-digit months.
// They were both called `parseDobInput` until the phase-3 wiring made that a
// live hazard: importing the wrong one of two identically-named exports either
// loosens the public API contract or makes the agent reject a spoken date, and
// neither failure is visible at the call site. Do not re-merge them, and do not
// give either the other's name.
//
// `formatDob` is the shared half and has exactly ONE implementation — this one.
// `src/normalize/date.ts` re-exports it rather than keeping a copy.

import type { Appointment, CallTranscript, Patient } from '@prisma/client';

// ---------------------------------------------------------------------------
// sex enum
// ---------------------------------------------------------------------------

/**
 * Storage form. Mirrors the Prisma/Postgres `sex` enum. Declared locally rather
 * than imported so the validation layer can depend on this module without
 * pulling in @prisma/client at runtime.
 */
export const SEX_VALUES = ['MALE', 'FEMALE', 'OTHER', 'DECLINE_TO_ANSWER'] as const;

export type SexValue = (typeof SEX_VALUES)[number];

const SEX_DISPLAY: Record<SexValue, string> = {
  MALE: 'Male',
  FEMALE: 'Female',
  OTHER: 'Other',
  DECLINE_TO_ANSWER: 'Decline to Answer',
};

const SEX_STORAGE = new Set<string>(SEX_VALUES);

/**
 * Accept any case, and both the display form and the storage form:
 * trim -> uppercase -> collapse whitespace runs to `_`. That single transform
 * accepts "Decline to Answer", "decline to answer", "DECLINE_TO_ANSWER" and
 * "decline_to_answer" alike (handoff § 5).
 *
 * Also accepts a small set of spoken aliases the voice agent may pass through
 * ("ma'am" → FEMALE, "sir" → MALE) so a listening slip does not 422 a save.
 *
 * Returns null when the input is not one of the four values (or a known alias).
 */
const SEX_SPOKEN_ALIASES: Record<string, SexValue> = {
  MALE: 'MALE',
  FEMALE: 'FEMALE',
  OTHER: 'OTHER',
  DECLINE_TO_ANSWER: 'DECLINE_TO_ANSWER',
  // Spoken / colloquial — voice path only; REST clients still use the four labels.
  SIR: 'MALE',
  MAN: 'MALE',
  GUY: 'MALE',
  GENTLEMAN: 'MALE',
  BOY: 'MALE',
  "MA'AM": 'FEMALE',
  MAAM: 'FEMALE',
  MADAM: 'FEMALE',
  WOMAN: 'FEMALE',
  LADY: 'FEMALE',
  GIRL: 'FEMALE',
  NONBINARY: 'OTHER',
  'NON-BINARY': 'OTHER',
  PREFER_NOT_TO_SAY: 'DECLINE_TO_ANSWER',
  RATHER_NOT_SAY: 'DECLINE_TO_ANSWER',
};

export function parseSex(input: string): SexValue | null {
  const candidate = input.trim().toUpperCase().replace(/\s+/g, '_');
  if (SEX_STORAGE.has(candidate)) return candidate as SexValue;
  // Strip apostrophes for ma'am → MAAM matching after the underscore collapse.
  const aliasKey = candidate.replace(/'/g, '');
  return SEX_SPOKEN_ALIASES[candidate] ?? SEX_SPOKEN_ALIASES[aliasKey] ?? null;
}

/** Storage form -> the display form the API always returns. */
export function sexToDisplay(sex: SexValue | string): string {
  return SEX_DISPLAY[sex as SexValue] ?? sex;
}

// ---------------------------------------------------------------------------
// date of birth — UTC ONLY
// ---------------------------------------------------------------------------
//
// `new Date("02/15/1992")` is LOCAL midnight. On a machine at UTC+2 that is
// 1992-02-14T22:00:00Z, Postgres truncates it to a DATE, and the patient's
// birthday is stored one day early. Railway runs UTC so production hides the
// bug; a developer laptop or CI runner in any other zone exposes it.
//
// Therefore: split into components FIRST, build with Date.UTC(), read back with
// getUTC*(). Never hand a date string to `new Date()` or `Date.parse()`.

const MDY_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Regex groups are `string | undefined` under noUncheckedIndexedAccess. */
function toInt(group: string | undefined): number {
  return group === undefined ? Number.NaN : Number(group);
}

/**
 * Parse `MM/DD/YYYY` or `YYYY-MM-DD` into a UTC-midnight Date.
 *
 * Both formats are accepted because `/` has to be percent-encoded in a query
 * string and a reviewer will reach for the ISO form first (handoff § 8 D6).
 *
 * Returns null for an unparseable string or an impossible calendar date
 * (02/30/1992). Range rules — "not in the future", the 1900 floor — are the
 * validation layer's job, not this function's.
 *
 * STRICT by contract: "2/15/1992", "March 5th 1985" and every spoken form are
 * null here. Loosening this changes the public API contract. Voice input goes
 * through `parseSpokenDob` in `src/normalize/date.ts` instead.
 */
export function parseDobStrict(raw: string): Date | null {
  const value = raw.trim();

  let year: number;
  let month: number;
  let day: number;

  const mdy = MDY_PATTERN.exec(value);
  const iso = ISO_PATTERN.exec(value);

  if (mdy) {
    month = toInt(mdy[1]);
    day = toInt(mdy[2]);
    year = toInt(mdy[3]);
  } else if (iso) {
    year = toInt(iso[1]);
    month = toInt(iso[2]);
    day = toInt(iso[3]);
  } else {
    return null;
  }

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day));

  // Round-trip check rejects 02/30, 04/31, 02/29 in a non-leap year — JS would
  // otherwise silently roll them forward into the next month.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

/** UTC midnight today. Used for the "not in the future" comparison. */
export function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * The challenge's wire format: `MM/DD/YYYY`, read from UTC components.
 *
 * The SOLE implementation — `src/normalize/date.ts` re-exports this one rather
 * than keeping its own copy. The year is padded to four digits for the same
 * reason the month and day are: a fixed-width output is the whole point.
 */
export function formatDob(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  return `${month}/${day}/${year}`;
}

// ---------------------------------------------------------------------------
// patient -> wire
// ---------------------------------------------------------------------------

/**
 * The canonical patient response object (handoff § 3.0). The key set is FIXED:
 * absent optional fields are emitted as `null`, never omitted, so clients can
 * rely on the shape.
 */
export interface PatientResponse {
  patient_id: string;
  first_name: string;
  last_name: string;
  /** MM/DD/YYYY */
  date_of_birth: string;
  /** "Male" | "Female" | "Other" | "Decline to Answer" */
  sex: string;
  /** 10 bare digits — consumers format for display. */
  phone_number: string;
  email: string | null;
  address_line_1: string;
  address_line_2: string | null;
  city: string;
  state: string;
  zip_code: string;
  insurance_provider: string | null;
  insurance_member_id: string | null;
  preferred_language: string;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  /** ISO 8601 UTC with milliseconds. */
  created_at: string;
  updated_at: string;
  /** null for live rows; populated in the DELETE response. */
  deleted_at: string | null;
}

export function toPatientResponse(patient: Patient): PatientResponse {
  return {
    patient_id: patient.patientId,
    first_name: patient.firstName,
    last_name: patient.lastName,
    date_of_birth: formatDob(patient.dateOfBirth),
    sex: sexToDisplay(patient.sex),
    phone_number: patient.phoneNumber,
    email: patient.email,
    address_line_1: patient.addressLine1,
    address_line_2: patient.addressLine2,
    city: patient.city,
    state: patient.state,
    zip_code: patient.zipCode,
    insurance_provider: patient.insuranceProvider,
    insurance_member_id: patient.insuranceMemberId,
    preferred_language: patient.preferredLanguage,
    emergency_contact_name: patient.emergencyContactName,
    emergency_contact_phone: patient.emergencyContactPhone,
    created_at: patient.createdAt.toISOString(),
    updated_at: patient.updatedAt.toISOString(),
    deleted_at: patient.deletedAt === null ? null : patient.deletedAt.toISOString(),
  };
}

export function toPatientResponseList(patients: readonly Patient[]): PatientResponse[] {
  return patients.map(toPatientResponse);
}

// ---------------------------------------------------------------------------
// call transcript -> wire
// ---------------------------------------------------------------------------

/**
 * The transcript shape returned by `GET /patients/:id/transcripts`. Same rules
 * as the patient response: snake_case keys, a FIXED key set, absent values as
 * `null` rather than omitted, timestamps ISO 8601 UTC.
 *
 * `patient_id` is included even though the caller supplied it — the response
 * object should be self-describing when it is pulled out of the envelope.
 */
export interface CallTranscriptResponse {
  id: string;
  patient_id: string | null;
  vapi_call_id: string;
  transcript: string | null;
  summary: string | null;
  recording_url: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toCallTranscriptResponse(row: CallTranscript): CallTranscriptResponse {
  return {
    id: row.id,
    patient_id: row.patientId,
    vapi_call_id: row.vapiCallId,
    transcript: row.transcript,
    summary: row.summary,
    recording_url: row.recordingUrl,
    started_at: row.startedAt === null ? null : row.startedAt.toISOString(),
    ended_at: row.endedAt === null ? null : row.endedAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function toCallTranscriptResponseList(
  rows: readonly CallTranscript[],
): CallTranscriptResponse[] {
  return rows.map(toCallTranscriptResponse);
}

// ---------------------------------------------------------------------------
// appointment -> wire
// ---------------------------------------------------------------------------

/**
 * The shape returned by `GET /patients/:id/appointments`. Same rules as above:
 * snake_case keys, a FIXED key set, timestamps ISO 8601 UTC.
 *
 * `status` is emitted in its STORAGE form ("SCHEDULED"). Unlike `sex`, the
 * challenge specifies no display labels for it, and inventing a second display
 * mapping would create a second thing to keep in sync for no caller benefit.
 */
export interface AppointmentResponse {
  id: string;
  patient_id: string;
  scheduled_for: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export function toAppointmentResponse(row: Appointment): AppointmentResponse {
  return {
    id: row.id,
    patient_id: row.patientId,
    scheduled_for: row.scheduledFor.toISOString(),
    status: row.status,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function toAppointmentResponseList(rows: readonly Appointment[]): AppointmentResponse[] {
  return rows.map(toAppointmentResponse);
}
