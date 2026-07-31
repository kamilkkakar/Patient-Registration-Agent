// GET /health, plus the layering rule it used to break.
//
// Handoff § 7: services are the only layer that touches Prisma — "a route that
// imports Prisma is a review failure". `src/routes/health.ts` imported the
// client directly and ran its own `SELECT 1`.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { api, assertEnvelope, startTestApp } from '../helpers.js';
import { checkDatabase } from '../../src/services/health.js';

const ROUTES_DIR = path.resolve(import.meta.dirname, '../../src/routes');

let app: FastifyInstance;

beforeAll(async () => {
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('reports a healthy service in the envelope', async () => {
    const res = await api(app).get('/health');

    expect(res.status).toBe(200);
    assertEnvelope(res.body);
    expect(res.body.error).toBeNull();

    const payload = res.body.data as Record<string, unknown>;
    expect(payload['status']).toBe('ok');
    expect(payload['database']).toBe('up');
    expect(typeof payload['uptime_seconds']).toBe('number');
    expect(typeof payload['timestamp']).toBe('string');
  });
});

describe('checkDatabase()', () => {
  it('resolves when the database answers', async () => {
    await expect(checkDatabase()).resolves.toBeUndefined();
  });
});

describe('route layer', () => {
  it('contains no direct Prisma import', async () => {
    const files = (await readdir(ROUTES_DIR)).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = await readFile(path.join(ROUTES_DIR, file), 'utf8');
      expect(source, `${file} imports Prisma`).not.toMatch(/from\s+'[^']*lib\/prisma\.js'/);
      expect(source, `${file} imports @prisma/client`).not.toMatch(/from\s+'@prisma\/client'/);
    }
  });
});
