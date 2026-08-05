// Real DB-down path for the two appointment tools: the service throws and the
// handlers must still answer HTTP 200 with the canned INFRA_SPEECH message.
//
// Own file, for the reason given in tool.infra-failure.test.ts: `vi.mock` is
// hoisted per module graph and would poison the live tool.appointments suite if
// it lived there.
//
// The last case is the one that matters most — an outage and an unknown patient
// take DIFFERENT branches out of the same `catch`, and inverting them either
// speaks the outage line at a caller who simply gave a stale id, or leaves a
// genuinely broken backend silent while the model improvises.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { NotFoundError } from '../../src/lib/errors.js';

vi.mock('../../src/services/appointment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/appointment.js')>();
  return {
    ...actual,
    bookAppointment: vi.fn().mockRejectedValue(new Error('db down — book')),
  };
});

vi.mock('../../src/services/patient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/patient.js')>();
  return {
    ...actual,
    getPatientById: vi.fn().mockRejectedValue(new Error('db down — read patient')),
  };
});

const appointmentService = await import('../../src/services/appointment.js');
const patientService = await import('../../src/services/patient.js');
const availabilityService = await import('../../src/services/availability.js');
const { api, startTestApp } = await import('../helpers.js');

// Must match INFRA_SPEECH in src/vapi/tools.ts — duplicated here on purpose
// rather than exporting the constant from production.
const INFRA_SPEECH =
  "I'm sorry — I've got all your details but our system isn't saving them right now. Let me try once more.";

const PATIENT_ID = '9f1c2b3a-4d5e-4f70-8192-a3b4c5d6e7f8';

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
  vi.mocked(appointmentService.bookAppointment).mockRejectedValue(new Error('db down — book'));
  vi.mocked(patientService.getPatientById).mockRejectedValue(new Error('db down — read patient'));
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

/** A slot that is genuinely open right now — the real, unmocked availability query. */
async function bookableSlotId(): Promise<string> {
  const availability = await availabilityService.findAvailability({
    now: new Date(),
    preference: { kind: 'any' },
  });
  return availability.alternatives[0]?.slotId ?? '';
}

describe('POST /vapi/tool — appointment infrastructure failures', () => {
  it('get_appointment_slots patient read throws → 200, error text, INFRA_SPEECH message', async () => {
    const { status, results } = await postTool(
      specShape('tc-appt-infra-slots', 'get_appointment_slots', { patient_id: PATIENT_ID }),
    );

    expect(status).toBe(200);
    expect(results[0]?.error).toMatch(/unavailable/i);
    expect(results[0]?.message).toEqual({ type: 'request-failed', content: INFRA_SPEECH });
  });

  it('book_appointment write throws → 200, error text, INFRA_SPEECH message', async () => {
    const { status, results } = await postTool(
      specShape('tc-appt-infra-book', 'book_appointment', {
        patient_id: PATIENT_ID,
        slot_id: await bookableSlotId(),
      }),
    );

    expect(status).toBe(200);
    expect(results[0]?.error).toMatch(/unavailable|could not be booked/i);
    expect(results[0]?.message).toEqual({ type: 'request-failed', content: INFRA_SPEECH });
  });

  it('bookAppointment throwing NotFoundError → field failure, NO request-failed message', async () => {
    vi.mocked(appointmentService.bookAppointment).mockRejectedValueOnce(
      new NotFoundError('No patient found with that id.'),
    );

    const { status, results } = await postTool(
      specShape('tc-appt-infra-notfound', 'book_appointment', {
        patient_id: PATIENT_ID,
        slot_id: await bookableSlotId(),
      }),
    );

    expect(status).toBe(200);
    expect(results[0]?.error).toContain('No patient exists with that patient_id');
    expect(results[0]?.message).toBeUndefined();
  });

  it('get_appointment_slots NotFoundError → field failure, NO request-failed message', async () => {
    vi.mocked(patientService.getPatientById).mockRejectedValueOnce(
      new NotFoundError('No patient found with that id.'),
    );

    const { results } = await postTool(
      specShape('tc-appt-infra-slots-notfound', 'get_appointment_slots', { patient_id: PATIENT_ID }),
    );

    expect(results[0]?.error).toContain('No patient exists with that patient_id');
    expect(results[0]?.message).toBeUndefined();
  });
});
