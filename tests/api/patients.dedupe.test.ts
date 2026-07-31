// Full-row deduplication: only an identical demographic row is a duplicate.
// Same phone alone, or same first+last name alone, must still create.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { api, purgeTestPatients, startTestApp, testLastName, validPayload } from '../helpers.js';
import { prisma } from '../../src/lib/prisma.js';

let app: FastifyInstance;

beforeAll(async () => {
  await purgeTestPatients();
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
  await purgeTestPatients();
});

beforeEach(async () => {
  await purgeTestPatients();
});

describe('POST /patients — full-row deduplication', () => {
  it('returns 201 on the first create and 200 with the same id on an identical second create', async () => {
    const body = validPayload({ last_name: testLastName('DedupeFull') });

    const first = await api(app).post('/patients').send(body);
    expect(first.status).toBe(201);
    const id = (first.body as { data: { patient_id: string } }).data.patient_id;

    const second = await api(app).post('/patients').send(body);
    expect(second.status).toBe(200);
    expect((second.body as { data: { patient_id: string } }).data.patient_id).toBe(id);

    const count = await prisma.patient.count({
      where: { lastName: testLastName('DedupeFull'), deletedAt: null },
    });
    expect(count).toBe(1);
  });

  it('does NOT dedupe on phone number alone — a second household member still creates', async () => {
    const sharedPhone = '5125550191';
    const a = await api(app)
      .post('/patients')
      .send(
        validPayload({
          first_name: 'Alex',
          last_name: testLastName('DedupePhoneA'),
          phone_number: sharedPhone,
        }),
      );
    const b = await api(app)
      .post('/patients')
      .send(
        validPayload({
          first_name: 'Blake',
          last_name: testLastName('DedupePhoneB'),
          phone_number: sharedPhone,
          date_of_birth: '03/20/1990',
        }),
      );

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((a.body as { data: { patient_id: string } }).data.patient_id).not.toBe(
      (b.body as { data: { patient_id: string } }).data.patient_id,
    );
  });

  it('does NOT dedupe on first and last name alone when other fields differ', async () => {
    const name = { first_name: 'Casey', last_name: testLastName('DedupeName') };

    const a = await api(app)
      .post('/patients')
      .send(validPayload({ ...name, phone_number: '5125550192', city: 'Austin' }));
    const b = await api(app)
      .post('/patients')
      .send(validPayload({ ...name, phone_number: '5125550193', city: 'Dallas' }));

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((a.body as { data: { patient_id: string } }).data.patient_id).not.toBe(
      (b.body as { data: { patient_id: string } }).data.patient_id,
    );
  });

  it('treats differing optional fields as a different row', async () => {
    const base = validPayload({
      last_name: testLastName('DedupeOpt'),
      phone_number: '5125550194',
    });

    const a = await api(app).post('/patients').send(base);
    const b = await api(app)
      .post('/patients')
      .send({ ...base, email: 'casey.dedupeopt@example.com' });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((a.body as { data: { patient_id: string } }).data.patient_id).not.toBe(
      (b.body as { data: { patient_id: string } }).data.patient_id,
    );
  });
});
