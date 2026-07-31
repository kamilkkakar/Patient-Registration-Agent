// The encapsulated error handler discriminates on MESSAGE TYPE, not on URL.
//
// `/vapi/events` deliberately also handles `tool-calls` — a tool created without
// its own `server.url` falls back to the assistant URL (contract § 5.2). A
// URL-based check therefore answered 500 for a tool call that arrived on the
// events route, Vapi discarded it, the model never got a result for that
// toolCallId, and the caller heard silence mid-registration.
//
// Proving that needs a throw that is NOT specific to the tool-calls branch, so
// that one and the same failure can be delivered as every message type and only
// the type decides the shape of the answer. `extractToolCallList` (the lever
// `error-handler.test.ts` pulls) is only reached on the tool-calls path, and
// `handleEndOfCallReport` has its own try/catch that deliberately answers 200.
// `verifyWebhookSecret` is the one thing both routes call, first, outside any
// try/catch — so it is the throw point that covers all three branches.
//
// Separate file rather than an addition to `error-handler.test.ts`: that file
// carries a module-level mock of `parse-tool-call.js`, and `vi.mock` is hoisted
// per module graph, so the two mocks cannot coexist in one suite.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../../src/vapi/verify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/vapi/verify.js')>();
  return {
    ...actual,
    verifyWebhookSecret: (): never => {
      throw new Error('boom — simulated unexpected failure in the auth guard');
    },
  };
});

const { api, startTestApp } = await import('../helpers.js');

let app: FastifyInstance;

const ORIGINAL_SECRET = process.env.VAPI_WEBHOOK_SECRET;

beforeAll(async () => {
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();

  if (ORIGINAL_SECRET === undefined) delete process.env.VAPI_WEBHOOK_SECRET;
  else process.env.VAPI_WEBHOOK_SECRET = ORIGINAL_SECRET;
});

beforeEach(() => {
  delete process.env.VAPI_WEBHOOK_SECRET;
});

describe('the Vapi error handler discriminates on message.type, not on the URL', () => {
  it('answers a tool call on /vapi/events with 200 and {results:[]}, NOT 500', async () => {
    // The regression: a tool with no `server.url` of its own posts its
    // `tool-calls` message here, and a 500 is discarded by Vapi entirely.
    const res = await api(app)
      .post('/vapi/events')
      .send({
        message: {
          type: 'tool-calls',
          toolCallList: [{ id: 'tc-fallback', function: { name: 'lookup_patient_by_phone', arguments: '{}' } }],
        },
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
  });

  it('answers a tool call on /vapi/tool with 200 and {results:[]} — unchanged', async () => {
    const res = await api(app)
      .post('/vapi/tool')
      .send({ message: { type: 'tool-calls', toolCallList: [{ id: 'tc-direct' }] } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
  });

  it('still answers 500 in the REST envelope for a NON-tool-call event', async () => {
    // Nothing is waiting on a toolCallId here, so a broken event should be loud.
    const res = await api(app)
      .post('/vapi/events')
      .send({ message: { type: 'end-of-call-report', call: { id: 'zzqatest-call-errhandler' } } });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ data: null, error: { code: 'INTERNAL_ERROR' } });
  });

  it('leaks no internal detail in that 500 body', async () => {
    const res = await api(app)
      .post('/vapi/events')
      .send({ message: { type: 'status-update', call: { id: 'zzqatest-call-errhandler' } } });

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('boom');
  });

  it('falls back to the URL when the body carries no readable message type', async () => {
    // The body is often unparseable precisely BECAUSE we are in the error
    // handler, so the URL remains the fallback — still right for /vapi/tool.
    const res = await api(app).post('/vapi/tool').send({ nothing: 'useful' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
  });
});
