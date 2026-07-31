// POST /vapi/events — the assistant server URL. Everything except `tool-calls`
// arrives here, and the one thing it persists is the end-of-call transcript.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { api, prisma, startTestApp } from '../helpers.js';
import { WEBHOOK_SECRET_HEADER } from '../../src/vapi/verify.js';

let app: FastifyInstance;

const ORIGINAL_SECRET = process.env.VAPI_WEBHOOK_SECRET;

/** Same idea as TEST_LAST_NAME_PREFIX: cleanup can never touch a real row. */
const TEST_CALL_ID_PREFIX = 'zzqatest-call-';

async function purgeTestTranscripts(): Promise<void> {
  await prisma.callTranscript.deleteMany({
    where: { vapiCallId: { startsWith: TEST_CALL_ID_PREFIX } },
  });
}

beforeAll(async () => {
  await purgeTestTranscripts();
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
  await purgeTestTranscripts();

  if (ORIGINAL_SECRET === undefined) delete process.env.VAPI_WEBHOOK_SECRET;
  else process.env.VAPI_WEBHOOK_SECRET = ORIGINAL_SECRET;
});

// Known state per test: the ambient .env may define VAPI_WEBHOOK_SECRET and
// these tests must not depend on whether it does. Unset means "allow"; the auth
// block sets it explicitly.
beforeEach(async () => {
  delete process.env.VAPI_WEBHOOK_SECRET;
  await purgeTestTranscripts();
});

/**
 * An end-of-call-report. Note where everything lives: `message.transcript`,
 * `message.summary` and `message.recordingUrl` are ALL undefined (§ G10).
 */
function endOfCallReport(callId: string, overrides: Record<string, unknown> = {}): object {
  return {
    message: {
      type: 'end-of-call-report',
      endedReason: 'hangup',
      startedAt: '2026-07-30T10:00:00.000Z',
      endedAt: '2026-07-30T10:04:30.000Z',
      artifact: {
        transcript: 'AI: Can I get your first and last name? User: Sarah Davis.',
        recordingUrl: 'https://storage.vapi.ai/recording.wav',
      },
      analysis: { summary: 'Caller registered as a new patient.' },
      call: { id: callId },
      ...overrides,
    },
  };
}

describe('POST /vapi/events — end-of-call-report persistence', () => {
  it('persists the transcript from its NESTED locations', async () => {
    const callId = `${TEST_CALL_ID_PREFIX}nested`;

    const res = await api(app).post('/vapi/events').send(endOfCallReport(callId));
    expect(res.status).toBe(200);

    const row = await prisma.callTranscript.findUniqueOrThrow({ where: { vapiCallId: callId } });

    expect(row.transcript).toBe('AI: Can I get your first and last name? User: Sarah Davis.');
    expect(row.summary).toBe('Caller registered as a new patient.');
    expect(row.recordingUrl).toBe('https://storage.vapi.ai/recording.wav');
    expect(row.startedAt?.toISOString()).toBe('2026-07-30T10:00:00.000Z');
    expect(row.endedAt?.toISOString()).toBe('2026-07-30T10:04:30.000Z');
    // No patient registered on this call id, so there is nothing to link to.
    // The abandoned-mid-intake case, and it must keep persisting the transcript.
    expect(row.patientId).toBeNull();
  });

  it('is IDEMPOTENT — the same vapi_call_id twice yields exactly one row', async () => {
    const callId = `${TEST_CALL_ID_PREFIX}retry`;

    const first = await api(app).post('/vapi/events').send(endOfCallReport(callId));
    const second = await api(app).post('/vapi/events').send(endOfCallReport(callId));

    expect(first.status).toBe(200);
    // A retry must not raise P2002 and must not create a second row.
    expect(second.status).toBe(200);

    const rows = await prisma.callTranscript.findMany({ where: { vapiCallId: callId } });
    expect(rows).toHaveLength(1);
  });

  it('a retry updates the existing row in place rather than inserting', async () => {
    const callId = `${TEST_CALL_ID_PREFIX}update`;

    await api(app).post('/vapi/events').send(endOfCallReport(callId));
    const before = await prisma.callTranscript.findUniqueOrThrow({ where: { vapiCallId: callId } });

    await api(app)
      .post('/vapi/events')
      .send(
        endOfCallReport(callId, {
          analysis: { summary: 'Post-processed summary, second delivery.' },
        }),
      );

    const after = await prisma.callTranscript.findUniqueOrThrow({ where: { vapiCallId: callId } });

    expect(after.id).toBe(before.id);
    expect(after.summary).toBe('Post-processed summary, second delivery.');
  });

  it('a THINNER re-delivery does not blank the transcript and recording we already hold', async () => {
    // The test above spreads its overrides at the `message` level, so `artifact`
    // stays fully populated and a second delivery carries everything the first
    // one did. That is not what a retry looks like: the summary arrives after
    // post-processing and the artifact may not be re-sent at all.
    //
    // The handler normalizes every missing field to an explicit `null`, and
    // Prisma reads an explicit null on an update as SET NULL — so spreading the
    // input straight into the update branch would destroy the stored transcript
    // silently. `omitEmpty` in `services/call-transcript.ts` is what prevents it.
    const callId = `${TEST_CALL_ID_PREFIX}thinretry`;

    await api(app).post('/vapi/events').send(endOfCallReport(callId));
    const before = await prisma.callTranscript.findUniqueOrThrow({ where: { vapiCallId: callId } });
    expect(before.transcript).toBeTruthy();
    expect(before.recordingUrl).toBeTruthy();

    // Replaces `artifact` wholesale: transcript and recordingUrl both arrive as
    // null this time, while the post-processed summary finally shows up.
    const res = await api(app)
      .post('/vapi/events')
      .send(
        endOfCallReport(callId, {
          artifact: {},
          analysis: { summary: 'Post-processed summary, arrived on the retry.' },
        }),
      );

    expect(res.status).toBe(200);

    const after = await prisma.callTranscript.findUniqueOrThrow({ where: { vapiCallId: callId } });

    expect(after.id).toBe(before.id);
    expect(after.transcript).toBe(before.transcript);
    expect(after.recordingUrl).toBe(before.recordingUrl);
    expect(after.summary).toBe('Post-processed summary, arrived on the retry.');
  });

  it('keeps the timestamps too when a re-delivery omits them', async () => {
    const callId = `${TEST_CALL_ID_PREFIX}thindates`;

    await api(app).post('/vapi/events').send(endOfCallReport(callId));

    await api(app)
      .post('/vapi/events')
      .send(endOfCallReport(callId, { startedAt: undefined, endedAt: undefined, artifact: {}, analysis: {} }));

    const after = await prisma.callTranscript.findUniqueOrThrow({ where: { vapiCallId: callId } });

    expect(after.startedAt?.toISOString()).toBe('2026-07-30T10:00:00.000Z');
    expect(after.endedAt?.toISOString()).toBe('2026-07-30T10:04:30.000Z');
  });

  it('still writes nulls on the CREATE branch — a first delivery genuinely has nothing yet', async () => {
    // The null-stripping is the update branch only. A sparse FIRST delivery must
    // still land as a row, with the columns it has no data for left NULL, rather
    // than being dropped or defaulted to something invented.
    const callId = `${TEST_CALL_ID_PREFIX}sparsecreate`;

    const res = await api(app)
      .post('/vapi/events')
      .send({ message: { type: 'end-of-call-report', call: { id: callId } } });

    expect(res.status).toBe(200);

    const row = await prisma.callTranscript.findUniqueOrThrow({ where: { vapiCallId: callId } });

    expect(row.transcript).toBeNull();
    expect(row.summary).toBeNull();
    expect(row.recordingUrl).toBeNull();
    expect(row.startedAt).toBeNull();
    expect(row.endedAt).toBeNull();
  });

  it('drops the report (200, no row) when message.call is absent — it is OPTIONAL in the type', async () => {
    const res = await api(app)
      .post('/vapi/events')
      .send({
        message: {
          type: 'end-of-call-report',
          artifact: { transcript: 'orphan' },
          analysis: { summary: 'orphan' },
        },
      });

    expect(res.status).toBe(200);
    expect(await prisma.callTranscript.count({ where: { transcript: 'orphan' } })).toBe(0);
  });

  it('drops the report (200, no row) when message.call.id is longer than the column', async () => {
    // vapi_call_id is VarChar(128). Handing Prisma a longer value raises, and the
    // throw would land in the route's catch as an unexplained persist failure —
    // so an over-length id is read as ABSENT, same as a message with no `call`.
    const oversized = `${TEST_CALL_ID_PREFIX}${'x'.repeat(200)}`;

    const res = await api(app)
      .post('/vapi/events')
      .send(endOfCallReport(oversized, { artifact: { transcript: 'oversized-id-transcript' } }));

    expect(res.status).toBe(200);
    expect(await prisma.callTranscript.count({ where: { transcript: 'oversized-id-transcript' } })).toBe(0);
  });

  it('accepts an id of exactly the column width — the clamp is not off by one', async () => {
    const callId = `${TEST_CALL_ID_PREFIX}`.padEnd(128, 'y');
    expect(callId).toHaveLength(128);

    const res = await api(app).post('/vapi/events').send(endOfCallReport(callId));

    expect(res.status).toBe(200);
    expect(await prisma.callTranscript.count({ where: { vapiCallId: callId } })).toBe(1);
  });

  it('persists a long transcript that registered nobody rather than failing the report', async () => {
    // The tighter check in the handler logs a warning on this path (the linkage
    // is suspect, not the write). The transcript is the only record of the call
    // and must still land, with patient_id NULL.
    const callId = `${TEST_CALL_ID_PREFIX}longnopatient`;
    const transcript = 'AI: Can I get your first and last name? '.repeat(20);
    expect(transcript.length).toBeGreaterThanOrEqual(400);

    const res = await api(app)
      .post('/vapi/events')
      .send(endOfCallReport(callId, { artifact: { transcript }, endedReason: 'customer-ended-call' }));

    expect(res.status).toBe(200);

    const row = await prisma.callTranscript.findUniqueOrThrow({ where: { vapiCallId: callId } });
    expect(row.patientId).toBeNull();
    expect(row.transcript).toBe(transcript);
  });

  it('survives garbage timestamps rather than handing Prisma an Invalid Date', async () => {
    const callId = `${TEST_CALL_ID_PREFIX}baddates`;

    const res = await api(app)
      .post('/vapi/events')
      .send(endOfCallReport(callId, { startedAt: 'banana', endedAt: 42 }));

    expect(res.status).toBe(200);

    const row = await prisma.callTranscript.findUniqueOrThrow({ where: { vapiCallId: callId } });
    expect(row.startedAt).toBeNull();
    expect(row.endedAt).toBeNull();
  });

  it('stores null for a missing summary — SummaryPlan can time out silently (§ G13)', async () => {
    const callId = `${TEST_CALL_ID_PREFIX}nosummary`;

    await api(app).post('/vapi/events').send(endOfCallReport(callId, { analysis: {} }));

    const row = await prisma.callTranscript.findUniqueOrThrow({ where: { vapiCallId: callId } });
    expect(row.summary).toBeNull();
    expect(row.transcript).toBeTruthy();
  });
});

describe('POST /vapi/events — other message types', () => {
  it.each(['status-update', 'hang', 'conversation-update', 'unknown-future-type'])(
    'acknowledges %s with a bare 200 and writes nothing',
    async (type) => {
      const res = await api(app).post('/vapi/events').send({ message: { type, call: { id: 'x' } } });

      expect(res.status).toBe(200);
      expect(await prisma.callTranscript.count({ where: { vapiCallId: 'x' } })).toBe(0);
    },
  );

  it('delegates tool-calls to the tool handler — a tool with no server.url falls back here', async () => {
    const res = await api(app)
      .post('/vapi/events')
      .send({
        message: {
          type: 'tool-calls',
          toolCallList: [
            {
              id: 'tc-fallback',
              function: { name: 'lookup_patient_by_phone', arguments: '{"phone_number":"(512) 555-0199"}' },
            },
          ],
        },
      });

    expect(res.status).toBe(200);
    const results = (res.body as { results: { toolCallId: string; result?: string }[] }).results;
    expect(results[0]?.toolCallId).toBe('tc-fallback');
    expect(results[0]?.result).toBeTruthy();
  });
});

describe('POST /vapi/events — webhook authentication', () => {
  it('rejects a wrong secret with 401 and persists nothing', async () => {
    process.env.VAPI_WEBHOOK_SECRET = 'the-real-secret';
    const callId = `${TEST_CALL_ID_PREFIX}unauthorized`;

    const res = await api(app)
      .post('/vapi/events')
      .set(WEBHOOK_SECRET_HEADER, 'wrong')
      .send(endOfCallReport(callId));

    expect(res.status).toBe(401);
    expect(await prisma.callTranscript.count({ where: { vapiCallId: callId } })).toBe(0);
  });

  it('accepts the correct secret', async () => {
    process.env.VAPI_WEBHOOK_SECRET = 'the-real-secret';
    const callId = `${TEST_CALL_ID_PREFIX}authorized`;

    const res = await api(app)
      .post('/vapi/events')
      .set(WEBHOOK_SECRET_HEADER, 'the-real-secret')
      .send(endOfCallReport(callId));

    expect(res.status).toBe(200);
    expect(await prisma.callTranscript.count({ where: { vapiCallId: callId } })).toBe(1);
  });

  it('allows when VAPI_WEBHOOK_SECRET is unset', async () => {
    delete process.env.VAPI_WEBHOOK_SECRET;
    const callId = `${TEST_CALL_ID_PREFIX}unconfigured`;

    const res = await api(app).post('/vapi/events').send(endOfCallReport(callId));

    expect(res.status).toBe(200);
    expect(await prisma.callTranscript.count({ where: { vapiCallId: callId } })).toBe(1);
  });
});
