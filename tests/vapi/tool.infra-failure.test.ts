// Real DB-down path: patientService throws and the tool handlers must still
// answer HTTP 200 with the canned INFRA_SPEECH inline message.
//
// Own file: `vi.mock` is hoisted per module graph and would poison the live
// tool.route suite if it lived there.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { NotFoundError } from '../../src/lib/errors.js';

vi.mock('../../src/services/patient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/patient.js')>();
  return {
    ...actual,
    createPatient: vi.fn().mockRejectedValue(new Error('db down — create')),
    listPatients: vi.fn().mockRejectedValue(new Error('db down — list')),
    updatePatient: vi.fn().mockRejectedValue(new Error('db down — update')),
  };
});

const patientService = await import('../../src/services/patient.js');
const { api, startTestApp } = await import('../helpers.js');

// Must match INFRA_SPEECH in src/vapi/tools.ts — duplicated here on purpose
// rather than exporting the constant from production.
const INFRA_SPEECH =
  "I'm sorry — I've got all your details but our system isn't saving them right now. Let me try once more.";

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
  vi.mocked(patientService.createPatient).mockRejectedValue(new Error('db down — create'));
  vi.mocked(patientService.listPatients).mockRejectedValue(new Error('db down — list'));
  vi.mocked(patientService.updatePatient).mockRejectedValue(new Error('db down — update'));
});

function specShape(id: string, name: string, args: Record<string, unknown>): unknown {
  return {
    message: {
      type: 'tool-calls',
      toolCallList: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      call: { id: `vapi-call-${id}` },
    },
  };
}

interface ToolResult {
  name: string;
  toolCallId: string;
  result?: string;
  error?: string;
  message?: { type: string; content: string };
}

async function postTool(body: unknown): Promise<{ status: number; results: ToolResult[] }> {
  const res = await api(app).post('/vapi/tool').send(body as object);
  return { status: res.status, results: (res.body as { results: ToolResult[] }).results };
}

const spokenCreate = {
  first_name: 'Sarah',
  last_name: 'ZzqatestInfra',
  date_of_birth: 'February fifteenth, ninety two',
  sex: 'Female',
  phone_number: 'nine oh two, five five five, oh two two two',
  address_line_1: '4120 Guadalupe Street',
  city: 'Austin',
  state: 'Texas',
  zip_code: 'seven eight seven oh one',
};

describe('POST /vapi/tool — patientService infrastructure failures', () => {
  it('create_patient throw → 200, error text, INFRA_SPEECH message', async () => {
    const { status, results } = await postTool(
      specShape('tc-infra-create', 'create_patient', spokenCreate),
    );

    expect(status).toBe(200);
    expect(results[0]?.error).toBeTruthy();
    expect(results[0]?.error).toMatch(/unavailable|could not be saved/i);
    expect(results[0]?.message).toEqual({ type: 'request-failed', content: INFRA_SPEECH });
  });

  it('lookup_patient_by_phone throw → 200, error text, INFRA_SPEECH message', async () => {
    const { status, results } = await postTool(
      specShape('tc-infra-lookup', 'lookup_patient_by_phone', {
        phone_number: '(512) 555-0199',
      }),
    );

    expect(status).toBe(200);
    expect(results[0]?.error).toBeTruthy();
    expect(results[0]?.error).toMatch(/unavailable|lookup failed/i);
    expect(results[0]?.message).toEqual({ type: 'request-failed', content: INFRA_SPEECH });
  });

  it('update_patient throw → 200, error text, INFRA_SPEECH message', async () => {
    const { status, results } = await postTool(
      specShape('tc-infra-update', 'update_patient', {
        patient_id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        city: 'Austin',
      }),
    );

    expect(status).toBe(200);
    expect(results[0]?.error).toBeTruthy();
    expect(results[0]?.error).toMatch(/unavailable|could not be saved/i);
    expect(results[0]?.message).toEqual({ type: 'request-failed', content: INFRA_SPEECH });
  });

  it('updatePatient throwing NotFoundError → field failure, NO request-failed message', async () => {
    vi.mocked(patientService.updatePatient).mockRejectedValueOnce(
      new NotFoundError('Patient not found.'),
    );

    const { status, results } = await postTool(
      specShape('tc-infra-notfound', 'update_patient', {
        patient_id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        city: 'Austin',
      }),
    );

    expect(status).toBe(200);
    expect(results[0]?.error).toContain('No patient exists with that patient_id');
    expect(results[0]?.message).toBeUndefined();
  });
});
