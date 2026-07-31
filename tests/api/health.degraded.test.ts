// GET /health with the database unreachable.
//
// Its own file for the same reason as errors.500.test.ts: `vi.mock` is hoisted
// per module graph, so mocking the health service here would otherwise poison
// every suite that expects a real database.
//
// The 503 is deliberate and must not be softened to a 200 — Railway's
// healthcheck has to fail loudly rather than keep routing traffic to an
// instance whose every real endpoint would 500.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { api, assertEnvelope } from '../helpers.js';

vi.mock('../../src/services/health.js', () => ({
  checkDatabase: vi
    .fn()
    .mockRejectedValue(
      new Error(
        'connect ECONNREFUSED postgresql://postgres:postgres@localhost:55432/patient_registration',
      ),
    ),
}));

let app: FastifyInstance;

beforeAll(async () => {
  const { buildApp } = await import('../../src/app.js');
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe('GET /health when the database is down', () => {
  it('answers 503 in the envelope instead of throwing', async () => {
    const res = await api(app).get('/health');

    expect(res.status).toBe(503);
    assertEnvelope(res.body);
    expect(res.body.data).toBeNull();

    const error = res.body.error as { code: string; message: string; details: unknown };
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).toBe('Database unreachable');
    expect(error.details).toBeNull();
  });

  it('does not leak the connection string', async () => {
    const res = await api(app).get('/health');
    const raw = JSON.stringify(res.body);

    expect(raw).not.toMatch(/postgresql:\/\//);
    expect(raw).not.toContain('ECONNREFUSED');
  });
});
