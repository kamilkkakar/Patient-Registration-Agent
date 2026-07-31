// Health check.
//
// Railway polls this to decide whether a deploy is live and whether to keep
// routing traffic to it. It is also the fastest way for a reviewer to confirm
// the API is up before trying anything else.
//
// The check is DEEP, not shallow: it issues a trivial query rather than just
// returning 200. A process that is listening but cannot reach Postgres is not
// healthy for our purposes — every meaningful endpoint would 500, and during a
// phone call that surfaces as the agent apologising after the caller has
// already given their details. Better for the platform to know immediately.
//
// The query itself lives in `src/services/health.ts`. This file is HTTP only,
// like every other route: no Prisma import, no envelope built by hand.

import type { FastifyInstance } from 'fastify';
import { ERROR_CODES, fail, ok } from '../lib/envelope.js';
import { checkDatabase } from '../services/health.js';

interface HealthPayload {
  status: 'ok' | 'degraded';
  database: 'up' | 'down';
  uptime_seconds: number;
  timestamp: string;
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (request, reply) => {
    let database: HealthPayload['database'] = 'down';

    try {
      await checkDatabase();
      database = 'up';
    } catch (err) {
      // Logged, not rethrown: the health endpoint must answer even when the
      // dependency it reports on is broken. Throwing would hand this to the
      // global error handler and return a generic 500, losing the detail that
      // makes the check useful.
      request.log.error({ err }, 'Health check: database unreachable');
    }

    const payload: HealthPayload = {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      uptime_seconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };

    // 503 when degraded so Railway's healthcheck actually fails instead of
    // treating a database-less instance as a good deploy. It is the one status
    // outside the challenge's list, and it is deliberate — the challenge's list
    // governs /patients, not the platform's liveness probe.
    //
    // `fail()`, not a hand-built object: there is one envelope construction
    // site, and the caught error never reaches the body.
    if (database === 'down') {
      return reply.code(503).send(fail(ERROR_CODES.INTERNAL_ERROR, 'Database unreachable'));
    }

    return reply.code(200).send(ok(payload));
  });
}
