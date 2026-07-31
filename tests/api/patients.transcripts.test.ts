// GET /patients/:id/transcripts — the read-only view of a patient's calls.
//
// The 404 pair is the point of this suite: an unknown id and a soft-deleted one
// must be indistinguishable here, exactly as they are on GET /patients/:id. A
// route that only listed transcripts would answer 200 with `[]` for both.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  api,
  assertEnvelope,
  prisma,
  purgeTestPatients,
  startTestApp,
  testLastName,
  validPayload,
} from '../helpers.js';

let app: FastifyInstance;

/**
 * Same idea as TEST_LAST_NAME_PREFIX: cleanup can never touch a real row.
 *
 * Shared with `tests/vapi/call-linkage.test.ts`, which also purges on this
 * prefix and on TEST_LAST_NAME_PREFIX. Safe ONLY because vitest.config.ts sets
 * `fileParallelism: false`; the two files would purge each other's fixtures if
 * that flag were ever flipped.
 */
const TEST_CALL_ID_PREFIX = 'zzqatest-call-';

async function purgeTestTranscripts(): Promise<void> {
  await prisma.callTranscript.deleteMany({
    where: { vapiCallId: { startsWith: TEST_CALL_ID_PREFIX } },
  });
}

beforeAll(async () => {
  // Transcripts first: the FK is ON DELETE SET NULL, so a leftover row would
  // survive the patient purge and then fail its own prefix filter.
  await purgeTestTranscripts();
  await purgeTestPatients();
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
  await purgeTestTranscripts();
  await purgeTestPatients();
});

async function createPatient(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await api(app).post('/patients').send(validPayload(overrides));
  expect(res.status).toBe(201);
  return String((res.body.data as Record<string, unknown>)['patient_id']);
}

describe('GET /patients/:id/transcripts', () => {
  it('returns the patient transcripts in the envelope, newest call first', async () => {
    const patientId = await createPatient({ last_name: testLastName('Transhappy') });

    await prisma.callTranscript.create({
      data: {
        patientId,
        vapiCallId: `${TEST_CALL_ID_PREFIX}happy-old`,
        transcript: 'AI: Hello. User: Hi.',
        summary: 'First call.',
        recordingUrl: 'https://storage.vapi.ai/old.wav',
        startedAt: new Date('2026-07-30T10:00:00.000Z'),
        endedAt: new Date('2026-07-30T10:04:30.000Z'),
        createdAt: new Date('2026-07-30T10:05:00.000Z'),
      },
    });
    await prisma.callTranscript.create({
      data: {
        patientId,
        vapiCallId: `${TEST_CALL_ID_PREFIX}happy-new`,
        summary: 'Second call.',
        createdAt: new Date('2026-07-30T12:05:00.000Z'),
      },
    });

    const res = await api(app).get(`/patients/${patientId}/transcripts`);

    expect(res.status).toBe(200);
    assertEnvelope(res.body);
    expect(res.body.error).toBeNull();

    const rows = res.body.data as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.['vapi_call_id']).toBe(`${TEST_CALL_ID_PREFIX}happy-new`);

    // Fixed key set: absent values are null, never omitted.
    expect(rows[1]).toEqual({
      id: expect.any(String),
      patient_id: patientId,
      vapi_call_id: `${TEST_CALL_ID_PREFIX}happy-old`,
      transcript: 'AI: Hello. User: Hi.',
      summary: 'First call.',
      recording_url: 'https://storage.vapi.ai/old.wav',
      started_at: '2026-07-30T10:00:00.000Z',
      ended_at: '2026-07-30T10:04:30.000Z',
      created_at: '2026-07-30T10:05:00.000Z',
      updated_at: expect.any(String),
    });
    expect(rows[0]?.['transcript']).toBeNull();
    expect(rows[0]?.['recording_url']).toBeNull();
    expect(rows[0]?.['started_at']).toBeNull();
  });

  it('returns an empty collection for a patient who has never had a call', async () => {
    const patientId = await createPatient({ last_name: testLastName('Transempty') });

    const res = await api(app).get(`/patients/${patientId}/transcripts`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('does not leak another patient transcripts', async () => {
    const mine = await createPatient({ last_name: testLastName('Transmine') });
    const theirs = await createPatient({ last_name: testLastName('Transtheirs') });

    await prisma.callTranscript.create({
      data: { patientId: theirs, vapiCallId: `${TEST_CALL_ID_PREFIX}theirs`, summary: 'Not mine.' },
    });

    const res = await api(app).get(`/patients/${mine}/transcripts`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('404s on a well-formed but unknown patient id', async () => {
    const res = await api(app).get('/patients/9f1c2b3a-4d5e-4f70-8192-a3b4c5d6e7f8/transcripts');

    expect(res.status).toBe(404);
    assertEnvelope(res.body);
    expect(res.body.data).toBeNull();
    expect((res.body.error as Record<string, unknown>)['code']).toBe('NOT_FOUND');
  });

  it('404s on a SOFT-DELETED patient, even though the transcripts still exist', async () => {
    const patientId = await createPatient({ last_name: testLastName('Transdeleted') });

    await prisma.callTranscript.create({
      data: {
        patientId,
        vapiCallId: `${TEST_CALL_ID_PREFIX}deleted`,
        summary: 'Still in the database.',
      },
    });

    expect((await api(app).delete(`/patients/${patientId}`)).status).toBe(200);

    const res = await api(app).get(`/patients/${patientId}/transcripts`);

    expect(res.status).toBe(404);
    expect((res.body.error as Record<string, unknown>)['code']).toBe('NOT_FOUND');

    // Soft delete never touches a transcript — the row is hidden, not gone.
    const row = await prisma.callTranscript.findUniqueOrThrow({
      where: { vapiCallId: `${TEST_CALL_ID_PREFIX}deleted` },
    });
    expect(row.patientId).toBe(patientId);
  });

  it('400s on a malformed patient id — malformed is not the same as unknown', async () => {
    const res = await api(app).get('/patients/not-a-uuid/transcripts');

    expect(res.status).toBe(400);
    expect((res.body.error as Record<string, unknown>)['code']).toBe('BAD_REQUEST');
  });
});

describe('POST /patients — call provenance', () => {
  it('leaves vapi_call_id NULL: a REST-created patient came from no call', async () => {
    const patientId = await createPatient({ last_name: testLastName('Transrest') });

    const row = await prisma.patient.findUniqueOrThrow({ where: { patientId } });
    expect(row.vapiCallId).toBeNull();
  });

  it('does not expose vapi_call_id on the wire — it is provenance, not a patient field', async () => {
    const res = await api(app).post('/patients').send(validPayload({ last_name: testLastName('Transwire') }));

    expect(res.status).toBe(201);
    expect(res.body.data).not.toHaveProperty('vapi_call_id');
  });
});
