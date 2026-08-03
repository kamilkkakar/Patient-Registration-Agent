// Two callers, one slot.
//
// WHY this needs a real database: the guarantee is a partial unique index, not
// application logic. A check-then-insert would pass a single-threaded test and
// still lose the race in production, which is the bug this replaces.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bookAppointment } from '../../src/services/appointment.js';
import { api, prisma, purgeTestPatients, startTestApp, testLastName, validPayload } from '../helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  await purgeTestPatients();
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
  await purgeTestPatients();
});

async function createPatient(suffix: string): Promise<string> {
  const res = await api(app).post('/patients').send(validPayload({ last_name: testLastName(suffix) }));
  expect(res.status).toBe(201);
  return String((res.body.data as Record<string, unknown>)['patient_id']);
}

describe('one live appointment per instant', () => {
  const SLOT = new Date('2026-12-14T15:00:00.000Z');

  it('lets exactly one of two concurrent bookings win', async () => {
    const a = await createPatient('Concurrenta');
    const b = await createPatient('Concurrentb');

    const results = await Promise.allSettled([
      bookAppointment({ patientId: a, scheduledFor: SLOT }),
      bookAppointment({ patientId: b, scheduledFor: SLOT }),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);

    const rows = await prisma.appointment.findMany({ where: { scheduledFor: SLOT } });
    expect(rows).toHaveLength(1);
  });

  it('frees the instant again once the winner cancels', async () => {
    // WHY: cancelled rows drop OUT of the partial index. If the index were
    // unconditional, a cancelled booking would block that time forever.
    const a = await createPatient('Concurrentfree');
    const b = await createPatient('Concurrentrebook');
    const slot = new Date('2026-12-15T15:00:00.000Z');

    const first = await bookAppointment({ patientId: a, scheduledFor: slot });
    await prisma.appointment.update({ where: { id: first.id }, data: { status: 'CANCELLED' } });

    await expect(bookAppointment({ patientId: b, scheduledFor: slot })).resolves.toBeDefined();
  });
});
