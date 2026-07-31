// Shared test fixtures. Not a test file — `tests/**/*.test.ts` is the include
// pattern, so this is never collected as a suite.

import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Every patient this suite creates carries a last name starting with this
 * prefix, so cleanup is a single deleteMany that cannot touch seed data
 * ("Sample", "Example") or anything a human created by hand. The prefix is
 * letters only, because the name validator rejects digits.
 */
export const TEST_LAST_NAME_PREFIX = 'Zzqatest';

export function testLastName(suffix: string): string {
  return `${TEST_LAST_NAME_PREFIX}${suffix}`;
}

export async function startTestApp(): Promise<FastifyInstance> {
  const app = await buildApp();
  await app.ready();
  return app;
}

/**
 * Like `startTestApp`, but actually bound to an ephemeral port.
 *
 * Needed by two kinds of test that `startTestApp` cannot serve:
 *   - concurrent requests. Supertest lazily calls `listen(0)` on any server
 *     that has no address yet; fire eight requests at once and all eight race
 *     into that call, which throws ERR_SERVER_ALREADY_LISTEN.
 *   - raw-socket requests, which need a real port to connect to.
 */
export async function listenTestApp(): Promise<FastifyInstance> {
  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  return app;
}

/** The ephemeral port a `listenTestApp()` instance is bound to. */
export function testPort(app: FastifyInstance): number {
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Test app is not bound to a TCP port.');
  }
  return address.port;
}

/** Supertest against the underlying Node server; it binds an ephemeral port. */
export function api(app: FastifyInstance): ReturnType<typeof request> {
  return request(app.server);
}

/**
 * Removes every row this suite could have created, including leftovers from a
 * previously crashed run. Called in both beforeAll and afterAll so the suite is
 * repeatable.
 */
export async function purgeTestPatients(): Promise<void> {
  await prisma.patient.deleteMany({
    where: { lastName: { startsWith: TEST_LAST_NAME_PREFIX } },
  });
}

/**
 * A minimal valid create body: required fields only.
 *
 * The phone number is deliberately NANP-valid (`512` area, `555` exchange, and
 * a line number in the reserved 555-01xx fictional range). Note that the classic
 * "555-123-4567" is NOT valid under the NANP rule the validator enforces — the
 * exchange code `123` starts with a 1.
 */
export function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    first_name: 'Jane',
    last_name: testLastName('Doe'),
    date_of_birth: '02/15/1992',
    sex: 'Female',
    phone_number: '(512) 555-0142',
    address_line_1: '123 Main St',
    city: 'Austin',
    state: 'TX',
    zip_code: '78701',
    ...overrides,
  };
}

/** Every response — success and error — must carry the envelope. */
export function assertEnvelope(body: unknown): asserts body is { data: unknown; error: unknown } {
  if (typeof body !== 'object' || body === null) {
    throw new Error(`Response body is not an object: ${JSON.stringify(body)}`);
  }
  if (!('data' in body) || !('error' in body)) {
    throw new Error(`Response body is missing the { data, error } envelope: ${JSON.stringify(body)}`);
  }
}

/** Timestamps are `timestamptz(3)`; a same-millisecond write compares equal. */
export function tick(ms = 15): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { prisma };
