// Concurrency regressions for PUT and DELETE.
//
// The serial cases live in patients.lifecycle.test.ts and were always green.
// What was broken is what happens when two requests overlap: the service read
// the row with `getPatientById`, then wrote it with a SEPARATE
// `update({ where: { patientId } })` whose `where` carried no `deletedAt: null`.
// Between those two statements another request could tombstone the row, and the
// write landed on it anyway — so "already deleted -> 404" (handoff § 8 D2) held
// only for requests that happened to serialize.
//
// Two environment details this file depends on:
//   - the app must be really LISTENING. Supertest lazily calls `listen(0)` on a
//     server with no address, and eight simultaneous requests all race into
//     that call and throw ERR_SERVER_ALREADY_LISTEN. Hence `listenTestApp()`.
//   - the Prisma connection pool must be warm. On a cold pool the first burst
//     serializes behind connection setup and no interleaving happens at all,
//     which makes a single-shot race test silently vacuous. Hence `warmUp()`
//     and more than one iteration.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  api,
  listenTestApp,
  prisma,
  purgeTestPatients,
  testLastName,
  validPayload,
} from '../helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  await purgeTestPatients();
  app = await listenTestApp();
  await warmUp();
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

/** Opens several pool connections so the first real burst is not serialized. */
async function warmUp(): Promise<void> {
  await Promise.all(Array.from({ length: 8 }, () => api(app).get('/patients')));
}

// Last-name suffixes are LETTERS only: the name validator rejects digits, so an
// index-suffixed fixture name would 422 on create.
const LETTERS = 'abcdefghijklmnop';

describe('concurrent DELETE /patients/:id', () => {
  it('lets exactly one of eight simultaneous deletes win; the rest are 404', async () => {
    for (const letter of ['a', 'b', 'c']) {
      const id = await createPatient({ last_name: testLastName(`Racedel${letter}`) });

      const results = await Promise.all(
        Array.from({ length: 8 }, () => api(app).delete(`/patients/${id}`)),
      );

      const statuses = results.map((res) => res.status);

      // Decision D2: deleting an already-deleted row is a 404. That has to hold
      // under concurrency too, or "already deleted" is decided by a stale read.
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.filter((s) => s === 404)).toHaveLength(7);
    }
  });

  it('records a single deleted_at — no last-writer-wins overwrite', async () => {
    const id = await createPatient({ last_name: testLastName('Racedelts') });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => api(app).delete(`/patients/${id}`)),
    );

    const winners = results.filter((res) => res.status === 200);
    expect(winners).toHaveLength(1);

    const stamped = String((winners[0]?.body.data as Record<string, unknown>)['deleted_at']);
    const row = await prisma.patient.findUnique({ where: { patientId: id } });

    // The stored tombstone is the one the winning request reported. Before the
    // fix every request wrote its own `deleted_at` and the last one landed.
    expect(row?.deletedAt?.toISOString()).toBe(stamped);
  });
});

describe('PUT racing DELETE', () => {
  it('never lands an update on a tombstoned row', async () => {
    for (const letter of LETTERS) {
      const id = await createPatient({ last_name: testLastName(`Raceput${letter}`) });

      const [put, del] = await Promise.all([
        api(app).put(`/patients/${id}`).send({ city: 'Dallas' }),
        api(app).delete(`/patients/${id}`),
      ]);

      // The only two legal outcomes for the PUT:
      //   200 — it won the race, so the row it wrote (and returned) was live;
      //   404 — the delete won, so nothing was written at all.
      expect([200, 404]).toContain(put.status);
      expect([200, 404]).toContain(del.status);

      if (put.status === 200) {
        const body = put.body.data as Record<string, unknown>;
        // A 200 whose payload already carries `deleted_at` is the defect made
        // visible: the write went through onto a row that was already deleted.
        expect(body['deleted_at']).toBeNull();
      } else {
        // The delete won, so the attempted mutation must be absent from storage.
        const row = await prisma.patient.findUnique({ where: { patientId: id } });
        expect(row?.city).toBe('Austin');
      }
    }
  });
});
