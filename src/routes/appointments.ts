// GET /appointments — the whole appointment book (bonus: scheduling).
//
// HTTP only, like every other route file: no Prisma import, no `where` clause.
//
// This is the one collection endpoint that is NOT scoped to a patient id, and
// the reason is the dashboard: it renders every patient in a single pass, so a
// per-patient `GET /patients/:id/appointments` would be one request per row.
// One request, grouped client-side.
//
// The soft-delete rule lives in `listAllAppointments`, not here — same division
// as `GET /patients/:id/appointments`, whose 404 for a tombstoned patient also
// comes out of the service.

import type { FastifyInstance } from 'fastify';
import { ok } from '../lib/envelope.js';
import { toAppointmentResponseList } from '../lib/serialize.js';
import * as appointmentService from '../services/appointment.js';

export async function appointmentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/appointments', async (_request, reply) => {
    const appointments = await appointmentService.listAllAppointments();

    // Zero appointments is a successful empty collection, not a 404 — most
    // callers never reach the scheduling branch at all.
    reply.code(200).send(ok(toAppointmentResponseList(appointments)));
  });
}
