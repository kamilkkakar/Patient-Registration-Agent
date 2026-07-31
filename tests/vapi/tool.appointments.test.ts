// get_appointment_slots / book_appointment over POST /vapi/tool (bonus).
//
// The error-return contract (prompts/intake-coordinator.md § 2.7) is what most
// of this file is about: an unbookable slot or an unknown patient is a FIELD
// failure, so it must carry a bare `error` and NO inline `request-failed`
// message. An inline message wins Vapi's speech precedence and would make the
// per-field re-prompt unreachable — the caller would hear "our system isn't
// saving them right now" when all that happened is they picked a stale time.
// Every case below asserts the ABSENCE of that message explicitly.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { api, prisma, purgeTestPatients, startTestApp, testLastName, validPayload } from '../helpers.js';

let app: FastifyInstance;

const ORIGINAL_SECRET = process.env.VAPI_WEBHOOK_SECRET;

beforeAll(async () => {
  await purgeTestPatients();
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
  await purgeTestPatients();

  if (ORIGINAL_SECRET === undefined) delete process.env.VAPI_WEBHOOK_SECRET;
  else process.env.VAPI_WEBHOOK_SECRET = ORIGINAL_SECRET;
});

beforeEach(() => {
  delete process.env.VAPI_WEBHOOK_SECRET;
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

async function createPatient(suffix: string): Promise<string> {
  const res = await api(app)
    .post('/patients')
    .send(validPayload({ last_name: testLastName(suffix) }));
  expect(res.status).toBe(201);
  return String((res.body.data as Record<string, unknown>)['patient_id']);
}

const SLOT_ID = /slot-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z/g;

/**
 * Take the offered ids from the tool's OWN response rather than calling
 * `getAvailableSlots` again: the offered set rolls over at UTC midnight, and a
 * second, independent read of the clock could disagree with the first.
 */
async function offerSlots(id: string, patientId: string): Promise<{ result: string; slotIds: string[] }> {
  const { results } = await postTool(specShape(id, 'get_appointment_slots', { patient_id: patientId }));
  const result = results[0]?.result ?? '';
  return { result, slotIds: result.match(SLOT_ID) ?? [] };
}

describe('get_appointment_slots', () => {
  it('offers exactly three slots with their ids, on one line, with no error', async () => {
    const patientId = await createPatient('Slotsok');

    const { status, results } = await postTool(
      specShape('tc-slots-ok', 'get_appointment_slots', { patient_id: patientId }),
    );

    expect(status).toBe(200);
    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.message).toBeUndefined();

    const result = results[0]?.result ?? '';
    expect(result.match(SLOT_ID)).toHaveLength(3);
    // § G4: a line break in `result` is a parse error on Vapi's side.
    expect(result).not.toMatch(/[\r\n]/);
    // Spoken form, so the model can read the options out without inventing them.
    expect(result).toMatch(/(Monday|Tuesday|Wednesday|Thursday|Friday), [A-Z][a-z]+ \d{1,2} at 9 AM/);
  });

  it('never offers a weekend — the mock catalogue is the one domain rule it can get right', async () => {
    const patientId = await createPatient('Slotsweekday');

    const { slotIds } = await offerSlots('tc-slots-weekday', patientId);

    expect(slotIds).toHaveLength(3);
    for (const slotId of slotIds) {
      const day = new Date(`${slotId.slice('slot-'.length, 'slot-'.length + 10)}T09:00:00.000Z`).getUTCDay();
      expect([1, 2, 3, 4, 5]).toContain(day);
    }
  });

  it('bad patient_id → field failure naming patient_id, no request-failed message', async () => {
    const { status, results } = await postTool(
      specShape('tc-slots-badid', 'get_appointment_slots', { patient_id: 'not-a-uuid' }),
    );

    expect(status).toBe(200);
    expect(results[0]?.error).toContain('patient_id');
    expect(results[0]?.result).toBeUndefined();
    expect(results[0]?.message).toBeUndefined();
  });

  it('unknown patient → field failure, no request-failed message', async () => {
    const { results } = await postTool(
      specShape('tc-slots-unknown', 'get_appointment_slots', {
        patient_id: '9f1c2b3a-4d5e-4f70-8192-a3b4c5d6e7f8',
      }),
    );

    expect(results[0]?.error).toContain('No patient exists with that patient_id');
    expect(results[0]?.message).toBeUndefined();
  });

  it('soft-deleted patient → field failure, no request-failed message', async () => {
    const patientId = await createPatient('Slotsdeleted');
    expect((await api(app).delete(`/patients/${patientId}`)).status).toBe(200);

    const { results } = await postTool(
      specShape('tc-slots-deleted', 'get_appointment_slots', { patient_id: patientId }),
    );

    expect(results[0]?.error).toContain('No patient exists with that patient_id');
    expect(results[0]?.message).toBeUndefined();
  });
});

describe('book_appointment', () => {
  it('books a slot the tool itself just offered and confirms it in the spoken form', async () => {
    const patientId = await createPatient('Bookok');
    const { result, slotIds } = await offerSlots('tc-book-offer', patientId);
    const slotId = slotIds[0] ?? '';

    const { status, results } = await postTool(
      specShape('tc-book-ok', 'book_appointment', { patient_id: patientId, slot_id: slotId }),
    );

    expect(status).toBe(200);
    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.message).toBeUndefined();
    expect(results[0]?.result).toMatch(/^Booked\. Appointment on .+ at 9 AM\.$/);

    // The confirmation repeats the SAME time that was offered — a booking the
    // caller was never read is worse than no booking.
    const spoken = /^Booked\. Appointment on (.+)\.$/.exec(results[0]?.result ?? '')?.[1] ?? '';
    expect(result).toContain(spoken);

    const rows = await prisma.appointment.findMany({ where: { patientId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('SCHEDULED');
    expect(`slot-${rows[0]?.scheduledFor.toISOString().slice(0, 16)}Z`).toBe(slotId);
  });

  it('well-formed slot_id that is NOT on offer → field failure, NO request-failed message', async () => {
    // The bug this pins: routing a stale slot through infraFailure would speak
    // the canned outage line and lose the re-prompt that fixes the call.
    const patientId = await createPatient('Bookstale');

    const { status, results } = await postTool(
      specShape('tc-book-stale', 'book_appointment', {
        patient_id: patientId,
        slot_id: 'slot-2020-01-06T09:00Z',
      }),
    );

    expect(status).toBe(200);
    expect(results[0]?.error).toContain('slot_id');
    expect(results[0]?.error).toContain('get_appointment_slots');
    expect(results[0]?.result).toBeUndefined();
    expect(results[0]?.message).toBeUndefined();

    expect(await prisma.appointment.count({ where: { patientId } })).toBe(0);
  });

  it('unparseable slot_id → field failure, no request-failed message', async () => {
    const patientId = await createPatient('Bookjunk');

    const { results } = await postTool(
      specShape('tc-book-junk', 'book_appointment', {
        patient_id: patientId,
        slot_id: 'tomorrow morning',
      }),
    );

    expect(results[0]?.error).toContain('slot_id');
    expect(results[0]?.message).toBeUndefined();
    expect(await prisma.appointment.count({ where: { patientId } })).toBe(0);
  });

  it('missing patient_id → field failure naming patient_id, no request-failed message', async () => {
    const { results } = await postTool(
      specShape('tc-book-noid', 'book_appointment', { slot_id: 'slot-2026-08-10T09:00Z' }),
    );

    expect(results[0]?.error).toContain('patient_id');
    expect(results[0]?.message).toBeUndefined();
  });

  it('soft-deleted patient → field failure, no booking, no request-failed message', async () => {
    const patientId = await createPatient('Bookdeleted');
    const { slotIds } = await offerSlots('tc-book-del-offer', patientId);

    expect((await api(app).delete(`/patients/${patientId}`)).status).toBe(200);

    const { status, results } = await postTool(
      specShape('tc-book-del', 'book_appointment', {
        patient_id: patientId,
        slot_id: slotIds[0] ?? '',
      }),
    );

    expect(status).toBe(200);
    expect(results[0]?.error).toContain('No patient exists with that patient_id');
    expect(results[0]?.message).toBeUndefined();
    expect(await prisma.appointment.count({ where: { patientId } })).toBe(0);
  });

  it('rejects an argument the tool does not accept, and names it', async () => {
    // `.strict()`, same as the patient tools: an invented argument is a model
    // fault worth surfacing, not something to silently drop.
    const patientId = await createPatient('Bookstrict');

    const { results } = await postTool(
      specShape('tc-book-strict', 'book_appointment', {
        patient_id: patientId,
        slot_id: 'slot-2026-08-10T09:00Z',
        notes: 'bring insurance card',
      }),
    );

    expect(results[0]?.error).toContain('notes');
    expect(results[0]?.message).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// reschedule_appointment / cancel_appointment
// ---------------------------------------------------------------------------

/** Book the first offered slot and hand back the row's id. */
async function bookFirstSlot(id: string, patientId: string): Promise<string> {
  const { slotIds } = await offerSlots(`${id}-offer`, patientId);
  const { results } = await postTool(
    specShape(`${id}-book`, 'book_appointment', { patient_id: patientId, slot_id: slotIds[0] }),
  );
  expect(results[0]?.error).toBeUndefined();

  const row = await prisma.appointment.findFirstOrThrow({ where: { patientId } });
  return row.id;
}

describe('reschedule_appointment', () => {
  it('moves the booking and speaks the new time back', async () => {
    const patientId = await createPatient('Rtoolmove');
    const appointmentId = await bookFirstSlot('rt1', patientId);
    const { slotIds } = await offerSlots('rt1-again', patientId);

    const { status, results } = await postTool(
      specShape('rt1-move', 'reschedule_appointment', {
        patient_id: patientId,
        appointment_id: appointmentId,
        slot_id: slotIds[1],
      }),
    );

    expect(status).toBe(200);
    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.result).toMatch(/Rescheduled/i);

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    expect(row.status).toBe('SCHEDULED');
  });

  it('refuses a fabricated slot_id as a FIELD failure', async () => {
    // WHY: an inline request-failed would win Vapi's speech precedence and make
    // Nora read "our system isn't responding" when the caller merely picked a
    // stale time. Asserted by ABSENCE of `message`.
    const patientId = await createPatient('Rtoolbadslot');
    const appointmentId = await bookFirstSlot('rt2', patientId);

    const { status, results } = await postTool(
      specShape('rt2-bad', 'reschedule_appointment', {
        patient_id: patientId,
        appointment_id: appointmentId,
        slot_id: 'slot-1999-01-01T09:00Z',
      }),
    );

    expect(status).toBe(200);
    expect(results[0]?.error).toBeDefined();
    expect(results[0]?.message).toBeUndefined();
  });

  it('refuses an appointment that is not on file, as a FIELD failure', async () => {
    const patientId = await createPatient('Rtoolunknown');
    const { slotIds } = await offerSlots('rt3-offer', patientId);

    const { results } = await postTool(
      specShape('rt3-move', 'reschedule_appointment', {
        patient_id: patientId,
        appointment_id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        slot_id: slotIds[0],
      }),
    );

    expect(results[0]?.error).toBeDefined();
    expect(results[0]?.message).toBeUndefined();
  });
});

describe('cancel_appointment', () => {
  it('cancels and confirms the released time', async () => {
    const patientId = await createPatient('Ctoolcancel');
    const appointmentId = await bookFirstSlot('ct1', patientId);

    const { status, results } = await postTool(
      specShape('ct1-cancel', 'cancel_appointment', {
        patient_id: patientId,
        appointment_id: appointmentId,
      }),
    );

    expect(status).toBe(200);
    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.result).toMatch(/Cancelled/i);

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    expect(row.status).toBe('CANCELLED');
  });

  it('refuses a second cancel as a FIELD failure', async () => {
    // WHY: a repeat cancel means the model lost track. The caller should hear
    // Nora say it is already cancelled, in her own words — not an outage line.
    const patientId = await createPatient('Ctooltwice');
    const appointmentId = await bookFirstSlot('ct2', patientId);

    await postTool(
      specShape('ct2-first', 'cancel_appointment', {
        patient_id: patientId,
        appointment_id: appointmentId,
      }),
    );
    const { results } = await postTool(
      specShape('ct2-second', 'cancel_appointment', {
        patient_id: patientId,
        appointment_id: appointmentId,
      }),
    );

    expect(results[0]?.error).toBeDefined();
    expect(results[0]?.message).toBeUndefined();
  });

  it('rejects a cancel payload carrying a slot_id', async () => {
    // WHY: .strict() at the tool boundary. A model that sends a slot to cancel
    // has confused the two tools.
    const patientId = await createPatient('Ctoolslot');
    const appointmentId = await bookFirstSlot('ct3', patientId);

    const { results } = await postTool(
      specShape('ct3-slot', 'cancel_appointment', {
        patient_id: patientId,
        appointment_id: appointmentId,
        slot_id: 'slot-2026-08-03T09:00Z',
      }),
    );

    expect(results[0]?.error).toBeDefined();
    expect(results[0]?.message).toBeUndefined();
  });
});
