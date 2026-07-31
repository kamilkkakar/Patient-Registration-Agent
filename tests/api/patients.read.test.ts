// GET /patients (list + each query filter) and GET /patients/:id.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  api,
  assertEnvelope,
  purgeTestPatients,
  startTestApp,
  testLastName,
  validPayload,
} from '../helpers.js';

let app: FastifyInstance;

const ALPHA_LAST_NAME = testLastName('Filteralpha');
const BETA_LAST_NAME = testLastName('Filterbeta');

let alphaId = '';
let betaId = '';

beforeAll(async () => {
  await purgeTestPatients();
  app = await startTestApp();

  const alpha = await api(app)
    .post('/patients')
    .send(
      validPayload({
        first_name: 'Alpha',
        last_name: ALPHA_LAST_NAME,
        date_of_birth: '03/09/1985',
        phone_number: '5125550101',
      }),
    );
  alphaId = String((alpha.body.data as Record<string, unknown>)['patient_id']);

  const beta = await api(app)
    .post('/patients')
    .send(
      validPayload({
        first_name: 'Beta',
        last_name: BETA_LAST_NAME,
        date_of_birth: '11/22/1990',
        phone_number: '2125550102',
      }),
    );
  betaId = String((beta.body.data as Record<string, unknown>)['patient_id']);
});

afterAll(async () => {
  await app.close();
  await purgeTestPatients();
});

describe('GET /patients', () => {
  it('lists patients in the envelope', async () => {
    const res = await api(app).get('/patients');

    expect(res.status).toBe(200);
    assertEnvelope(res.body);
    expect(res.body.error).toBeNull();
    expect(Array.isArray(res.body.data)).toBe(true);

    const ids = (res.body.data as Array<Record<string, unknown>>).map((p) => p['patient_id']);
    expect(ids).toContain(alphaId);
    expect(ids).toContain(betaId);
  });

  it('filters by last_name, case-insensitively and exactly', async () => {
    const res = await api(app).get('/patients').query({ last_name: ALPHA_LAST_NAME.toLowerCase() });

    expect(res.status).toBe(200);
    const rows = res.body.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['patient_id']).toBe(alphaId);
  });

  it('filters by date_of_birth in MM/DD/YYYY', async () => {
    const res = await api(app).get('/patients').query({ date_of_birth: '11/22/1990' });

    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<Record<string, unknown>>).map((p) => p['patient_id']);
    expect(ids).toContain(betaId);
    expect(ids).not.toContain(alphaId);
  });

  it('accepts the ISO date form for date_of_birth too', async () => {
    const res = await api(app).get('/patients').query({ date_of_birth: '1990-11-22' });

    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<Record<string, unknown>>).map((p) => p['patient_id']);
    expect(ids).toContain(betaId);
  });

  it('filters by phone_number, tolerating punctuation and a country code', async () => {
    const res = await api(app).get('/patients').query({ phone_number: '+1 (512) 555-0101' });

    expect(res.status).toBe(200);
    const rows = res.body.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['patient_id']).toBe(alphaId);
  });

  it('combines filters with AND', async () => {
    const res = await api(app)
      .get('/patients')
      .query({ last_name: ALPHA_LAST_NAME, date_of_birth: '11/22/1990' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns 200 with an empty array when nothing matches, never 404', async () => {
    const res = await api(app).get('/patients').query({ last_name: testLastName('Nobodyhere') });

    expect(res.status).toBe(200);
    assertEnvelope(res.body);
    expect(res.body.data).toEqual([]);
    expect(res.body.error).toBeNull();
  });

  it('ignores unrecognized query params rather than rejecting them', async () => {
    const res = await api(app).get('/patients').query({ foo: '1', last_name: ALPHA_LAST_NAME });

    expect(res.status).toBe(200);
    expect((res.body.data as unknown[]).length).toBe(1);
  });

  it('returns 400 for an unparseable date_of_birth', async () => {
    const res = await api(app).get('/patients').query({ date_of_birth: 'hello' });

    expect(res.status).toBe(400);
    assertEnvelope(res.body);
    expect(res.body.data).toBeNull();
    expect((res.body.error as { code: string }).code).toBe('BAD_REQUEST');
    expect((res.body.error as { details: unknown }).details).toBeNull();
  });

  it('returns 400 when phone_number does not normalize to 10 digits', async () => {
    const res = await api(app).get('/patients').query({ phone_number: '555' });

    expect(res.status).toBe(400);
    expect((res.body.error as { code: string }).code).toBe('BAD_REQUEST');
  });

  it('orders by created_at descending', async () => {
    const res = await api(app).get('/patients');
    const rows = res.body.data as Array<Record<string, string>>;

    const timestamps = rows.map((r) => Date.parse(String(r['created_at'])));
    const sorted = [...timestamps].sort((a, b) => b - a);
    expect(timestamps).toEqual(sorted);
  });
});

describe('GET /patients/:id', () => {
  it('returns 200 and the record for a live patient', async () => {
    const res = await api(app).get(`/patients/${alphaId}`);

    expect(res.status).toBe(200);
    assertEnvelope(res.body);
    expect(res.body.error).toBeNull();
    expect((res.body.data as Record<string, unknown>)['patient_id']).toBe(alphaId);
    expect((res.body.data as Record<string, unknown>)['date_of_birth']).toBe('03/09/1985');
  });

  it('returns 404 for a well-formed but unknown UUID', async () => {
    const res = await api(app).get('/patients/3fa85f64-5717-4562-b3fc-2c963f66afa6');

    expect(res.status).toBe(404);
    assertEnvelope(res.body);
    expect(res.body.data).toBeNull();
    expect((res.body.error as { code: string }).code).toBe('NOT_FOUND');
    expect((res.body.error as { details: unknown }).details).toBeNull();
  });

  it('returns 400 for a malformed UUID — not 404', async () => {
    const res = await api(app).get('/patients/not-a-uuid');

    expect(res.status).toBe(400);
    assertEnvelope(res.body);
    expect(res.body.data).toBeNull();
    expect((res.body.error as { code: string }).code).toBe('BAD_REQUEST');
    expect((res.body.error as { message: string }).message).toMatch(/UUID/i);
  });
});
