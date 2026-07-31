// The last net under the per-call try/catch.
//
// `src/vapi/routes.ts` installs its own `setErrorHandler` inside the plugin's
// encapsulation context, on the claim that it shadows the ROOT handler
// (`registerErrorHandler`, which answers 500) for /vapi/* and nothing else. That
// claim rests on Fastify encapsulation semantics rather than on anything the
// other tests observe — and if it is wrong, an unexpected throw makes
// /vapi/tool answer 500, which Vapi discards entirely and the caller hears
// silence. That is precisely non-negotiable #1 (§ G5).
//
// So: force a throw OUTSIDE the per-call try/catch and watch what comes back.
// `extractToolCallList` is called before the try block, so mocking it to throw
// is the cleanest way in.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../../src/vapi/parse-tool-call.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/vapi/parse-tool-call.js')>();
  return {
    ...actual,
    extractToolCallList: (): unknown[] => {
      throw new Error('boom — simulated unexpected failure');
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

describe('the Vapi routes shadow the root error handler', () => {
  it('/vapi/tool answers 200 with an empty results array, NOT 500', async () => {
    const res = await api(app)
      .post('/vapi/tool')
      .send({ message: { type: 'tool-calls', toolCallList: [{ id: 'x' }] } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
  });

  it('/vapi/events answers 200 for a tool call too — the handler reads the TYPE, not the URL', async () => {
    // This used to assert 500, on the reasoning that /vapi/events is the event
    // route and events should fail loudly. That was wrong: /vapi/events also
    // handles `tool-calls`, because a tool created without its own `server.url`
    // falls back to the assistant URL (contract § 5.2). Vapi discards any
    // non-200, so the model never got a result for that toolCallId and the
    // caller heard silence. The non-tool-call 500 path is pinned separately in
    // `error-handler.events.test.ts`, which needs a throw point this file's
    // mock cannot reach.
    const res = await api(app).post('/vapi/events').send({ message: { type: 'tool-calls' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
  });

  // The leak check that used to live here asserted no 'boom' in a /vapi/events
  // tool-call body. That body is now `{results:[]}`, which the test above pins
  // exactly, so the substring check could no longer fail on its own. Leak
  // coverage moved to the 500 path in `error-handler.events.test.ts`, which is
  // the only answer that carries an error body at all.

  it('does NOT shadow the handler for the REST routes', async () => {
    // The mock only affects the Vapi module; /patients must still answer with
    // the REST contract's own status codes.
    const res = await api(app).get('/patients/not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ data: null, error: { code: 'BAD_REQUEST' } });
  });
});
