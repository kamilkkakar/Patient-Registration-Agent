// The patients dashboard, and the router invariants it must not break.
//
// The interesting risk is not "does the HTML come back" — it is what mounting
// static files does to the rest of the router. @fastify/static's default mount
// installs a catch-all `GET /*`, which would sit in front of every unmatched
// path and take over the envelope 404 that `setNotFoundHandler` owns. This file
// pins the behaviour that proves the mount is inert: `/patients` still routes,
// its 400/404 contract is unchanged, and an unknown path still answers the
// envelope rather than a static-file miss.
//
// The "no external requests" constraint is asserted against the file itself,
// because it cannot be observed over HTTP: a CDN link only fails in a browser,
// on a reviewer's machine, offline.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { api, assertEnvelope, startTestApp } from '../helpers.js';

const DASHBOARD_PATH = path.resolve(import.meta.dirname, '../../public/dashboard.html');

// A well-formed UUID that cannot exist: it must still 404, not fall into a
// static-file handler.
const ABSENT_ID = '00000000-0000-4000-8000-000000000000';

let app: FastifyInstance;

beforeAll(async () => {
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('GET / and GET /dashboard', () => {
  it('serves the dashboard as HTML from the root', async () => {
    const res = await api(app).get('/');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<!doctype html>');
    expect(res.text).toContain('Patient Registry');
  });

  it('serves the same document at /dashboard', async () => {
    const root = await api(app).get('/');
    const dashboard = await api(app).get('/dashboard');

    expect(dashboard.status).toBe(200);
    expect(dashboard.headers['content-type']).toMatch(/text\/html/);
    expect(dashboard.text).toBe(root.text);
  });

  it('answers HEAD / so a link checker does not see a broken root', async () => {
    const res = await api(app).head('/');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('does not answer non-GET verbs on the dashboard URLs', async () => {
    const res = await api(app).post('/dashboard').send({});

    expect(res.status).toBe(404);
    assertEnvelope(res.body);
    expect((res.body.error as Record<string, unknown>)['code']).toBe('NOT_FOUND');
  });
});

describe('the static mount does not shadow the API', () => {
  it('leaves GET /patients returning the envelope', async () => {
    const res = await api(app).get('/patients');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    assertEnvelope(res.body);
    expect(res.body.error).toBeNull();
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('leaves the query-filter 400 contract intact', async () => {
    const res = await api(app).get('/patients?phone_number=123');

    expect(res.status).toBe(400);
    assertEnvelope(res.body);
    expect((res.body.error as Record<string, unknown>)['code']).toBe('BAD_REQUEST');
  });

  it('leaves GET /patients/:id returning 404 for an unknown id', async () => {
    const res = await api(app).get(`/patients/${ABSENT_ID}`);

    expect(res.status).toBe(404);
    assertEnvelope(res.body);
    expect((res.body.error as Record<string, unknown>)['code']).toBe('NOT_FOUND');
  });

  it('leaves an unknown route answering the envelope 404, not a file miss', async () => {
    const res = await api(app).get('/not-a-real-route');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    assertEnvelope(res.body);
    expect((res.body.error as Record<string, unknown>)['code']).toBe('NOT_FOUND');
  });

  it('leaves /health answering the envelope', async () => {
    const res = await api(app).get('/health');

    expect(res.status).toBe(200);
    assertEnvelope(res.body);
  });
});

describe('public/dashboard.html', () => {
  it('makes no external requests', async () => {
    const source = await readFile(DASHBOARD_PATH, 'utf8');

    // No CDN script, no web font, no remote image, no remote stylesheet. The
    // page must render identically on a machine with no internet access.
    expect(source).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
    expect(source).not.toMatch(/(?:src|href)\s*=\s*["']\/\//);
    expect(source).not.toMatch(/@import/i);
    expect(source).not.toMatch(/url\(\s*["']?https?:/i);
  });

  it('builds rows without innerHTML, so patient data cannot inject markup', async () => {
    const source = await readFile(DASHBOARD_PATH, 'utf8');

    expect(source).not.toMatch(/\.innerHTML/);
    expect(source).not.toMatch(/\.outerHTML/);
    expect(source).not.toMatch(/insertAdjacentHTML/);
    expect(source).not.toMatch(/document\.write/);
  });

  it('actually SETS the last-name hint, rather than only ever clearing it', async () => {
    // `last_name` filtering is an exact match (`services/patient.ts` uses
    // `equals`), so a half-typed surname returns an empty table. The hint span
    // existed but was only ever assigned '', which made it dead markup and left
    // the empty result unexplained.
    const source = await readFile(DASHBOARD_PATH, 'utf8');

    expect(source).toMatch(/hintLastName\.textContent\s*=\s*'[^']+'/);
  });

  it('spans the expanded detail row across every column in the header', async () => {
    // The detail row's `colSpan` is a hard-coded literal, so adding a column to
    // the header without touching it leaves the expanded panel one cell short —
    // a purely visual break that no HTTP test can see.
    const source = await readFile(DASHBOARD_PATH, 'utf8');

    // Counted inside <thead> only, so a `<th>` mentioned in a comment further
    // down the file cannot move the number.
    const thead = /<thead>([\s\S]*?)<\/thead>/.exec(source);
    const columns = thead?.[1]?.match(/<th\b[^>]*>/g) ?? [];
    const colSpan = /td\.colSpan\s*=\s*(\d+)/.exec(source);

    expect(columns.length).toBeGreaterThan(0);
    expect(colSpan).not.toBeNull();
    expect(Number(colSpan?.[1])).toBe(columns.length);
  });

  it('does not claim every record was collected over the phone', async () => {
    // False for the seeded demo patients and for anything created through
    // `POST /patients`, both of which show up in this same table.
    const source = await readFile(DASHBOARD_PATH, 'utf8');

    expect(source).not.toMatch(/Every record below was collected over the phone/i);
  });
});

describe('dashboard-helpers.js', () => {
  it('is served on the same origin as the page', async () => {
    // WHY: the page loads it with <script src>. If this route is missing the
    // dashboard throws on `window.DashboardHelpers` and renders nothing — a
    // failure no other test here would catch, because they all read the file
    // from disk rather than over HTTP.
    const res = await api(app).get('/dashboard-helpers.js');

    expect(res.status).toBe(200);
    expect(res.text).toContain('DashboardHelpers');
  });

  it('makes no external requests', async () => {
    // Same constraint as the page: a CDN link only fails in a browser, on a
    // reviewer's machine, offline.
    const source = await readFile(
      path.resolve(import.meta.dirname, '../../public/dashboard-helpers.js'),
      'utf8',
    );

    expect(source).not.toMatch(/https?:\/\//);
  });

  it('is referenced by the page before the inline script runs', async () => {
    // Order matters: the inline script binds EMPTY from the helpers at the top
    // of its IIFE, so a <script src> placed after it would throw.
    const page = await readFile(DASHBOARD_PATH, 'utf8');

    expect(page.indexOf('dashboard-helpers.js')).toBeLessThan(page.indexOf('var helpers = window.DashboardHelpers'));
  });
});

it('shows when a booking was made, not only when it is for', async () => {
  // WHY: created_at (the caller rang in) and scheduled_for (the appointment) are
  // different facts. The detail row previously showed only the second, so a
  // reviewer could not tell a booking made this morning from one made in June.
  const source = await readFile(DASHBOARD_PATH, 'utf8');

  expect(source).toContain('appointment.created_at');
  expect(source).toContain('booked ');
});

it('distinguishes a moved booking from one simply made at that time', async () => {
  // WHY: rescheduling updates scheduled_for IN PLACE and leaves the status
  // SCHEDULED, so the row alone cannot show that a move happened. Without
  // rescheduled_from the page would render a moved appointment identically to
  // one booked at the new time — which is what made a reschedule look like a
  // cancellation on the live dashboard.
  const source = await readFile(DASHBOARD_PATH, 'utf8');

  expect(source).toContain('appointment.rescheduled_from');
  expect(source).toContain('moved from ');
});
