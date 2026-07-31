// The global error handler. Every failure leaving this service — ours, Fastify's,
// or an unexpected throw — is turned into a `{ data, error }` envelope here and
// nowhere else.
//
// Two things this file exists to prevent:
//   1. A status code outside the challenge's list (200, 201, 400, 404, 422, 500)
//      reaching the client. Fastify's own content-type guard answers 415, which
//      is not on that list — see § 7.3 of the handoff.
//   2. Internal detail leaking. A Prisma connection failure puts the DATABASE_URL
//      in `error.message`; a stack trace names files on disk. Neither may appear
//      in a response body, so the 500 message is a hardcoded constant.

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from './errors.js';
import { ERROR_CODES, fail, zodIssuesToDetails, type ErrorCode } from './envelope.js';

/** Never interpolated, never derived from the caught error. */
const INTERNAL_MESSAGE = 'An unexpected internal error occurred.';

const MALFORMED_BODY_MESSAGE =
  'Request body could not be parsed. Send valid JSON with Content-Type: application/json.';

export function registerErrorHandler(app: FastifyInstance): void {
  // Unknown route -> 404 in the envelope, not Fastify's bare default body.
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    reply.code(404).send(fail(ERROR_CODES.NOT_FOUND, 'Route not found.'));
  });

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    // --- Our own typed errors: they already carry status, code and details. ---
    if (error instanceof AppError) {
      request.log.info(
        { event: 'request_rejected', error_code: error.code, status: error.statusCode },
        error.message,
      );
      reply.code(error.statusCode).send(fail(error.code as ErrorCode, error.message, error.details));
      return;
    }

    // --- Dead-letter net for a ZodError that escaped a route's safeParse. ---
    // Routes are expected to convert Zod failures themselves (param/query ->
    // 400, body -> 422). This branch only stops a raw ZodError becoming a 500.
    if (error instanceof ZodError) {
      request.log.warn({ event: 'unconverted_zod_error' }, 'ZodError reached the error handler');
      reply
        .code(422)
        .send(
          fail(
            ERROR_CODES.VALIDATION_ERROR,
            'Request failed validation.',
            zodIssuesToDetails(error.issues),
          ),
        );
      return;
    }

    // --- Fastify's own pre-handler rejections. ---
    // FST_ERR_CTP_INVALID_MEDIA_TYPE  (415) -> text/plain POST
    // FST_ERR_CTP_EMPTY_JSON_BODY     (400) -> no body at all
    // FST_ERR_CTP_INVALID_JSON_BODY   (400) -> unparseable JSON
    // All three are "malformed request", so all three are 400 BAD_REQUEST.
    // Note the distinction from the PUT rules: an empty BODY is 400 here; an
    // empty JSON OBJECT `{}` is a 422 raised by the route's schema.
    const fastifyCode = typeof error.code === 'string' ? error.code : '';
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;

    if (fastifyCode.startsWith('FST_ERR_CTP_') || status === 400 || status === 415) {
      request.log.info(
        { event: 'request_rejected', fastify_code: fastifyCode, original_status: status },
        'Malformed request',
      );
      reply.code(400).send(fail(ERROR_CODES.BAD_REQUEST, MALFORMED_BODY_MESSAGE));
      return;
    }

    // --- Anything else. Full detail to the log, nothing to the client. ---
    request.log.error({ event: 'unhandled_error', err: error }, 'Unhandled error');
    reply.code(500).send(fail(ERROR_CODES.INTERNAL_ERROR, INTERNAL_MESSAGE));
  });
}
