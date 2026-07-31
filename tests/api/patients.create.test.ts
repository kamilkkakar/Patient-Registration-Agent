// POST /patients — happy path, the created record shape, and every validation
// failure class named in the challenge's data-model table.

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

beforeAll(async () => {
  await purgeTestPatients();
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
  await purgeTestPatients();
});

describe('POST /patients — happy path', () => {
  it('creates a patient and returns 201 with the full record', async () => {
    const res = await api(app).post('/patients').send(validPayload({ last_name: testLastName('Happy') }));

    expect(res.status).toBe(201);
    assertEnvelope(res.body);
    expect(res.body.error).toBeNull();

    const patient = res.body.data as Record<string, unknown>;

    expect(patient['patient_id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(patient['first_name']).toBe('Jane');
    expect(patient['last_name']).toBe(testLastName('Happy'));

    // MM/DD/YYYY, not an ISO timestamp — and correct despite the non-UTC TZ
    // this suite runs under.
    expect(patient['date_of_birth']).toBe('02/15/1992');

    // Display form of the enum, and 10 bare digits for the phone.
    expect(patient['sex']).toBe('Female');
    expect(patient['phone_number']).toBe('5125550142');

    expect(patient['preferred_language']).toBe('English');
    expect(patient['deleted_at']).toBeNull();
    expect(typeof patient['created_at']).toBe('string');
    expect(patient['created_at']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // Location header points at the new resource.
    expect(res.headers['location']).toBe(`/patients/${String(patient['patient_id'])}`);
  });

  it('emits every optional field as null rather than omitting it', async () => {
    const res = await api(app).post('/patients').send(validPayload({ last_name: testLastName('Shape') }));

    expect(res.status).toBe(201);
    const patient = res.body.data as Record<string, unknown>;

    expect(Object.keys(patient).sort()).toEqual(
      [
        'address_line_1',
        'address_line_2',
        'city',
        'created_at',
        'date_of_birth',
        'deleted_at',
        'email',
        'emergency_contact_name',
        'emergency_contact_phone',
        'first_name',
        'insurance_member_id',
        'insurance_provider',
        'last_name',
        'patient_id',
        'phone_number',
        'preferred_language',
        'sex',
        'state',
        'updated_at',
        'zip_code',
      ].sort(),
    );

    expect(patient['email']).toBeNull();
    expect(patient['address_line_2']).toBeNull();
    expect(patient['insurance_provider']).toBeNull();
    expect(patient['insurance_member_id']).toBeNull();
    expect(patient['emergency_contact_name']).toBeNull();
    expect(patient['emergency_contact_phone']).toBeNull();
  });

  it('accepts the optional fields and the "decline to answer" sex form', async () => {
    const res = await api(app)
      .post('/patients')
      .send(
        validPayload({
          last_name: testLastName('Optional'),
          sex: 'decline to answer',
          email: 'jane@example.com',
          address_line_2: 'Suite 900',
          insurance_provider: 'Example Health Plan',
          insurance_member_id: 'EX123456789',
          preferred_language: 'Spanish',
          emergency_contact_name: 'John Doe',
          emergency_contact_phone: '512-555-0188',
        }),
      );

    expect(res.status).toBe(201);
    const patient = res.body.data as Record<string, unknown>;

    expect(patient['sex']).toBe('Decline to Answer');
    expect(patient['emergency_contact_phone']).toBe('5125550188');
    expect(patient['preferred_language']).toBe('Spanish');
    expect(patient['insurance_member_id']).toBe('EX123456789');
  });
});

describe('POST /patients — validation failures (422)', () => {
  const cases: Array<{ name: string; overrides: Record<string, unknown>; field: string }> = [
    {
      name: 'name containing digits',
      overrides: { first_name: 'Jane123' },
      field: 'first_name',
    },
    {
      name: 'name containing symbols',
      overrides: { last_name: testLastName('O@Brien') },
      field: 'last_name',
    },
    {
      name: 'date of birth in the future',
      overrides: { date_of_birth: '01/01/2999' },
      field: 'date_of_birth',
    },
    {
      name: 'impossible calendar date',
      overrides: { date_of_birth: '02/30/1992' },
      field: 'date_of_birth',
    },
    {
      name: 'three-digit phone number',
      overrides: { phone_number: '555' },
      field: 'phone_number',
    },
    {
      name: 'malformed email',
      overrides: { email: 'not-an-email' },
      field: 'email',
    },
    {
      name: 'invalid state abbreviation',
      overrides: { state: 'XX' },
      field: 'state',
    },
    {
      name: 'malformed ZIP code',
      overrides: { zip_code: '7870' },
      field: 'zip_code',
    },
    {
      name: 'invalid sex value',
      overrides: { sex: 'Yes' },
      field: 'sex',
    },
  ];

  for (const testCase of cases) {
    it(`rejects a ${testCase.name} with 422 naming ${testCase.field}`, async () => {
      const res = await api(app).post('/patients').send(validPayload(testCase.overrides));

      expect(res.status).toBe(422);
      assertEnvelope(res.body);
      expect(res.body.data).toBeNull();

      const error = res.body.error as { code: string; message: string; details: unknown };
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(typeof error.message).toBe('string');

      const details = error.details as Array<{ field: string; message: string }>;
      expect(Array.isArray(details)).toBe(true);
      expect(details.map((d) => d.field)).toContain(testCase.field);
    });
  }

  it('allows internal spaces in names (a deliberate widening of the charset rule)', async () => {
    const res = await api(app)
      .post('/patients')
      .send(validPayload({ first_name: 'Mary Jo', last_name: testLastName('Van Der Berg') }));

    expect(res.status).toBe(201);
    expect((res.body.data as Record<string, unknown>)['first_name']).toBe('Mary Jo');
  });

  it('reports every failure in one response, not just the first', async () => {
    const res = await api(app)
      .post('/patients')
      .send(validPayload({ state: 'XX', zip_code: 'nope', phone_number: '555' }));

    expect(res.status).toBe(422);
    const details = (res.body.error as { details: Array<{ field: string }> }).details;
    const fields = details.map((d) => d.field);

    expect(fields).toEqual(expect.arrayContaining(['state', 'zip_code', 'phone_number']));
  });

  it('rejects a missing required field', async () => {
    const payload = validPayload({ last_name: testLastName('Missing') });
    delete payload['city'];

    const res = await api(app).post('/patients').send(payload);

    expect(res.status).toBe(422);
    const details = (res.body.error as { details: Array<{ field: string }> }).details;
    expect(details.map((d) => d.field)).toContain('city');
  });

  it('rejects server-managed keys by name via .strict()', async () => {
    const res = await api(app)
      .post('/patients')
      .send(
        validPayload({
          last_name: testLastName('Strict'),
          patient_id: '11111111-1111-4111-8111-999999999999',
          created_at: '2020-01-01T00:00:00.000Z',
        }),
      );

    expect(res.status).toBe(422);
    const details = (res.body.error as { details: Array<{ field: string; message: string }> }).details;
    const fields = details.map((d) => d.field);

    // unrecognized_keys issues have an empty path; the keys must still be named.
    expect(fields).toEqual(expect.arrayContaining(['patient_id', 'created_at']));
    expect(details.every((d) => typeof d.message === 'string' && d.message.length > 0)).toBe(true);
  });
});

describe('POST /patients — malformed requests (400)', () => {
  it('maps an unparseable media type to 400 in the envelope (Fastify defaults to 415)', async () => {
    const res = await api(app)
      .post('/patients')
      .set('Content-Type', 'application/xml')
      .send('<patient/>');

    expect(res.status).toBe(400);
    assertEnvelope(res.body);
    expect(res.body.data).toBeNull();
    expect((res.body.error as { code: string }).code).toBe('BAD_REQUEST');
    expect((res.body.error as { details: unknown }).details).toBeNull();
  });

  it('maps a text/plain body to 400 — Fastify parses it, so the route must reject it', async () => {
    const res = await api(app)
      .post('/patients')
      .set('Content-Type', 'text/plain')
      .send('first_name=Jane');

    expect(res.status).toBe(400);
    assertEnvelope(res.body);
    expect((res.body.error as { code: string }).code).toBe('BAD_REQUEST');
  });

  it('maps a completely empty body to 400', async () => {
    const res = await api(app).post('/patients').set('Content-Type', 'application/json').send();

    expect(res.status).toBe(400);
    assertEnvelope(res.body);
    expect((res.body.error as { code: string }).code).toBe('BAD_REQUEST');
  });

  it('maps a JSON array body to 400', async () => {
    const res = await api(app).post('/patients').send([validPayload()] as unknown as object);

    expect(res.status).toBe(400);
    expect((res.body.error as { code: string }).code).toBe('BAD_REQUEST');
  });

  it('maps unparseable JSON to 400 in the envelope', async () => {
    const res = await api(app)
      .post('/patients')
      .set('Content-Type', 'application/json')
      .send('{"first_name": ');

    expect(res.status).toBe(400);
    assertEnvelope(res.body);
    expect((res.body.error as { code: string }).code).toBe('BAD_REQUEST');
  });

  it('never leaks a stack trace, file path or connection string', async () => {
    const res = await api(app)
      .post('/patients')
      .set('Content-Type', 'application/json')
      .send('{"first_name": ');

    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/postgresql:\/\//);
    expect(raw).not.toMatch(/\bat\s+\w+\s+\(/); // stack frame
    expect(raw).not.toMatch(/[A-Za-z]:\\/); // Windows path
  });
});

describe('unknown routes', () => {
  it('returns 404 in the envelope', async () => {
    const res = await api(app).get('/not-a-route');

    expect(res.status).toBe(404);
    assertEnvelope(res.body);
    expect(res.body.data).toBeNull();
    expect((res.body.error as { code: string }).code).toBe('NOT_FOUND');
  });
});
