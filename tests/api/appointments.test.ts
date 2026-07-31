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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bookAppointment } from '../../src/services/appointment.js';
import {
  api,
  assertEnvelope,
  prisma,
  purgeTestPatients,
  startTestApp,
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
