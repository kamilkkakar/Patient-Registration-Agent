// Business logic for the CallTranscript resource (bonus: store a transcript and
// summary of each call).
//
// Like `services/patient.ts`, this is a layer that MAY touch Prisma; the Vapi
// webhook handler must not.

import type { CallTranscript } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { findPatientIdByVapiCallId } from './patient.js';

export interface CallTranscriptInput {
  /** Vapi's call id — `message.call.id`. UNIQUE in the schema. */
  vapiCallId: string;
  transcript?: string | null;
  summary?: string | null;
  /** `message.artifact.recordingUrl`. */
  recordingUrl?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
}

/**
 * Idempotent write of one call's record, linked to the patient that call
 * registered when there is one.
 *
 * UPSERT, not create: Vapi retries webhooks (and `end-of-call-report` may be
 * re-sent after post-processing), and `vapi_call_id` is unique — a retry must
 * update the existing row, never raise P2002 or create a duplicate.
 *
 * A re-delivery must never blank out data we already hold. Vapi retries webhooks,
 * and a retry can legitimately carry LESS than the first delivery — the summary
 * arrives after post-processing, the transcript may not be re-sent.
 *
 * Enforcing that is subtler than it looks. Prisma treats `undefined` as "leave
 * unchanged" but an explicit `null` as "SET NULL", and the webhook handler
 * normalizes every missing field to `null` before it gets here. So spreading the
 * input straight into `update` would destroy a stored transcript the moment a
 * thinner re-delivery arrived — silently, with no error and nothing in the logs.
 *
 * `omitEmpty` therefore strips null/undefined on the UPDATE branch only. The
 * create branch keeps them: a first delivery genuinely has nothing yet, and the
 * columns are nullable. This is enforced here rather than in the caller so the
 * guarantee holds for any future caller too.
 *
 * The link is resolved from the DATABASE, by the call id the `create_patient`
 * tool stored on the patient row — never from an in-memory map, which a restart
 * or a second instance would lose. An unresolved link is normal and stays NULL:
 * the caller hung up mid-intake, or the call never registered anyone.
 */
function omitEmpty<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)
  ) as Partial<T>;
}

export async function upsertCallTranscript(input: CallTranscriptInput): Promise<CallTranscript> {
  const { vapiCallId, ...rest } = input;
  const patientId = await findPatientIdByVapiCallId(vapiCallId);

  return prisma.callTranscript.upsert({
    where: { vapiCallId },
    create: { vapiCallId, ...rest, patientId },
    // Null-stripped: only fields the re-delivery actually carried get written,
    // and `patientId` is included only when this resolve found one.
    update: omitEmpty({ ...rest, patientId }),
  });
}

/**
 * Every transcript linked to one patient, newest call first — the same ordering
 * convention as `listPatients`.
 *
 * Whether the patient exists (and is live) is the caller's check, not this
 * one's: a patient with no calls and a patient that does not exist both return
 * an empty array here, and only the route can tell those apart with a 404.
 */
export async function listCallTranscriptsByPatientId(
  patientId: string,
): Promise<CallTranscript[]> {
  return prisma.callTranscript.findMany({
    where: { patientId },
    orderBy: { createdAt: 'desc' },
  });
}
