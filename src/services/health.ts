// Business logic for the health check.
//
// Exists so `src/routes/health.ts` does not have to import Prisma. Handoff § 7:
// services are the only layer that touches the client — "a route that imports
// Prisma is a review failure". The route was doing its own `SELECT 1`, which is
// a one-line exception that stops being one the moment a second route copies it.
//
// Errors are thrown, not swallowed: this layer does not know what an unreachable
// database means for the caller. The route decides that it means 503.

import { prisma } from '../lib/prisma.js';

/**
 * The DEEP part of the health check — a real round trip to Postgres.
 *
 * `SELECT 1` on purpose: it touches no table, so it cannot be affected by a
 * migration, an empty database or a permissions change on the patient table.
 * It proves exactly one thing, which is the thing the check is about — a
 * connection can be acquired and a statement can be executed.
 *
 * Resolves on success; throws whatever Prisma throws on failure.
 */
export async function checkDatabase(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}
