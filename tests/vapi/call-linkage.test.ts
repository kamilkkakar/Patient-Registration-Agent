// Transcript -> patient linkage, end to end over the two webhook routes.
//
// The link is resolved from the DATABASE — `create_patient` stamps
// `message.call.id` on the patient row, the end-of-call report looks it up. That
// is the whole point: an in-memory map would lose every link on a restart or a
// second instance, and Vapi delivers the report minutes after the tool call.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { api, prisma, purgeTestPatients, startTestApp, testLastName } from '../helpers.js';

let app: FastifyInstance;

const ORIGINAL_SECRET = process.env.VAPI_WEBHOOK_SECRET;

/**
 * Shared with `tests/api/patients.transcripts.test.ts` and
 * `tests/vapi/events.test.ts`, which purge on the same prefix. Safe ONLY
 * because vitest.config.ts sets `fileParallelism: false`.
 */
const TEST_CALL_ID_PREFIX = 'zzqatest-call-';

async function purgeTestTranscripts(): Promise<void> {
  await prisma.callTranscript.deleteMany({
    where: { vapiCallId: { startsWith: TEST_CALL_ID_PREFIX } },
  });
}

beforeAll(async () => {
  await purgeTestTranscripts();
  await purgeTestPatients();
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
  await purgeTestTranscripts();
  await purgeTestPatients();

  if (ORIGINAL_SECRET === undefined) delete process.env.VAPI_WEBHOOK_SECRET;
  else process.env.VAPI_WEBHOOK_SECRET = ORIGINAL_SECRET;
});

// Unset means "allow with a loud warning"; nothing here is about auth.
beforeEach(() => {
  delete process.env.VAPI_WEBHOOK_SECRET;
});

// ---------------------------------------------------------------------------
// Body builders
// ---------------------------------------------------------------------------

/** What the caller said. Keys are the wire (snake_case) names the tool takes. */
function spokenPayload(lastName: string, overrides: Record<string, unknown> = {}): object {
  return {
    first_name: 'Sarah',
    last_name: lastName,
    date_of_birth: '02/15/1992',
    sex: 'Female',
    phone_number: '5125550142',
    address_line_1: '4120 Guadalupe Street',
    city: 'Austin',
    state: 'TX',
    zip_code: '78701',
    ...overrides,
  };
}

/**
 * `[SPEC]` shape, WITH `message.call` — the id lives on the message, not on the
 * tool call, which is why the route reads it once per message.
 */
function createPatientCall(callId: string | null, payload: object, toolCallId = 'tc-link'): object {
  return {
    message: {
      type: 'tool-calls',
      toolCallList: [
        {
          id: toolCallId,
          type: 'function',
          function: { name: 'create_patient', arguments: JSON.stringify(payload) },
        },
      ],
      ...(callId === null ? {} : { call: { id: callId } }),
    },
  };
}

function endOfCallReport(callId: string, overrides: Record<string, unknown> = {}): object {
  return {
    message: {
      type: 'end-of-call-report',
      endedReason: 'hangup',
      startedAt: '2026-07-30T10:00:00.000Z',
      endedAt: '2026-07-30T10:04:30.000Z',
      artifact: {
        transcript: 'AI: Can I get your first and last name? User: Sarah Davis.',
        recordingUrl: 'https://storage.vapi.ai/linked.wav',
      },
      analysis: { summary: 'Caller registered as a new patient.' },
      call: { id: callId },
      ...overrides,
    },
  };
}

/**
 * Runs the tool call, asserts it registered someone, and returns the new id.
 *
 * The id is read out of the result string rather than by querying on the last
 * name: the voice ingress normalizes names before they are stored, so the row's
 * `last_name` is not byte-identical to what was sent.
 */
async function registerOverPhone(callId: string | null, lastName: string): Promise<string> {
  const res = await api(app).post('/vapi/tool').send(createPatientCall(callId, spokenPayload(lastName)));

  expect(res.status).toBe(200);
  const results = (res.body as { results: { result?: string; error?: string }[] }).results;
  expect(results[0]?.error).toBeUndefined();
  expect(results[0]?.result).toContain('Patient ID');

  const patientId = /Patient ID ([0-9a-f-]{36})/.exec(results[0]?.result ?? '')?.[1];
  expect(patientId).toBeDefined();

  return patientId ?? '';
}

// ---------------------------------------------------------------------------

describe('create_patient — call provenance', () => {
  it('stamps message.call.id on the patient row', async () => {
    const callId = `${TEST_CALL_ID_PREFIX}stamp`;
    const lastName = testLastName('Linkstamp');

    const patientId = await registerOverPhone(callId, lastName);

    const patient = await prisma.patient.findUniqueOrThrow({ where: { patientId } });
    expect(patient.vapiCallId).toBe(callId);
  });

  it('still registers the patient when message.call.id is too long for the column', async () => {
    // vapi_call_id is VarChar(128), so a longer id would make Prisma reject the
    // whole create. Registration is the core path: it must survive an id we
    // cannot store, and simply keep no linkage.
    const lastName = testLastName('Linklongid');
    const oversized = `${TEST_CALL_ID_PREFIX}${'x'.repeat(200)}`;

    const patientId = await registerOverPhone(oversized, lastName);

    const patient = await prisma.patient.findUniqueOrThrow({ where: { patientId } });
    expect(patient.vapiCallId).toBeNull();
  });

  it('still registers the patient when the message carries no call — the id is OPTIONAL', async () => {
    const lastName = testLastName('Linknocall');

    const patientId = await registerOverPhone(null, lastName);

    const patient = await prisma.patient.findUniqueOrThrow({ where: { patientId } });
    expect(patient.vapiCallId).toBeNull();
  });
});

describe('end-of-call-report — transcript linkage', () => {
  it('links the transcript to the patient that call registered, and stores the recording URL', async () => {
    const callId = `${TEST_CALL_ID_PREFIX}linked`;
    const lastName = testLastName('Linkhappy');

    const patientId = await registerOverPhone(callId, lastName);

    const res = await api(app).post('/vapi/events').send(endOfCallReport(callId));
    expect(res.status).toBe(200);

    const row = await prisma.callTranscript.findUniqueOrThrow({ where: { vapiCallId: callId } });
    expect(row.patientId).toBe(patientId);
    expect(row.recordingUrl).toBe('https://storage.vapi.ai/linked.wav');

    // And it is readable through the public route.
    const read = await api(app).get(`/patients/${patientId}/transcripts`);
    expect(read.status).toBe(200);
    const rows = read.body.data as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['vapi_call_id']).toBe(callId);
    expect(rows[0]?.['recording_url']).toBe('https://storage.vapi.ai/linked.wav');
  });

  it('is IDEMPOTENT on a repeat delivery — one row, same id, same link', async () => {
    const callId = `${TEST_CALL_ID_PREFIX}linkretry`;
    const lastName = testLastName('Linkretry');

    const patientId = await registerOverPhone(callId, lastName);

    await api(app).post('/vapi/events').send(endOfCallReport(callId));
    const before = await prisma.callTranscript.findUniqueOrThrow({ where: { vapiCallId: callId } });

    const second = await api(app).post('/vapi/events').send(endOfCallReport(callId));
    expect(second.status).toBe(200);

    const rows = await prisma.callTranscript.findMany({ where: { vapiCallId: callId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(before.id);
    expect(rows[0]?.patientId).toBe(patientId);
  });

  it('persists with patient_id NULL when the call registered nobody — abandoned mid-intake', async () => {
    const callId = `${TEST_CALL_ID_PREFIX}abandoned`;

    const res = await api(app).post('/vapi/events').send(endOfCallReport(callId));
    expect(res.status).toBe(200);

    const row = await prisma.callTranscript.findUniqueOrThrow({ where: { vapiCallId: callId } });
    expect(row.patientId).toBeNull();
    // The transcript is the whole value of an abandoned call. It must survive.
    expect(row.transcript).toBeTruthy();
  });

  it('links on a LATE re-delivery: the report can land before the patient row does', async () => {
    const callId = `${TEST_CALL_ID_PREFIX}late`;
    const lastName = testLastName('Linklate');

    await api(app).post('/vapi/events').send(endOfCallReport(callId));
    const orphan = await prisma.callTranscript.findUniqueOrThrow({ where: { vapiCallId: callId } });
    expect(orphan.patientId).toBeNull();

    const patientId = await registerOverPhone(callId, lastName);

    await api(app).post('/vapi/events').send(endOfCallReport(callId));

    const linked = await prisma.callTranscript.findUniqueOrThrow({ where: { vapiCallId: callId } });
    expect(linked.id).toBe(orphan.id);
    expect(linked.patientId).toBe(patientId);
  });

  it('never BLANKS a link it already has when a later delivery resolves nothing', async () => {
    const callId = `${TEST_CALL_ID_PREFIX}nounlink`;
    const lastName = testLastName('Linknounlink');

    const patientId = await registerOverPhone(callId, lastName);
    await api(app).post('/vapi/events').send(endOfCallReport(callId));

    // Force the lookup to resolve to nothing on the next delivery.
    await prisma.patient.update({ where: { patientId }, data: { vapiCallId: null } });

    await api(app).post('/vapi/events').send(endOfCallReport(callId));

    const row = await prisma.callTranscript.findUniqueOrThrow({ where: { vapiCallId: callId } });
    expect(row.patientId).toBe(patientId);
  });

  it('links to the FIRST patient when one call registered two family members', async () => {
    const callId = `${TEST_CALL_ID_PREFIX}family`;
    const firstRegistered = testLastName('Linkfamilya');

    const firstPatientId = await registerOverPhone(callId, firstRegistered);

    await registerOverPhone(callId, testLastName('Linkfamilyb'));

    await api(app).post('/vapi/events').send(endOfCallReport(callId));

    const row = await prisma.callTranscript.findUniqueOrThrow({ where: { vapiCallId: callId } });
    // Oldest first, so a re-delivery always resolves to the same row.
    expect(row.patientId).toBe(firstPatientId);
  });
});
