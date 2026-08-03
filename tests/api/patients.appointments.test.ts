// GET /patients/:id/appointments — the read-only view of a patient's mock
// appointments (bonus: scheduling).
//
// The 404 pair is the point of this suite, exactly as it is for transcripts: an
// unknown id and a soft-deleted one must be indistinguishable. Here the check
// lives in `listAppointmentsForPatient`, not in the route, so these tests are
// what prove the observable contract did not change when it moved.
//
// The second block covers `bookAppointment` directly: a tombstoned patient must
// not be able to acquire new appointments, which no HTTP path can exercise
// because there is no REST write endpoint for appointments.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { NotFoundError } from '../../src/lib/errors.js';
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

describe('GET /patients/:id/appointments', () => {
  it('returns the appointments in the envelope, furthest-out first', async () => {
    const patientId = await createPatient({ last_name: testLastName('Apptshappy') });

    await bookAppointment({
      patientId,
      scheduledFor: new Date('2026-08-10T09:00:00.000Z'),
    });
    await bookAppointment({
      patientId,
      scheduledFor: new Date('2026-08-12T09:00:00.000Z'),
    });

    const res = await api(app).get(`/patients/${patientId}/appointments`);

    expect(res.status).toBe(200);
    assertEnvelope(res.body);
    expect(res.body.error).toBeNull();

    const rows = res.body.data as Record<string, unknown>[];
    expect(rows).toHaveLength(2);

    // Fixed key set, storage form of the status enum, ISO 8601 UTC timestamps.
    expect(rows[0]).toEqual({
      id: expect.any(String),
      patient_id: patientId,
      scheduled_for: '2026-08-12T09:00:00.000Z',
      // Null on a booking that has never been moved. Present as a key either
      // way, so a consumer can branch on it without checking for absence.
      rescheduled_from: null,
      status: 'SCHEDULED',
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
    expect(rows[1]?.['scheduled_for']).toBe('2026-08-10T09:00:00.000Z');
  });

  it('returns an empty collection for a patient who never scheduled anything', async () => {
    const patientId = await createPatient({ last_name: testLastName('Apptsempty') });

    const res = await api(app).get(`/patients/${patientId}/appointments`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('does not leak another patient appointments', async () => {
    const mine = await createPatient({ last_name: testLastName('Apptsmine') });
    const theirs = await createPatient({ last_name: testLastName('Apptstheirs') });

    // A distinct instant from the other tests in this file: the partial unique
    // index now enforces one live appointment per instant, so two tests sharing
    // a `scheduled_for` would collide with each other, not just with a real
    // double-booking caller.
    await bookAppointment({ patientId: theirs, scheduledFor: new Date('2026-12-16T09:00:00.000Z') });

    const res = await api(app).get(`/patients/${mine}/appointments`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('404s on a well-formed but unknown patient id', async () => {
    const res = await api(app).get('/patients/9f1c2b3a-4d5e-4f70-8192-a3b4c5d6e7f8/appointments');

    expect(res.status).toBe(404);
    assertEnvelope(res.body);
    expect(res.body.data).toBeNull();
    expect((res.body.error as Record<string, unknown>)['code']).toBe('NOT_FOUND');
  });

  it('404s on a SOFT-DELETED patient, even though the appointments still exist', async () => {
    const patientId = await createPatient({ last_name: testLastName('Apptsdeleted') });
    // A distinct instant from the other tests in this file — see the note above.
    const booked = await bookAppointment({
      patientId,
      scheduledFor: new Date('2026-12-17T09:00:00.000Z'),
    });

    expect((await api(app).delete(`/patients/${patientId}`)).status).toBe(200);

    const res = await api(app).get(`/patients/${patientId}/appointments`);

    expect(res.status).toBe(404);
    expect((res.body.error as Record<string, unknown>)['code']).toBe('NOT_FOUND');

    // Soft delete never touches an appointment — the row is hidden, not gone.
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: booked.id } });
    expect(row.patientId).toBe(patientId);
  });

  it('400s on a malformed patient id — malformed is not the same as unknown', async () => {
    const res = await api(app).get('/patients/not-a-uuid/appointments');

    expect(res.status).toBe(400);
    expect((res.body.error as Record<string, unknown>)['code']).toBe('BAD_REQUEST');
  });
});

describe('bookAppointment — the soft-delete rule on the write path', () => {
  it('refuses to book a soft-deleted patient', async () => {
    // A tombstoned record is invisible on every read path; letting it acquire a
    // new appointment would create a row nobody can ever see or cancel.
    const patientId = await createPatient({ last_name: testLastName('Apptsbookdel') });
    expect((await api(app).delete(`/patients/${patientId}`)).status).toBe(200);

    await expect(
      bookAppointment({ patientId, scheduledFor: new Date('2026-08-10T09:00:00.000Z') }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(await prisma.appointment.count({ where: { patientId } })).toBe(0);
  });

  it('refuses to book a patient id that never existed', async () => {
    await expect(
      bookAppointment({
        patientId: '9f1c2b3a-4d5e-4f70-8192-a3b4c5d6e7f8',
        scheduledFor: new Date('2026-08-10T09:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
