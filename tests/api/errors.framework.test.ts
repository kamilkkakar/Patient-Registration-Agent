// Errors raised BELOW the route layer.
//
// `setErrorHandler` only sees failures that reach a route. Three classes never
// get that far and used to escape as bare Fastify bodies, breaking CLAUDE.md's
// "every response uses the envelope, including errors":
//
//   FST_ERR_BAD_URL          — an undecodable percent-escape in the path
//   FST_ERR_MAX_PARAM_LENGTH — a path param longer than `maxParamLength`
//   HPE_INVALID_METHOD       — a verb Node's HTTP parser does not recognise
//
// The first two are router-level and are re-emitted by `frameworkErrors`. The
// third never becomes a request at all: Node raises `clientError` on the raw
// socket, so it is `clientErrorHandler` that has to write the envelope by hand.
// Requests are therefore sent over a raw socket — no HTTP client will emit a
// malformed request line on our behalf.

import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { listenTestApp, testPort } from '../helpers.js';

let app: FastifyInstance;
let port: number;

beforeAll(async () => {
  app = await listenTestApp();
  port = testPort(app);
});

afterAll(async () => {
  await app.close();
});

interface RawResponse {
  status: number;
  body: unknown;
}

/** Write one hand-built request line and read the whole response back. */
function rawRequest(requestLine: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let raw = '';

    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`${requestLine}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      raw += chunk;
    });
    // The server destroys the socket after a client error, so `error` fires
    // AFTER the bytes we care about have already arrived.
    socket.on('error', (err) => {
      if (raw.length === 0) reject(err);
    });
    socket.on('close', () => {
      const statusLine = raw.slice(0, raw.indexOf('\r\n'));
      const status = Number(statusLine.split(' ')[1]);
      const separator = raw.indexOf('\r\n\r\n');
      const bodyText = separator === -1 ? '' : raw.slice(separator + 4);

      let body: unknown = bodyText;
      try {
        body = JSON.parse(bodyText);
      } catch {
        // Leave the raw text in place; the assertion below will show it.
      }

      resolve({ status, body });
    });
  });
}

/** Every one of these must be indistinguishable from any other 400 we emit. */
function expectBadRequestEnvelope(res: RawResponse): void {
  expect(res.status).toBe(400);
  expect(res.body).toMatchObject({
    data: null,
    error: {
      code: 'BAD_REQUEST',
      details: null,
    },
  });
  expect(typeof (res.body as { error: { message: unknown } }).error.message).toBe('string');
}

describe('router-level and socket-level errors use the envelope', () => {
  it('wraps FST_ERR_BAD_URL (undecodable percent-escape)', async () => {
    const res = await rawRequest('GET /patients/%E0%A4%A HTTP/1.1');
    expectBadRequestEnvelope(res);
  });

  it('wraps FST_ERR_MAX_PARAM_LENGTH (over-long path param)', async () => {
    const res = await rawRequest(`GET /patients/${'a'.repeat(1000)} HTTP/1.1`);
    expectBadRequestEnvelope(res);
  });

  it('wraps an unparseable HTTP method', async () => {
    const res = await rawRequest('FOO /patients HTTP/1.1');
    expectBadRequestEnvelope(res);
  });

  it('leaks no framework internals in any of them', async () => {
    const responses = await Promise.all([
      rawRequest('GET /patients/%E0%A4%A HTTP/1.1'),
      rawRequest(`GET /patients/${'a'.repeat(1000)} HTTP/1.1`),
      rawRequest('FOO /patients HTTP/1.1'),
    ]);

    for (const res of responses) {
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toMatch(/FST_ERR_/);
      expect(serialized).not.toContain('statusCode');
    }
  });
});
