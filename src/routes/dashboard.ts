// The patients dashboard: one static HTML file, served at `/` and `/dashboard`.
//
// @fastify/static is registered with `serve: false` ON PURPOSE. Its default
// mount at prefix `/` installs a catch-all `GET /*`, which would put a second
// handler in front of every unmatched path and take over the 404 story that
// `setNotFoundHandler` owns. With `serve: false` the plugin registers NO routes
// at all — it only decorates `reply.sendFile` — so the two routes below are the
// entire surface this file adds. `/patients` therefore cannot be shadowed by
// construction, rather than by trusting router precedence.
//
// HTTP only, like every other route file: no Prisma, no service call. The page
// calls `GET /patients` from the browser on the same origin, so there is no
// CORS layer and no second serialization of the patient shape to drift.

import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

// `<repo>/src/routes` under tsx/vitest, `<repo>/dist/routes` after the build.
// Both are two levels below the repo root, which is why one expression covers
// them. The directory must exist at registration time — @fastify/static throws
// otherwise — so `public/` is tracked in git and ships with the Railway image.
const PUBLIC_DIR = path.resolve(import.meta.dirname, '../../public');

const DASHBOARD_FILE = 'dashboard.html';

/** `/` is where a browser lands; `/dashboard` is what a reviewer guesses. */
const DASHBOARD_URLS = ['/', '/dashboard'] as const;

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  await app.register(fastifyStatic, { root: PUBLIC_DIR, serve: false });

  // The page's pure helpers, split out so a unit test can execute them rather
  // than grep for them. Served explicitly for the same reason the dashboard is:
  // `serve: false` means @fastify/static registers no routes of its own, so
  // nothing here can shadow /patients.
  app.get('/dashboard-helpers.js', async (_request, reply) => {
    return reply.sendFile('dashboard-helpers.js');
  });

  for (const url of DASHBOARD_URLS) {
    // Both URLs answer the same file rather than one redirecting to the other,
    // so neither is a second-class link to paste into a review.
    app.get(url, async (_request, reply) => {
      // `sendFile` derives Content-Type from the extension; calling
      // `reply.type()` first would just be overwritten.
      return reply.sendFile(DASHBOARD_FILE);
    });
  }
}
