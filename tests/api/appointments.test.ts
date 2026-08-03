// GET /appointments — the whole appointment book (bonus: scheduling).
//
// This endpoint exists for the dashboard: it is what lets a reviewer see that a
// phone booking landed without running curl against a patient id they do not
// have yet. So the contract under test is "every LIVE patient's appointments,
// soonest first".
//
// The soft-delete rule is the one that would break silently. `GET /patients` and
// `GET /patients/:id/appointments` both hide a tombstoned patient, but this
// query reaches appointments through the relation rather than through a patient
// id — nothing about it 404s, so a missing `patient: { deletedAt: null }` filter
// would republish a deleted patient's schedule with no visible error anywhere.
//
// Assertions are by MEMBERSHIP, never by list length: the response is global, so
// seed data and other suites' fixtures are legitimately in it.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { NotFoundError, ValidationError } from '../../src/lib/errors.js';
import {
  bookAppointment,
  cancelAppointment,
  listUpcomingAppointmentsForPatient,
  rescheduleAppointment,
} from '../../src/services/appointment.js';
import {
  api,
  assertEnvelope,
  prisma,
  purgeTestPatients,
  startTestApp,
  TEST_LAST_NAME_PREFIX,
  testLastName,
  validPayload,
} from '../helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  // Appointments are ON DELETE CASCADE, so purging the patients takes them too.
  await purgeTestPatients();
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
  await purgeTestPatients();
});

// Most tests here pin `2026-08-03T09:00:00.000Z` (and neighbouring fixed dates)
// directly via `prisma.appointment.create`, and no test depends on a booking
// made by an earlier one — each creates its own patient. The partial unique
// index added for double-booking now enforces one live appointment per
// instant, so a row a previous test left SCHEDULED on that date would block
// the next test's identical fixture. Clearing between tests avoids that
// collision without touching the fixed dates the assertions read back.
afterEach(async () => {
  await prisma.appointment.deleteMany({
    where: { patient: { lastName: { startsWith: TEST_LAST_NAME_PREFIX } } },
  });
});

async function createPatient(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await api(app).post('/patients').send(validPayload(overrides));
  expect(res.status).toBe(201);
  return String((res.body.data as Record<string, unknown>)['patient_id']);
}

async function listAppointments(): Promise<Record<string, unknown>[]> {
  const res = await api(app).get('/appointments');

  expect(res.status).toBe(200);
  assertEnvelope(res.body);
  expect(res.body.error).toBeNull();

  return res.body.data as Record<string, unknown>[];
}

describe('GET /appointments', () => {
  it('returns a booked appointment in the envelope, carrying its patient_id', async () => {
    // `patient_id` is what the dashboard groups on — without it the flat list
    // cannot be attributed to a row.
    const patientId = await createPatient({ last_name: testLastName('Allapptsbooked') });
    const booked = await bookAppointment({
      patientId,
      scheduledFor: new Date('2026-08-10T09:00:00.000Z'),
    });

    const rows = await listAppointments();
    const mine = rows.find((row) => row['id'] === booked.id);

    expect(mine).toEqual({
      id: booked.id,
      patient_id: patientId,
      scheduled_for: '2026-08-10T09:00:00.000Z',
      // Explicitly null, not absent: the dashboard branches on it to decide
      // whether to say a booking was moved, and an omitted key would read the
      // same as "never moved" only by accident.
      rescheduled_from: null,
      status: 'SCHEDULED',
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
  });

  it('omits the appointments of a SOFT-DELETED patient, without deleting them', async () => {
    // A tombstoned record is invisible on every read path. This list is not
    // addressed by patient id, so there is no 404 to hide behind: the row must
    // simply not be published — while staying in the table, because a soft
    // delete hides rows, it does not remove them.
    const patientId = await createPatient({ last_name: testLastName('Allapptsdeleted') });
    const booked = await bookAppointment({
      patientId,
      scheduledFor: new Date('2026-08-11T09:00:00.000Z'),
    });

    expect((await listAppointments()).some((row) => row['id'] === booked.id)).toBe(true);

    expect((await api(app).delete(`/patients/${patientId}`)).status).toBe(200);

    const rows = await listAppointments();
    expect(rows.some((row) => row['id'] === booked.id)).toBe(false);
    expect(rows.some((row) => row['patient_id'] === patientId)).toBe(false);

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: booked.id } });
    expect(row.patientId).toBe(patientId);
  });

  it('orders the whole list ascending by scheduled_for', async () => {
    // The dashboard takes the FIRST appointment after now as "next", so the
    // column is wrong for every patient if this order is not ascending.
    const patientId = await createPatient({ last_name: testLastName('Allapptsorder') });

    // Booked out of order, so a pass would have to come from the ORDER BY.
    const later = await bookAppointment({
      patientId,
      scheduledFor: new Date('2026-09-14T09:00:00.000Z'),
    });
    const sooner = await bookAppointment({
      patientId,
      scheduledFor: new Date('2026-09-11T09:00:00.000Z'),
    });

    const rows = await listAppointments();

    // Every timestamp is fixed-width ISO 8601 UTC, so a lexicographic sort is a
    // chronological one — the same equivalence the dashboard column relies on.
    const times = rows.map((row) => String(row['scheduled_for']));
    expect(times).toEqual(times.slice().sort());

    const soonerAt = rows.findIndex((row) => row['id'] === sooner.id);
    const laterAt = rows.findIndex((row) => row['id'] === later.id);
    expect(soonerAt).toBeGreaterThanOrEqual(0);
    expect(soonerAt).toBeLessThan(laterAt);
  });
});

// ---------------------------------------------------------------------------
// listUpcomingAppointmentsForPatient — what Nora reads back to a returning caller
// ---------------------------------------------------------------------------

describe('listUpcomingAppointmentsForPatient', () => {
  const NOW = new Date('2026-08-01T00:00:00.000Z');

  it('returns only future, non-cancelled appointments, soonest first', async () => {
    // WHY: this feeds what Nora reads aloud and the appointment_id she is handed
    // to change. A cancelled or already-passed booking offered back as "your
    // appointment" is a wrong answer, not a cosmetic one.
    const patientId = await createPatient({ last_name: testLastName('Upcomingmix') });

    const past = await prisma.appointment.create({
      data: { patientId, scheduledFor: new Date('2026-07-20T09:00:00.000Z') },
    });
    const cancelled = await prisma.appointment.create({
      data: { patientId, scheduledFor: new Date('2026-08-05T09:00:00.000Z'), status: 'CANCELLED' },
    });
    const later = await prisma.appointment.create({
      data: { patientId, scheduledFor: new Date('2026-08-10T09:00:00.000Z') },
    });
    const sooner = await prisma.appointment.create({
      data: { patientId, scheduledFor: new Date('2026-08-03T09:00:00.000Z') },
    });

    const rows = await listUpcomingAppointmentsForPatient(patientId, NOW);

    expect(rows.map((row) => row.id)).toEqual([sooner.id, later.id]);
    expect(rows.some((row) => row.id === past.id)).toBe(false);
    expect(rows.some((row) => row.id === cancelled.id)).toBe(false);
  });

  it('counts CONFIRMED as upcoming, not just SCHEDULED', async () => {
    // WHY: the filter is a WHITELIST of live statuses. Writing it as "not
    // CANCELLED" would have been equivalent today and wrong the moment a
    // confirmation step exists.
    const patientId = await createPatient({ last_name: testLastName('Upcomingconfirmed') });
    const confirmed = await prisma.appointment.create({
      data: { patientId, scheduledFor: new Date('2026-08-04T09:00:00.000Z'), status: 'CONFIRMED' },
    });

    const rows = await listUpcomingAppointmentsForPatient(patientId, NOW);

    expect(rows.map((row) => row.id)).toEqual([confirmed.id]);
  });

  it('throws for a soft-deleted patient rather than listing their appointments', async () => {
    // WHY: soft-delete is invisible on every read path. A tombstoned patient must
    // not become reachable through the appointment side door.
    const patientId = await createPatient({ last_name: testLastName('Upcomingdeleted') });
    await prisma.appointment.create({
      data: { patientId, scheduledFor: new Date('2026-09-01T09:00:00.000Z') },
    });
    expect((await api(app).delete(`/patients/${patientId}`)).status).toBe(200);

    await expect(listUpcomingAppointmentsForPatient(patientId, NOW)).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// rescheduleAppointment — move an existing booking in place
// ---------------------------------------------------------------------------

describe('rescheduleAppointment', () => {
  const NOW = new Date('2026-08-01T00:00:00.000Z');

  it('moves scheduled_for but never created_at, and keeps the row SCHEDULED', async () => {
    // WHY: created_at is WHEN THE CALLER BOOKED; scheduled_for is THE
    // APPOINTMENT. They are different facts and rescheduling changes only the
    // second. Overwriting created_at would lose when the caller actually rang in.
    const patientId = await createPatient({ last_name: testLastName('Reschedmove') });
    const original = await prisma.appointment.create({
      data: { patientId, scheduledFor: new Date('2026-08-03T09:00:00.000Z') },
    });

    const moved = await rescheduleAppointment({
      appointmentId: original.id,
      patientId,
      scheduledFor: new Date('2026-08-05T09:00:00.000Z'),
      now: NOW,
    });

    expect(moved.id).toBe(original.id);
    expect(moved.scheduledFor.toISOString()).toBe('2026-08-05T09:00:00.000Z');
    expect(moved.createdAt.toISOString()).toBe(original.createdAt.toISOString());
    expect(moved.status).toBe('SCHEDULED');
  });

  it("refuses another patient's appointment the same way it refuses a missing one", async () => {
    // WHY: this is the security property, not a nicety. Distinguishing "not
    // yours" from "no such row" would let a caller probe whether an arbitrary
    // appointment id exists. Appointment ids reach us from a model on a phone
    // call, so the scope has to be enforced in the query.
    const mine = await createPatient({ last_name: testLastName('Reschedmine') });
    const theirs = await createPatient({ last_name: testLastName('Reschedtheirs') });
    const theirAppointment = await prisma.appointment.create({
      data: { patientId: theirs, scheduledFor: new Date('2026-08-03T09:00:00.000Z') },
    });

    await expect(
      rescheduleAppointment({
        appointmentId: theirAppointment.id,
        patientId: mine,
        scheduledFor: new Date('2026-08-05T09:00:00.000Z'),
        now: NOW,
      }),
    ).rejects.toThrow(NotFoundError);

    await expect(
      rescheduleAppointment({
        appointmentId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        patientId: mine,
        scheduledFor: new Date('2026-08-05T09:00:00.000Z'),
        now: NOW,
      }),
    ).rejects.toThrow(NotFoundError);

    const untouched = await prisma.appointment.findUniqueOrThrow({
      where: { id: theirAppointment.id },
    });
    expect(untouched.scheduledFor.toISOString()).toBe('2026-08-03T09:00:00.000Z');
  });

  it('refuses a cancelled appointment', async () => {
    // WHY: a cancelled booking is finished. Moving its date would resurrect a
    // slot the caller already gave up.
    const patientId = await createPatient({ last_name: testLastName('Reschedcancelled') });
    const cancelled = await prisma.appointment.create({
      data: { patientId, scheduledFor: new Date('2026-08-03T09:00:00.000Z'), status: 'CANCELLED' },
    });

    await expect(
      rescheduleAppointment({
        appointmentId: cancelled.id,
        patientId,
        scheduledFor: new Date('2026-08-05T09:00:00.000Z'),
        now: NOW,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses an appointment that has already passed', async () => {
    // WHY: you cannot move yesterday.
    const patientId = await createPatient({ last_name: testLastName('Reschedpast') });
    const past = await prisma.appointment.create({
      data: { patientId, scheduledFor: new Date('2026-07-20T09:00:00.000Z') },
    });

    await expect(
      rescheduleAppointment({
        appointmentId: past.id,
        patientId,
        scheduledFor: new Date('2026-08-05T09:00:00.000Z'),
        now: NOW,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('accepts rescheduling to the slot already held', async () => {
    // WHY: a caller confirming the time they already have has not made a
    // mistake. Erroring here would produce a confusing re-prompt for a harmless
    // request.
    const patientId = await createPatient({ last_name: testLastName('Reschedsame') });
    const existing = await prisma.appointment.create({
      data: { patientId, scheduledFor: new Date('2026-08-03T09:00:00.000Z') },
    });

    const same = await rescheduleAppointment({
      appointmentId: existing.id,
      patientId,
      scheduledFor: new Date('2026-08-03T09:00:00.000Z'),
      now: NOW,
    });

    expect(same.scheduledFor.toISOString()).toBe('2026-08-03T09:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// cancelAppointment — status change, never a deletion
// ---------------------------------------------------------------------------

describe('cancelAppointment', () => {
  const NOW = new Date('2026-08-01T00:00:00.000Z');

  it('sets CANCELLED and leaves scheduled_for and created_at intact', async () => {
    // WHY: the row is kept so the record still shows a booking was made and
    // given up. Blanking scheduled_for would lose WHICH slot was released, which
    // is the only thing that makes a cancellation legible after the fact.
    const patientId = await createPatient({ last_name: testLastName('Cancelkeep') });
    const booked = await prisma.appointment.create({
      data: { patientId, scheduledFor: new Date('2026-08-03T09:00:00.000Z') },
    });

    const cancelled = await cancelAppointment({ appointmentId: booked.id, patientId, now: NOW });

    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.scheduledFor.toISOString()).toBe('2026-08-03T09:00:00.000Z');
    expect(cancelled.createdAt.toISOString()).toBe(booked.createdAt.toISOString());

    expect(await prisma.appointment.findUnique({ where: { id: booked.id } })).not.toBeNull();
  });

  it('refuses to cancel the same appointment twice', async () => {
    // WHY: a second cancel means the model lost track of state. Succeeding
    // silently would hide that from the caller and from the logs.
    const patientId = await createPatient({ last_name: testLastName('Canceltwice') });
    const booked = await prisma.appointment.create({
      data: { patientId, scheduledFor: new Date('2026-08-03T09:00:00.000Z') },
    });

    await cancelAppointment({ appointmentId: booked.id, patientId, now: NOW });

    await expect(
      cancelAppointment({ appointmentId: booked.id, patientId, now: NOW }),
    ).rejects.toThrow(ValidationError);
  });

  it("refuses another patient's appointment", async () => {
    // WHY: same security property as reschedule. A guessed id must not cancel a
    // stranger's booking.
    const mine = await createPatient({ last_name: testLastName('Cancelmine') });
    const theirs = await createPatient({ last_name: testLastName('Canceltheirs') });
    const theirAppointment = await prisma.appointment.create({
      data: { patientId: theirs, scheduledFor: new Date('2026-08-03T09:00:00.000Z') },
    });

    await expect(
      cancelAppointment({ appointmentId: theirAppointment.id, patientId: mine, now: NOW }),
    ).rejects.toThrow(NotFoundError);

    const untouched = await prisma.appointment.findUniqueOrThrow({
      where: { id: theirAppointment.id },
    });
    expect(untouched.status).toBe('SCHEDULED');
  });

  it('leaves a cancelled appointment visible in GET /appointments', async () => {
    // WHY: DELIBERATE, and it needs a test precisely because it requires NO code
    // change. `listAllAppointments` filters on the patient's deleted_at and
    // nothing else. Adding a status filter there would look like a tidy-up and
    // would quietly destroy the reason for keeping the row at all — a reviewer
    // could no longer see that a booking was made and then cancelled.
    const patientId = await createPatient({ last_name: testLastName('Cancelvisible') });
    const booked = await prisma.appointment.create({
      data: { patientId, scheduledFor: new Date('2026-08-03T09:00:00.000Z') },
    });

    await cancelAppointment({ appointmentId: booked.id, patientId, now: NOW });

    const rows = await listAppointments();
    const mine = rows.find((row) => row['id'] === booked.id);

    expect(mine).toBeDefined();
    expect(mine?.['status']).toBe('CANCELLED');
  });
});

describe('rescheduleAppointment records where it moved from', () => {
  const NOW = new Date('2026-08-01T00:00:00.000Z');

  it('stamps rescheduled_from with the time it was moved away from', async () => {
    // WHY: rescheduling updates scheduled_for IN PLACE, so without this the row
    // afterwards is indistinguishable from one booked at the new time — there is
    // no way for the dashboard to say a booking was moved rather than made.
    const patientId = await createPatient({ last_name: testLastName('Reschedfrom') });
    const booked = await prisma.appointment.create({
      data: { patientId, scheduledFor: new Date('2026-08-03T09:00:00.000Z') },
    });
    expect(booked.rescheduledFrom).toBeNull();

    const moved = await rescheduleAppointment({
      appointmentId: booked.id,
      patientId,
      scheduledFor: new Date('2026-08-05T09:00:00.000Z'),
      now: NOW,
    });

    expect(moved.scheduledFor.toISOString()).toBe('2026-08-05T09:00:00.000Z');
    expect(moved.rescheduledFrom?.toISOString()).toBe('2026-08-03T09:00:00.000Z');
  });

  it('keeps the IMMEDIATELY previous time when moved twice', async () => {
    // WHY: documents the deliberate limit. The column holds one hop, not a
    // history — a second move overwrites the first. Pinning it stops someone
    // later reading it as "originally booked for".
    const patientId = await createPatient({ last_name: testLastName('Reschedtwice') });
    const booked = await prisma.appointment.create({
      data: { patientId, scheduledFor: new Date('2026-08-03T09:00:00.000Z') },
    });

    await rescheduleAppointment({
      appointmentId: booked.id, patientId,
      scheduledFor: new Date('2026-08-05T09:00:00.000Z'), now: NOW,
    });
    const second = await rescheduleAppointment({
      appointmentId: booked.id, patientId,
      scheduledFor: new Date('2026-08-07T09:00:00.000Z'), now: NOW,
    });

    expect(second.scheduledFor.toISOString()).toBe('2026-08-07T09:00:00.000Z');
    expect(second.rescheduledFrom?.toISOString()).toBe('2026-08-05T09:00:00.000Z');
  });

  it('leaves rescheduled_from alone when an appointment is cancelled', async () => {
    // WHY: cancelling is not moving. A cancelled booking that was never
    // rescheduled must not claim it was.
    const patientId = await createPatient({ last_name: testLastName('Cancelnofrom') });
    const booked = await prisma.appointment.create({
      data: { patientId, scheduledFor: new Date('2026-08-03T09:00:00.000Z') },
    });

    const cancelled = await cancelAppointment({ appointmentId: booked.id, patientId, now: NOW });

    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.rescheduledFrom).toBeNull();
  });

  it('exposes rescheduled_from over GET /appointments', async () => {
    const patientId = await createPatient({ last_name: testLastName('Reschedwire') });
    const booked = await prisma.appointment.create({
      data: { patientId, scheduledFor: new Date('2026-08-03T09:00:00.000Z') },
    });
    await rescheduleAppointment({
      appointmentId: booked.id, patientId,
      scheduledFor: new Date('2026-08-05T09:00:00.000Z'), now: NOW,
    });

    const rows = await listAppointments();
    const mine = rows.find((row) => row['id'] === booked.id);

    expect(mine?.['rescheduled_from']).toBe('2026-08-03T09:00:00.000Z');
    expect(mine?.['scheduled_for']).toBe('2026-08-05T09:00:00.000Z');
  });
});
