// The 500 branch of the global error handler.
//
// This needs its own file: `vi.mock` is hoisted per module graph, and mocking
// the service layer here would poison every other suite. The service is forced
// to throw an error whose message deliberately contains a connection string, a
// Windows file path and a stack frame — none of which may reach the client.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { api, assertEnvelope } from '../helpers.js';

// Every export the route module imports must be mocked, or the namespace member
// is undefined at call time and the failure is a TypeError, not our error.
//
// The message is built INSIDE the factory: vi.mock is hoisted above every
// top-level binding, so referencing a module-scope const here is a TDZ error.
vi.mock('../../src/services/patient.js', () => {
  const leaky = new Error(
    'connect ECONNREFUSED postgresql://postgres:postgres@localhost:55432/patient_registration ' +
      'at Object.listPatients (C:\\cursor\\patient_registration_voice_agent\\src\\services\\patient.ts:31:9)',
  );

  return {
    listPatients: vi.fn().mockRejectedValue(leaky),
    getPatientById: vi.fn().mockRejectedValue(leaky),
    createPatient: vi.fn(),
    updatePatient: vi.fn(),
    softDeletePatient: vi.fn(),
  };
});

let app: FastifyInstance;

beforeAll(async () => {
  // Imported after vi.mock is hoisted, so the app wires up the mocked service.
  const { buildApp } = await import('../../src/app.js');
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe('unhandled failures', () => {
  it('returns 500 in the envelope with the INTERNAL_ERROR code', async () => {
    const res = await api(app).get('/patients');

    expect(res.status).toBe(500);
    assertEnvelope(res.body);
    expect(res.body.data).toBeNull();

    const error = res.body.error as { code: string; message: string; details: unknown };
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.details).toBeNull();
    expect(error.message).toBe('An unexpected internal error occurred.');
  });

  it('never leaks a connection string, file path or stack frame', async () => {
    const res = await api(app).get('/patients');
    const raw = JSON.stringify(res.body);

    expect(raw).not.toMatch(/postgresql:\/\//);
    expect(raw).not.toMatch(/[A-Za-z]:\\/); // Windows path
    expect(raw).not.toMatch(/\bat\s+\w+/); // stack frame
    expect(raw).not.toContain('ECONNREFUSED');
    expect(raw).not.toContain('postgres');
  });

  it('applies the same treatment on the id-addressed route', async () => {
    const res = await api(app).get('/patients/3fa85f64-5717-4562-b3fc-2c963f66afa6');

    expect(res.status).toBe(500);
    assertEnvelope(res.body);
    expect((res.body.error as { code: string }).code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/postgresql:\/\//);
  });
});
