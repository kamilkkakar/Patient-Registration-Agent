// get_appointment_slots / book_appointment over POST /vapi/tool (bonus).
//
// The error-return contract (prompts/intake-coordinator.md § 2.7) is what most
// of this file is about: an unbookable slot or an unknown patient is a FIELD
// failure, so it must carry a bare `error` and NO inline `request-failed`
// message. An inline message wins Vapi's speech precedence and would make the
// per-field re-prompt unreachable — the caller would hear "our system isn't
// saving them right now" when all that happened is they picked a stale time.
// Every case below asserts the ABSENCE of that message explicitly.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  api,
  prisma,
  purgeTestPatients,
  startTestApp,
  TEST_LAST_NAME_PREFIX,
  testLastName,
  validPayload,
} from '../helpers.js';

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

// `get_appointment_slots` reads the real clock (no `now` injection at the tool
// layer), so every test in this file is offered the SAME three real-world
// instants. The partial unique index added in this task now enforces one live
// appointment per instant, so a booking left SCHEDULED by one test would block
// every later test that books the same offered slot — a fixture collision, not
// a real double-booking. No test here depends on another's booking surviving,
// so clearing appointments between tests is safe.
afterEach(async () => {
  await prisma.appointment.deleteMany({
    where: { patient: { lastName: { startsWith: TEST_LAST_NAME_PREFIX } } },
  });
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
 * Take the offered ids from the tool's OWN response rather than querying
 * availability again: the offered set is derived from live bookings and `now`,
 * and a second, independent read could disagree with the first.
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
    // Spoken form, so the model can read the options out without inventing
    // them. Pinned to "9 AM" year-round: the mock catalogue builds its slot at
    // clinic-local 9 AM (zonedWallTimeToUtc), not a fixed UTC hour, so this
    // holds regardless of DST.
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
    // Same "pinned to 9 AM year-round" reasoning as get_appointment_slots above.
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

// ---------------------------------------------------------------------------
// lookup_patient_by_phone — carries the caller's upcoming bookings
// ---------------------------------------------------------------------------
//
// Discovery lives on the lookup because the agent already calls it at the start
// of every call. Without the appointment_id here, reschedule and cancel are
// unreachable without a second round trip the caller hears as a pause.
//
// Every patient here needs a UNIQUE phone: validPayload's default number is
// shared by the whole suite, and appointments are only read for an unambiguous
// single match.

/** Create a patient on a phone number nothing else in the suite uses. */
async function createPatientOnPhone(suffix: string, phone: string): Promise<string> {
  const res = await api(app)
    .post('/patients')
    .send(validPayload({ last_name: testLastName(suffix), phone_number: phone }));
  expect(res.status).toBe(201);
  return String((res.body.data as Record<string, unknown>)['patient_id']);
}

async function lookup(id: string, phone: string): Promise<ToolResult> {
  const { results } = await postTool(specShape(id, 'lookup_patient_by_phone', { phone_number: phone }));
  return results[0]!;
}

describe('slots come from real availability', () => {
  it('stops offering a time once it is booked', async () => {
    // WHY: the old fixed mock catalogue never read the database, so the same
    // three times were offered no matter what was already taken.
    const patientId = await createPatient('Realavail');
    const { slotIds } = await offerSlots('ra1', patientId);
    const first = slotIds[0]!;

    await postTool(specShape('ra1-book', 'book_appointment', { patient_id: patientId, slot_id: first }));

    const again = await offerSlots('ra1-again', patientId);
    expect(again.slotIds).not.toContain(first);
  });

  it('refuses a booked slot as a FIELD failure, not an outage', async () => {
    // WHY: losing a race is ordinary conversation, not a broken system. An
    // inline request-failed would have Nora apologise for the wrong thing.
    const a = await createPatient('Raceone');
    const b = await createPatient('Racetwo');
    const { slotIds } = await offerSlots('race-offer', a);
    const contested = slotIds[0]!;

    await postTool(specShape('race-a', 'book_appointment', { patient_id: a, slot_id: contested }));
    const { results } = await postTool(
      specShape('race-b', 'book_appointment', { patient_id: b, slot_id: contested }),
    );

    expect(results[0]?.error).toBeDefined();
    expect(results[0]?.message).toBeUndefined();
  });

  it('a genuine concurrent race is decided by the database, not the read-check', async () => {
    // WHY: the sequential test above (book, THEN try to book again) is refused
    // by `resolveOpenSlot`'s membership check before the second call ever
    // reaches `prisma.appointment.create` — it never proves the P2002 branch
    // added to `bookAppointment`'s catch actually fires. Firing BOTH requests
    // together (mirrors tests/api/appointments.concurrency.test.ts, which
    // proves the same race at the service layer) lets both pass the read-check
    // and reach the insert together, so the loser must be caught by P2002
    // specifically, not by the earlier `slot === null` branch.
    const a = await createPatient('Raceconflicta');
    const b = await createPatient('Raceconflictb');
    const { slotIds } = await offerSlots('race-p2002-offer', a);
    const contested = slotIds[0]!;

    const [resA, resB] = await Promise.all([
      postTool(specShape('race-p2002-a', 'book_appointment', { patient_id: a, slot_id: contested })),
      postTool(specShape('race-p2002-b', 'book_appointment', { patient_id: b, slot_id: contested })),
    ]);

    const outcomes = [resA.results[0], resB.results[0]];
    const won = outcomes.filter((o) => o?.error === undefined);
    const lost = outcomes.filter((o) => o?.error !== undefined);

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    // "taken" pins the P2002 wording specifically, distinguishing it from
    // SLOT_ID_UNKNOWN's "not one of the times currently on offer".
    expect(lost[0]?.error).toContain('taken');
    expect(lost[0]?.message).toBeUndefined();
  });
});

describe('lookup_patient_by_phone with appointments', () => {
  it('carries the appointment_id so a change needs no extra tool call', async () => {
    const phone = '5125550188';
    const patientId = await createPatientOnPhone('Lookupwithappt', phone);
    const appointmentId = await bookFirstSlot('lk1', patientId);

    const outcome = await lookup('lk1-lookup', phone);

    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toContain(appointmentId);
    expect(outcome.result).toMatch(/Upcoming/i);
  });

  it('says there are none rather than staying silent', async () => {
    // WHY: silence is ambiguous to a model. An explicit sentence stops Nora
    // inventing an appointment the caller never made.
    const phone = '5125550189';
    await createPatientOnPhone('Lookupnoappt', phone);

    const outcome = await lookup('lk2-lookup', phone);

    expect(outcome.result).toMatch(/No upcoming appointments/i);
  });

  it('omits a cancelled booking from the upcoming list', async () => {
    // WHY: the whole point of the active-status whitelist. Reading a cancelled
    // slot back as "your appointment" is a wrong answer on a live call.
    const phone = '5125550190';
    const patientId = await createPatientOnPhone('Lookupcancelled', phone);
    const appointmentId = await bookFirstSlot('lk3', patientId);

    await postTool(
      specShape('lk3-cancel', 'cancel_appointment', {
        patient_id: patientId,
        appointment_id: appointmentId,
      }),
    );

    const outcome = await lookup('lk3-lookup', phone);

    expect(outcome.result).not.toContain(appointmentId);
    expect(outcome.result).toMatch(/No upcoming appointments/i);
  });

  it('stays a single line', async () => {
    // WHY: a line break in `result` is a parse error on Vapi's side (§ G4).
    const phone = '5125550191';
    const patientId = await createPatientOnPhone('Lookuponeline', phone);
    await bookFirstSlot('lk4', patientId);

    const outcome = await lookup('lk4-lookup', phone);

    expect(outcome.result).not.toMatch(/[\r\n]/);
  });
});
