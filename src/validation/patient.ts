// Zod schemas for the patient resource.
//
// Challenge § 4: "Validate all inputs server-side (do not rely solely on the
// voice agent for validation)." Every rule in the challenge's data-model table
// is implemented here, and `.strict()` on the body schemas is the "basic input
// sanitization" the challenge asks for — it is what rejects `patient_id`,
// `created_at`, `updated_at` and `deleted_at` on input rather than silently
// ignoring them.
//
// Schemas are declared with snake_case WIRE keys; the `to*Input` helpers below
// translate to the camelCase shape the service layer (and Prisma) expect. That
// translation happens here and nowhere else.
//
// SCOPE NOTE — voice normalization is deliberately absent.
// Spoken-digit words ("five five five"), "oh" for zero, "at"/"dot" email
// repair, letter-by-letter spelling and full-state-name expansion all belong at
// the VOICE ingress in Phase 3 (`src/normalize/`), not at the REST boundary.
// REST clients are expected to send clean data. The single concession here is
// `toTenDigits()` — a trivial digit strip so a human typing a punctuated phone
// number into curl is not punished for it.

import { z } from 'zod';
import { US_STATE_SET } from './us-states.js';
import { parseDobStrict, parseSex, todayUtc, type SexValue } from '../lib/serialize.js';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Canonical phone storage form is 10 bare digits (handoff § 8 D3): no `+1`, no
 * punctuation. Strips every non-digit and drops a leading NANP country code.
 * Returns null when the result is not exactly 10 digits.
 */
function toTenDigits(raw: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits.length === 10 ? digits : null;
}

/**
 * NANP validity: neither the area code nor the exchange code may begin with 0
 * or 1. This is what makes the challenge's "3-digit phone number" edge case —
 * and other junk input — fail loudly instead of being stored.
 */
const NANP_PATTERN = /^[2-9]\d{2}[2-9]\d{6}$/;

const DOB_FLOOR_UTC = Date.UTC(1900, 0, 1);

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------

/**
 * Letters, plus hyphens and apostrophes per the challenge — and internal
 * spaces, a deliberate documented widening (handoff § 8 D9): "Mary Jo",
 * "Van Der Berg" and "De La Cruz" are real names and rejecting a caller's name
 * over a punctuation rule is the worse failure. Digits and other symbols stay
 * rejected, which is what the rule actually protects against.
 *
 * "Letter" is `\p{L}`, not `[A-Za-z]`. The ASCII class 422s José, Müller and
 * Nguyễn — ordinary names in the U.S. patient population this system registers,
 * and a registration desk that cannot spell a patient's name is not a working
 * registration desk.
 *
 * The widening is exactly one Unicode category. Everything the rule protects
 * against is in a DIFFERENT category and stays rejected: digits are \p{Nd},
 * `<script>` is \p{P}/\p{S}, emoji are \p{So}, and the RTL-override character
 * U+202E is \p{Cf}.
 */
const NAME_PATTERN = /^\p{L}[\p{L}\s'-]*$/u;

const nameSchema = z
  .string()
  .trim()
  .min(1, 'Must be 1-50 characters.')
  .max(50, 'Must be 1-50 characters.')
  .regex(NAME_PATTERN, 'Must contain only letters, spaces, hyphens and apostrophes.');

const dateOfBirthSchema = z.string().transform((value, ctx): Date => {
  const parsed = parseDobStrict(value);

  if (parsed === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Must be a valid calendar date in MM/DD/YYYY format.',
    });
    return z.NEVER;
  }

  // Compared in UTC, never local — same reason the parse side is UTC-only.
  if (parsed.getTime() > todayUtc().getTime()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Date of birth cannot be in the future.',
    });
    return z.NEVER;
  }

  if (parsed.getTime() < DOB_FLOOR_UTC) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Date of birth must be on or after 01/01/1900.',
    });
    return z.NEVER;
  }

  return parsed;
});

const sexSchema = z.string().transform((value, ctx): SexValue => {
  const parsed = parseSex(value);

  if (parsed === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Must be one of: Male, Female, Other, Decline to Answer.',
    });
    return z.NEVER;
  }

  return parsed;
});

const phoneSchema = z.string().transform((value, ctx): string => {
  const digits = toTenDigits(value);

  if (digits === null || !NANP_PATTERN.test(digits)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Must be a valid U.S. 10-digit phone number.',
    });
    return z.NEVER;
  }

  return digits;
});

const stateSchema = z.string().trim().transform((value, ctx): string => {
  const upper = value.toUpperCase();

  if (!US_STATE_SET.has(upper)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Must be a valid 2-letter U.S. state abbreviation.',
    });
    return z.NEVER;
  }

  return upper;
});

const zipCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{5}(-\d{4})?$/, 'Must be a 5-digit ZIP or ZIP+4 (12345 or 12345-6789).');

const emailSchema = z
  .string()
  .trim()
  .email('Must be a valid email address.')
  .max(254, 'Must be at most 254 characters.');

// ---------------------------------------------------------------------------
// Body schemas
// ---------------------------------------------------------------------------

/**
 * The accepted key set. Everything else — including the four server-managed
 * fields — is rejected by `.strict()`.
 *
 * The six nullable optionals accept an explicit `null` to CLEAR the field on
 * update. Required fields and `preferred_language` do not (handoff § 8 D4:
 * optional from the caller, never null in storage).
 */
const patientShape = {
  first_name: nameSchema,
  last_name: nameSchema,
  date_of_birth: dateOfBirthSchema,
  sex: sexSchema,
  phone_number: phoneSchema,
  email: emailSchema.nullable().optional(),
  address_line_1: z.string().trim().min(1, 'Must not be empty.').max(200, 'Must be at most 200 characters.'),
  address_line_2: z.string().trim().max(200, 'Must be at most 200 characters.').nullable().optional(),
  city: z.string().trim().min(1, 'Must be 1-100 characters.').max(100, 'Must be 1-100 characters.'),
  state: stateSchema,
  zip_code: zipCodeSchema,
  insurance_provider: z.string().trim().max(100, 'Must be at most 100 characters.').nullable().optional(),
  insurance_member_id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{1,50}$/, 'Must be 1-50 alphanumeric characters.')
    .nullable()
    .optional(),
  preferred_language: z
    .string()
    .trim()
    .min(1, 'Must be 1-50 characters.')
    .max(50, 'Must be 1-50 characters.')
    .default('English'),
  emergency_contact_name: z.string().trim().max(100, 'Must be at most 100 characters.').nullable().optional(),
  emergency_contact_phone: phoneSchema.nullable().optional(),
};

/** POST /patients */
export const createPatientSchema = z.object(patientShape).strict();

/**
 * PUT /patients/:id — partial merge despite the verb. The challenge says
 * "Partial updates allowed"; that wins over REST purity. Absent keys are left
 * untouched, they are not nulled.
 *
 * An empty object is rejected: a no-op write that silently bumps `updated_at`
 * is worse than an explicit 422.
 */
export const updatePatientSchema = z
  .object(patientShape)
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'At least one field must be provided.',
  });

/** GET/PUT/DELETE /patients/:id */
export const patientIdParamSchema = z.object({
  id: z.string().uuid('Patient id must be a valid UUID.'),
});

/**
 * GET /patients query params.
 *
 * `.passthrough()`, NOT `.strict()`: unrecognized query params are ignored.
 * Browsers, proxies and analytics append junk, and a reviewer poking `?foo=1`
 * should not get an error.
 */
export const listPatientsQuerySchema = z
  .object({
    last_name: z.string().trim().min(1, 'Must not be empty.').optional(),
    date_of_birth: z
      .string()
      .transform((value, ctx): Date => {
        const parsed = parseDobStrict(value);
        if (parsed === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Must be a valid date in MM/DD/YYYY or YYYY-MM-DD format.',
          });
          return z.NEVER;
        }
        return parsed;
      })
      .optional(),
    // No NANP check on the filter — a lookup for an unusual number should
    // return an empty list, not an error. Only "does not normalize to 10
    // digits" is a malformed query (400).
    phone_number: z
      .string()
      .transform((value, ctx): string => {
        const digits = toTenDigits(value);
        if (digits === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Must normalize to a U.S. 10-digit phone number.',
          });
          return z.NEVER;
        }
        return digits;
      })
      .optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Wire (snake_case) -> service (camelCase)
// ---------------------------------------------------------------------------

export type CreatePatientWire = z.output<typeof createPatientSchema>;
export type UpdatePatientWire = z.output<typeof updatePatientSchema>;
export type ListPatientsQueryWire = z.output<typeof listPatientsQuerySchema>;

/** What `src/services/patient.ts` accepts for a create. */
export interface CreatePatientInput {
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
  sex: SexValue;
  phoneNumber: string;
  email?: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  zipCode: string;
  insuranceProvider?: string | null;
  insuranceMemberId?: string | null;
  preferredLanguage: string;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
}

/** Partial merge: only the keys actually present are written. */
export type UpdatePatientInput = Partial<CreatePatientInput>;

export interface ListPatientsFilter {
  lastName?: string;
  dateOfBirth?: Date;
  phoneNumber?: string;
}

export function toCreateInput(wire: CreatePatientWire): CreatePatientInput {
  return {
    firstName: wire.first_name,
    lastName: wire.last_name,
    dateOfBirth: wire.date_of_birth,
    sex: wire.sex,
    phoneNumber: wire.phone_number,
    email: wire.email ?? null,
    addressLine1: wire.address_line_1,
    addressLine2: wire.address_line_2 ?? null,
    city: wire.city,
    state: wire.state,
    zipCode: wire.zip_code,
    insuranceProvider: wire.insurance_provider ?? null,
    insuranceMemberId: wire.insurance_member_id ?? null,
    preferredLanguage: wire.preferred_language,
    emergencyContactName: wire.emergency_contact_name ?? null,
    emergencyContactPhone: wire.emergency_contact_phone ?? null,
  };
}

export function toUpdateInput(wire: UpdatePatientWire): UpdatePatientInput {
  const input: UpdatePatientInput = {};

  // `!== undefined` rather than truthiness: an explicit `null` must survive,
  // because that is how a caller clears a nullable optional field.
  if (wire.first_name !== undefined) input.firstName = wire.first_name;
  if (wire.last_name !== undefined) input.lastName = wire.last_name;
  if (wire.date_of_birth !== undefined) input.dateOfBirth = wire.date_of_birth;
  if (wire.sex !== undefined) input.sex = wire.sex;
  if (wire.phone_number !== undefined) input.phoneNumber = wire.phone_number;
  if (wire.email !== undefined) input.email = wire.email;
  if (wire.address_line_1 !== undefined) input.addressLine1 = wire.address_line_1;
  if (wire.address_line_2 !== undefined) input.addressLine2 = wire.address_line_2;
  if (wire.city !== undefined) input.city = wire.city;
  if (wire.state !== undefined) input.state = wire.state;
  if (wire.zip_code !== undefined) input.zipCode = wire.zip_code;
  if (wire.insurance_provider !== undefined) input.insuranceProvider = wire.insurance_provider;
  if (wire.insurance_member_id !== undefined) input.insuranceMemberId = wire.insurance_member_id;
  if (wire.preferred_language !== undefined) input.preferredLanguage = wire.preferred_language;
  if (wire.emergency_contact_name !== undefined) {
    input.emergencyContactName = wire.emergency_contact_name;
  }
  if (wire.emergency_contact_phone !== undefined) {
    input.emergencyContactPhone = wire.emergency_contact_phone;
  }

  return input;
}

export function toListFilter(wire: ListPatientsQueryWire): ListPatientsFilter {
  const filter: ListPatientsFilter = {};

  if (typeof wire.last_name === 'string') filter.lastName = wire.last_name;
  if (wire.date_of_birth instanceof Date) filter.dateOfBirth = wire.date_of_birth;
  if (typeof wire.phone_number === 'string') filter.phoneNumber = wire.phone_number;

  return filter;
}
