// The five patient endpoints.
//
// HTTP only: parse params/body with Zod, call a service, wrap the result in the
// envelope, choose a status code. This file must never import Prisma and never
// assemble a `where` clause.
//
// 400 vs 422 is decided HERE, at the call site, not in the global handler:
//   - a malformed path param or query param -> BadRequestError (400)
//   - a well-formed body that breaks a field rule -> ValidationError (422)
// Routing both through a single "ZodError -> 422" branch would collapse
// "malformed UUID" (400) and "unknown UUID" (404) into one behaviour.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodIssue } from 'zod';
import { ok, zodIssuesToDetails } from '../lib/envelope.js';
import { BadRequestError, ValidationError } from '../lib/errors.js';
import {
  toCallTranscriptResponseList,
  toPatientResponse,
  toPatientResponseList,
  type PatientResponse,
} from '../lib/serialize.js';
import * as callTranscriptService from '../services/call-transcript.js';
import * as patientService from '../services/patient.js';
import {
  createPatientSchema,
  listPatientsQuerySchema,
  patientIdParamSchema,
  toCreateInput,
  toListFilter,
  toUpdateInput,
  updatePatientSchema,
} from '../validation/patient.js';

const BODY_INVALID_MESSAGE = 'Request body failed validation.';

/** Query-param failures are 400s, which carry no `details[]` — fold into the message. */
function queryMessage(issues: readonly ZodIssue[]): string {
  const first = issues[0];
  if (first === undefined) return 'One or more query parameters are invalid.';
  const field = first.path.length > 0 ? first.path.join('.') : 'query';
  return `Invalid query parameter '${field}': ${first.message}`;
}

/**
 * A body that is not a JSON object is MALFORMED (400), not invalid (422).
 *
 * This is not hypothetical: Fastify 5 ships a default `text/plain` parser, so a
 * `Content-Type: text/plain` POST is NOT rejected by the content-type guard the
 * way the handoff's § 7.3 table assumes — the raw string arrives here instead.
 * Without this guard it would fall through to Zod and surface as a 422.
 * Arrays and bare scalars are caught for the same reason.
 */
function requireJsonObject(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestError('Request body must be a JSON object.');
  }
  return body;
}

/** Every id-addressed route starts here. Malformed UUID -> 400, never 404. */
function parsePatientId(request: FastifyRequest): string {
  const parsed = patientIdParamSchema.safeParse(request.params);
  if (!parsed.success) {
    throw new BadRequestError('Patient id must be a valid UUID.');
  }
  return parsed.data.id;
}

export async function patientRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /patients
  // -------------------------------------------------------------------------
  app.get('/patients', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = listPatientsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw new BadRequestError(queryMessage(parsed.error.issues));
    }

    const patients = await patientService.listPatients(toListFilter(parsed.data));

    // Zero matches is a successful empty collection, not a 404.
    reply.code(200).send(ok(toPatientResponseList(patients)));
  });

  // -------------------------------------------------------------------------
  // GET /patients/:id
  // -------------------------------------------------------------------------
  app.get('/patients/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const patientId = parsePatientId(request);
    const patient = await patientService.getPatientById(patientId);

    reply.code(200).send(ok(toPatientResponse(patient)));
  });

  // -------------------------------------------------------------------------
  // GET /patients/:id/transcripts — read-only view of the calls that touched
  // this patient (bonus: call transcript/summary storage).
  //
  // The existence check runs FIRST and is what produces both 404s: an unknown
  // id and a soft-deleted one are indistinguishable here, exactly as they are
  // on GET /patients/:id. Without it, a deleted patient's transcripts would
  // still be readable — and an unknown id would answer 200 with `[]`.
  // -------------------------------------------------------------------------
  app.get('/patients/:id/transcripts', async (request: FastifyRequest, reply: FastifyReply) => {
    const patientId = parsePatientId(request);
    await patientService.getPatientById(patientId);

    const transcripts = await callTranscriptService.listCallTranscriptsByPatientId(patientId);

    // Zero transcripts is a successful empty collection — a patient registered
    // over REST has never had a call.
    reply.code(200).send(ok(toCallTranscriptResponseList(transcripts)));
  });

  // -------------------------------------------------------------------------
  // POST /patients
  // -------------------------------------------------------------------------
  app.post('/patients', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createPatientSchema.safeParse(requireJsonObject(request.body));
    if (!parsed.success) {
      // Every failure, not just the first — the caller should be able to fix
      // the whole body in one round trip.
      throw new ValidationError(BODY_INVALID_MESSAGE, zodIssuesToDetails(parsed.error.issues));
    }

    const { patient, created } = await patientService.createPatient(
      toCreateInput(parsed.data),
    );
    const body = toPatientResponse(patient);

    logPatientPayload(request, created ? 'create' : 'create_deduped', body);

    // 201 = new row. 200 = identical full demographic row already existed —
    // not a phone-only or name-only collision.
    reply
      .header('Location', `/patients/${patient.patientId}`)
      .code(created ? 201 : 200)
      .send(ok(body));
  });

  // -------------------------------------------------------------------------
  // PUT /patients/:id  — partial merge; absent keys are untouched, not nulled.
  // -------------------------------------------------------------------------
  app.put('/patients/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const patientId = parsePatientId(request);

    const parsed = updatePatientSchema.safeParse(requireJsonObject(request.body));
    if (!parsed.success) {
      throw new ValidationError(BODY_INVALID_MESSAGE, zodIssuesToDetails(parsed.error.issues));
    }

    const patient = await patientService.updatePatient(patientId, toUpdateInput(parsed.data));
    const body = toPatientResponse(patient);

    logPatientPayload(request, 'update', body);

    reply.code(200).send(ok(body));
  });

  // -------------------------------------------------------------------------
  // DELETE /patients/:id — soft delete. 200 with the tombstoned record, not 204:
  // the envelope requirement admits no empty bodies, and returning the record
  // with `deleted_at` set is the clearest evidence this was not a hard delete.
  // -------------------------------------------------------------------------
  app.delete('/patients/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const patientId = parsePatientId(request);
    const patient = await patientService.softDeletePatient(patientId);

    reply.code(200).send(ok(toPatientResponse(patient)));
  });
}

/**
 * Challenge, Observability: "Log agent conversations (at minimum, the final
 * collected data payload) to stdout or a log file."
 *
 * The full collected payload is logged on create and update, exactly as it was
 * persisted and serialized — so the log shows what the database holds, not what
 * the caller happened to send.
 */
function logPatientPayload(
  request: FastifyRequest,
  action: 'create' | 'create_deduped' | 'update',
  payload: PatientResponse,
): void {
  request.log.info(
    {
      event: 'patient_payload',
      action,
      patient_id: payload.patient_id,
      payload,
    },
    'Final collected patient data payload',
  );
}
