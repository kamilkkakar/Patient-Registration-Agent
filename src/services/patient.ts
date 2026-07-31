// Business logic for the patient resource.
//
// This is the ONLY module that touches Prisma (alongside the client singleton
// itself). Routes never assemble a `where` clause — the soft-delete filter has
// exactly one home so there is exactly one place to get it right and one place
// to review.
//
// Errors thrown here are typed (`NotFoundError`); this layer never knows about
// HTTP status codes.

import type { Patient } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { NotFoundError } from '../lib/errors.js';
import type {
  CreatePatientInput,
  ListPatientsFilter,
  UpdatePatientInput,
} from '../validation/patient.js';

/**
 * The soft-delete predicate. Applied unconditionally on every read path:
 * a soft-deleted record must be indistinguishable from a nonexistent one over
 * HTTP, so nothing above this layer can opt out of it.
 */
const LIVE_ONLY = { deletedAt: null } as const;

/**
 * List live patients, newest registration first — that is what a reviewer who
 * has just completed a test call wants at the top.
 *
 * Filters combine with AND. Zero matches is a successful empty list, never a
 * 404.
 */
export async function listPatients(filter: ListPatientsFilter): Promise<Patient[]> {
  return prisma.patient.findMany({
    where: {
      ...LIVE_ONLY,
      // Case-insensitive EXACT match: `?last_name=doe` finds "Doe".
      ...(filter.lastName !== undefined
        ? { lastName: { equals: filter.lastName, mode: 'insensitive' as const } }
        : {}),
      ...(filter.dateOfBirth !== undefined ? { dateOfBirth: filter.dateOfBirth } : {}),
      ...(filter.phoneNumber !== undefined ? { phoneNumber: filter.phoneNumber } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Fetch one live patient. Throws NotFoundError for both "no such row" and
 * "row is soft-deleted" — deliberately the same outcome.
 */
export async function getPatientById(patientId: string): Promise<Patient> {
  const patient = await prisma.patient.findFirst({
    where: { patientId, ...LIVE_ONLY },
  });

  if (patient === null) {
    throw new NotFoundError('No patient found with that id.');
  }

  return patient;
}

/**
 * Result of create: `created: false` means an identical live row already
 * existed and was returned instead of inserting a second copy.
 */
export type CreatePatientResult = {
  patient: Patient;
  created: boolean;
};

/**
 * Demographic columns that define "the same patient row" for deduplication.
 * Identity/lifecycle/provenance (`patientId`, timestamps, `deletedAt`,
 * `vapiCallId`) are intentionally excluded — two registrations that agree on
 * every demographic field are the same record even if they arrived on different
 * calls.
 */
function exactDuplicateWhere(input: CreatePatientInput) {
  return {
    ...LIVE_ONLY,
    firstName: input.firstName,
    lastName: input.lastName,
    dateOfBirth: input.dateOfBirth,
    sex: input.sex,
    phoneNumber: input.phoneNumber,
    email: input.email ?? null,
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2 ?? null,
    city: input.city,
    state: input.state,
    zipCode: input.zipCode,
    insuranceProvider: input.insuranceProvider ?? null,
    insuranceMemberId: input.insuranceMemberId ?? null,
    preferredLanguage: input.preferredLanguage,
    emergencyContactName: input.emergencyContactName ?? null,
    emergencyContactPhone: input.emergencyContactPhone ?? null,
  };
}

/**
 * Find a live patient whose entire demographic row matches `input`.
 * Phone-only or name-only agreement is NOT enough — households share numbers,
 * and names collide. Oldest match wins so repeated creates stay stable.
 */
export async function findExactDuplicate(
  input: CreatePatientInput,
): Promise<Patient | null> {
  return prisma.patient.findFirst({
    where: exactDuplicateWhere(input),
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Create, or return the existing row when every demographic field matches.
 *
 * Deduplication is full-row only. Matching phone (or first+last name) alone
 * never blocks a create — that would reject a second household member on a
 * shared line, and the challenge's duplicate bonus is an offer to update, not
 * a uniqueness constraint on phone.
 *
 * `vapiCallId` is a SECOND parameter rather than a field on
 * `CreatePatientInput`: that interface is the wire -> service translation of the
 * REST body, `vapi_call_id` is not a wire field, and `UpdatePatientInput` is
 * `Partial<CreatePatientInput>` — putting it there would make the call id
 * writable on the update path too. Absent (every REST create) stores NULL.
 * On a dedupe hit the existing `vapiCallId` is left untouched.
 */
export async function createPatient(
  input: CreatePatientInput,
  vapiCallId?: string | null,
): Promise<CreatePatientResult> {
  const existing = await findExactDuplicate(input);
  if (existing !== null) {
    return { patient: existing, created: false };
  }

  const patient = await prisma.patient.create({
    data: { ...input, vapiCallId: vapiCallId ?? null },
  });
  return { patient, created: true };
}

/**
 * Resolve the patient a Vapi call registered, for linking its transcript.
 *
 * `LIVE_ONLY` is deliberately NOT applied here, the one exception in this file.
 * Linkage is a historical fact about a call, not a read of patient data: a
 * transcript that arrives after the patient was soft-deleted would otherwise
 * stay orphaned forever, and soft delete never fires the FK's `SetNull`. Nothing
 * leaks either way — `GET /patients/:id/transcripts` 404s on a deleted patient.
 *
 * `findFirst`, not `findUnique`: `vapi_call_id` is indexed but not unique,
 * because one call can legitimately register two family members. Oldest first,
 * so a re-delivered report always resolves to the same row.
 */
export async function findPatientIdByVapiCallId(vapiCallId: string): Promise<string | null> {
  const patient = await prisma.patient.findFirst({
    where: { vapiCallId },
    orderBy: { createdAt: 'asc' },
    select: { patientId: true },
  });

  return patient?.patientId ?? null;
}

/**
 * Partial update.
 *
 * ONE statement, not a read followed by a write.
 *
 * `update({ where: { patientId } })` cannot express the soft-delete filter —
 * `where` on `update` only takes unique fields — so the obvious shape is
 * `getPatientById()` then `update()`. That pair is a TOCTOU race: a DELETE
 * landing in the gap tombstones the row, and the update still writes to it.
 * `.strict()` stops `deletedAt` being cleared on input so the row is never
 * actually resurrected, but the write lands on a deleted record and the caller
 * gets a 200 whose payload carries a non-null `deleted_at`.
 *
 * `updateMany` takes an arbitrary `where`, so the soft-delete predicate travels
 * WITH the write in a single atomic UPDATE. A concurrent deleter holds the row
 * lock; when we get it, Postgres re-evaluates the predicate against the
 * committed row, sees `deleted_at IS NOT NULL`, and matches nothing.
 * `count === 0` is therefore "no live row" — the same 404 as "no such row".
 *
 * `$transaction` would NOT fix this on its own: at READ COMMITTED the same
 * read-then-write window exists inside a transaction.
 *
 * `updateManyAndReturn` (Postgres `UPDATE ... RETURNING`) gives us the row back
 * from that same statement, so there is no second read to race either.
 * `updatedAt` is bumped automatically by Prisma's @updatedAt.
 */
export async function updatePatient(
  patientId: string,
  input: UpdatePatientInput,
): Promise<Patient> {
  const [updated] = await prisma.patient.updateManyAndReturn({
    where: { patientId, ...LIVE_ONLY },
    data: input,
  });

  if (updated === undefined) {
    throw new NotFoundError('No patient found with that id.');
  }

  return updated;
}

/**
 * Soft delete: set `deleted_at`, never `prisma.patient.delete()`.
 *
 * `updated_at` is bumped too — a soft delete IS a modification, and the
 * challenge defines `updated_at` as "Auto-generated on modification". Prisma's
 * @updatedAt does that on this same call; do not fight it.
 *
 * Deleting an already-deleted row is a 404 (handoff § 8 D2): once deleted, the
 * resource is uniformly invisible across all three id-addressed endpoints.
 * Related CallTranscript / Appointment rows are untouched.
 *
 * Single-statement for the same reason as `updatePatient`, and here D2 is what
 * depends on it: with a separate read, N simultaneous deletes all read a live
 * row, all return 200, and the last one to commit overwrites `deleted_at`. With
 * the predicate in the UPDATE, exactly one caller matches a row and the rest
 * get their 404.
 */
export async function softDeletePatient(patientId: string): Promise<Patient> {
  const [deleted] = await prisma.patient.updateManyAndReturn({
    where: { patientId, ...LIVE_ONLY },
    data: { deletedAt: new Date() },
  });

  if (deleted === undefined) {
    throw new NotFoundError('No patient found with that id.');
  }

  return deleted;
}
