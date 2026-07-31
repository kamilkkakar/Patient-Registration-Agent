// PUT /patients/:id (partial update) and DELETE /patients/:id (soft delete),
// including the post-conditions the handoff requires a test to assert.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  api,
  assertEnvelope,
  prisma,
  purgeTestPatients,
  startTestApp,
  testLastName,
  tick,
  validPayload,
} from '../helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  await purgeTestPatients();
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
  await purgeTestPatients();
});

async function createPatient(overrides: Record<string, unknown> = {}): Promise<Record<string, string>> {
  const res = await api(app).post('/patients').send(validPayload(overrides));
  expect(res.status).toBe(201);
  return res.body.data as Record<string, string>;
}

describe('PUT /patients/:id', () => {
  it('applies a partial update, leaves other fields untouched, and moves updated_at', async () => {
    const created = await createPatient({ last_name: testLastName('Putbasic'), city: 'Austin' });

    // timestamptz(3): without a gap, a same-millisecond write compares equal.
    await tick();

    const res = await api(app)
      .put(`/patients/${created['patient_id']}`)
      .send({ city: 'Dallas', email: 'updated@example.com' });

    expect(res.status).toBe(200);
    assertEnvelope(res.body);
    expect(res.body.error).toBeNull();

    const updated = res.body.data as Record<string, string | null>;

    expect(updated['city']).toBe('Dallas');
    expect(updated['email']).toBe('updated@example.com');
    // Absent keys are untouched, not nulled.
    expect(updated['first_name']).toBe(created['first_name']);
    expect(updated['state']).toBe(created['state']);
    expect(updated['zip_code']).toBe(created['zip_code']);

    expect(Date.parse(String(updated['updated_at']))).toBeGreaterThan(
      Date.parse(String(created['updated_at'])),
    );
    // created_at must not move.
    expect(updated['created_at']).toBe(created['created_at']);
  });

  it('clears a nullable optional field when sent an explicit null', async () => {
    const created = await createPatient({
      last_name: testLastName('Putnull'),
      email: 'clear.me@example.com',
    });
    expect(created['email']).toBe('clear.me@example.com');

    const res = await api(app).put(`/patients/${created['patient_id']}`).send({ email: null });

    expect(res.status).toBe(200);
    expect((res.body.data as Record<string, unknown>)['email']).toBeNull();
  });

  it('returns 422 for an empty JSON object', async () => {
    const created = await createPatient({ last_name: testLastName('Putempty') });

    const res = await api(app).put(`/patients/${created['patient_id']}`).send({});

    expect(res.status).toBe(422);
    assertEnvelope(res.body);
    expect(res.body.data).toBeNull();

    const error = res.body.error as { code: string; details: Array<{ message: string }> };
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details.map((d) => d.message)).toContain('At least one field must be provided.');
  });

  it('returns 422 for an invalid field value', async () => {
    const created = await createPatient({ last_name: testLastName('Putinvalid') });

    const res = await api(app).put(`/patients/${created['patient_id']}`).send({ state: 'XX' });

    expect(res.status).toBe(422);
    const details = (res.body.error as { details: Array<{ field: string }> }).details;
    expect(details.map((d) => d.field)).toContain('state');
  });

  it('returns 422 for a server-managed key', async () => {
    const created = await createPatient({ last_name: testLastName('Putmanaged') });

    const res = await api(app)
      .put(`/patients/${created['patient_id']}`)
      .send({ deleted_at: '2020-01-01T00:00:00.000Z' });

    expect(res.status).toBe(422);
    const details = (res.body.error as { details: Array<{ field: string }> }).details;
    expect(details.map((d) => d.field)).toContain('deleted_at');
  });

  it('returns 404 for a well-formed unknown UUID and 400 for a malformed one', async () => {
    const unknown = await api(app)
      .put('/patients/3fa85f64-5717-4562-b3fc-2c963f66afa6')
      .send({ city: 'Dallas' });
    expect(unknown.status).toBe(404);
    expect((unknown.body.error as { code: string }).code).toBe('NOT_FOUND');

    const malformed = await api(app).put('/patients/nope').send({ city: 'Dallas' });
    expect(malformed.status).toBe(400);
    expect((malformed.body.error as { code: string }).code).toBe('BAD_REQUEST');
  });
});

describe('DELETE /patients/:id', () => {
  it('soft-deletes: 200 with the tombstoned record, row still in the database', async () => {
    const created = await createPatient({ last_name: testLastName('Deleteme') });
    const id = String(created['patient_id']);

    await tick();

    const res = await api(app).delete(`/patients/${id}`);

    expect(res.status).toBe(200);
    assertEnvelope(res.body);
    expect(res.body.error).toBeNull();

    const tombstoned = res.body.data as Record<string, string | null>;
    expect(tombstoned['patient_id']).toBe(id);
    expect(tombstoned['deleted_at']).not.toBeNull();

    // (d) updated_at was bumped by the delete.
    expect(Date.parse(String(tombstoned['updated_at']))).toBeGreaterThan(
      Date.parse(String(created['updated_at'])),
    );
    expect(Date.parse(String(tombstoned['updated_at']))).toBeGreaterThan(
      Date.parse(String(created['created_at'])),
    );

    // (b) GET /patients/:id now 404s.
    const afterGet = await api(app).get(`/patients/${id}`);
    expect(afterGet.status).toBe(404);
    assertEnvelope(afterGet.body);
    expect((afterGet.body.error as { code: string }).code).toBe('NOT_FOUND');

    // (c) the id is gone from the collection.
    const list = await api(app).get('/patients');
    const ids = (list.body.data as Array<Record<string, unknown>>).map((p) => p['patient_id']);
    expect(ids).not.toContain(id);

    // ...including via the filters.
    const filtered = await api(app)
      .get('/patients')
      .query({ last_name: testLastName('Deleteme') });
    expect(filtered.body.data).toEqual([]);

    // (a) the row physically survives — this was NOT a hard delete.
    const row = await prisma.patient.findUnique({ where: { patientId: id } });
    expect(row).not.toBeNull();
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.firstName).toBe(created['first_name']);
  });

  it('returns 404 when deleting an already soft-deleted record', async () => {
    const created = await createPatient({ last_name: testLastName('Deletetwice') });
    const id = String(created['patient_id']);

    expect((await api(app).delete(`/patients/${id}`)).status).toBe(200);

    const second = await api(app).delete(`/patients/${id}`);
    expect(second.status).toBe(404);
    expect((second.body.error as { code: string }).code).toBe('NOT_FOUND');
  });

  it('refuses to update a soft-deleted record (404, no undelete path)', async () => {
    const created = await createPatient({ last_name: testLastName('Deletethenput') });
    const id = String(created['patient_id']);

    await api(app).delete(`/patients/${id}`);

    const res = await api(app).put(`/patients/${id}`).send({ city: 'Dallas' });
    expect(res.status).toBe(404);
    expect((res.body.error as { code: string }).code).toBe('NOT_FOUND');

    // And the deleted row was not modified by the attempt.
    const row = await prisma.patient.findUnique({ where: { patientId: id } });
    expect(row?.city).toBe('Austin');
  });

  it('returns 404 for an unknown UUID and 400 for a malformed one', async () => {
    const unknown = await api(app).delete('/patients/3fa85f64-5717-4562-b3fc-2c963f66afa6');
    expect(unknown.status).toBe(404);

    const malformed = await api(app).delete('/patients/nope');
    expect(malformed.status).toBe(400);
    assertEnvelope(malformed.body);
    expect((malformed.body.error as { code: string }).code).toBe('BAD_REQUEST');
  });
});
