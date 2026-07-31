// Structured logging. One pino instance for the whole process; Fastify is handed
// this same instance so request logs and application logs share a stream and a
// correlation id (`reqId`).
//
// The challenge's Observability requirement is "Log agent conversations (at
// minimum, the final collected data payload)". That payload is logged by the
// create/update routes under `event: "patient_payload"`.

import pino from 'pino';

/**
 * `silent` is used by the test suite so a green run is readable.
 * Anything else falls back to `info`.
 */
const level = process.env.LOG_LEVEL ?? 'info';

export const logger = pino({
  level,
  base: { service: 'patient-registration-api' },
  // Never let credentials reach the log stream, even by accident.
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-vapi-secret"]'],
    remove: true,
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
});

export type Logger = typeof logger;
