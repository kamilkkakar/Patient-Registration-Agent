// Fastify app factory.
//
// Deliberately does NOT listen: the test suite needs a fully wired instance it
// can drive over an ephemeral port (Supertest) without racing a real bind.
// `src/server.ts` is the only thing that calls listen().

import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
} from 'fastify';
import { logger } from './lib/logger.js';
import { registerErrorHandler } from './lib/error-handler.js';
import { ERROR_CODES, fail } from './lib/envelope.js';
import { patientRoutes } from './routes/patients.js';
import { healthRoutes } from './routes/health.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { vapiRoutes } from './vapi/routes.js';

// Two failure classes never reach a route, so `setErrorHandler` never sees them
// and both used to escape as bare Fastify bodies — breaking the "every response
// uses the envelope, including errors" rule CLAUDE.md states without exception.
// Neither message is derived from the caught error; the same reason the 500
// message is a hardcoded constant applies here.
const ROUTING_ERROR_MESSAGE = 'Request could not be routed. Check the URL.';
const CLIENT_ERROR_MESSAGE = 'Malformed HTTP request.';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Fastify 5 takes a pre-built pino instance under `loggerInstance`, so
    // request logs and application logs share one stream and one reqId.
    // Widened to FastifyBaseLogger so the instance keeps its default generics —
    // otherwise every consumer would have to spell out the pino Logger type.
    loggerInstance: logger as FastifyBaseLogger,
    // Request/response logging is left ON (Fastify's default) — the challenge
    // asks for observability, and it gives every log line a `reqId`.
    // Do not echo the client's header back as a correlation id; generate ours.
    requestIdHeader: false,

    // --- Router-level errors, raised before any route runs. ---
    // FST_ERR_BAD_URL          (400) -> GET /patients/%E0%A4%A
    // FST_ERR_MAX_PARAM_LENGTH (414) -> a path param over `maxParamLength`
    // FST_ERR_ASYNC_CONSTRAINT (500) -> unreachable here; no constraints are set
    //
    // All are answered 400. The challenge's status list is 200/201/400/404/422/
    // 500, so passing `error.statusCode` straight through would emit a 414 that
    // is not on it — the same normalization the global handler already applies
    // to Fastify's 415.
    //
    // The body is stringified by hand: at this point the reply has no route
    // attached and therefore no route serializer, so `send(object)` cannot be
    // relied on to produce the envelope shape.
    frameworkErrors: (error, request, reply) => {
      request.log.info(
        { event: 'request_rejected', fastify_code: error.code, original_status: error.statusCode },
        'Unroutable request',
      );

      // `frameworkErrors` types its reply against a route's schema generics,
      // and there is no route here — hence the widening cast.
      void (reply as FastifyReply)
        .code(400)
        .type('application/json')
        .send(JSON.stringify(fail(ERROR_CODES.BAD_REQUEST, ROUTING_ERROR_MESSAGE)));
    },

    // --- Socket-level errors: Node's HTTP parser rejected the request. ---
    // `curl -X FOO` is the everyday case (HPE_INVALID_METHOD). There is no
    // FastifyRequest and no FastifyReply here — the bytes never parsed into
    // one — so the response is written to the socket directly. Fastify's own
    // default does exactly this, just with a bare `{"error":...}` body.
    //
    // 408 (timeout) and 431 (header overflow), which Fastify's default
    // distinguishes, are folded into 400 for the status-list reason above.
    clientErrorHandler: (error, socket) => {
      // Nothing to answer on a reset or already-torn-down socket.
      if (error.code === 'ECONNRESET' || socket.destroyed) return;

      logger.info({ event: 'client_error', err: error }, 'Malformed HTTP request');

      if (socket.writable) {
        const body = JSON.stringify(fail(ERROR_CODES.BAD_REQUEST, CLIENT_ERROR_MESSAGE));
        socket.write(
          'HTTP/1.1 400 Bad Request\r\n' +
            'Content-Type: application/json\r\n' +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            'Connection: close\r\n' +
            '\r\n' +
            body,
        );
      }

      socket.destroy(error);
    },
  });

  // Registered before the routes so it also catches registration-time throws.
  registerErrorHandler(app);

  await app.register(healthRoutes);
  await app.register(patientRoutes);
  // The dashboard adds exactly two GET routes and no wildcard, so it cannot
  // shadow anything above it — see the header of routes/dashboard.ts.
  await app.register(dashboardRoutes);
  // Registered last, and in its own encapsulation context: the Vapi routes carry
  // a DIFFERENT error contract (HTTP 200 always) and install their own error
  // handler, which must not leak onto the REST routes above.
  await app.register(vapiRoutes);

  return app;
}
