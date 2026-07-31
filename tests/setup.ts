// Runs before any test module is evaluated, so DATABASE_URL is populated before
// src/lib/prisma.ts constructs the client.

import 'dotenv/config';

// Keep a green run readable. Logging behaviour itself is exercised by the app,
// not asserted here.
process.env.LOG_LEVEL = 'silent';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Tests run against a real Postgres — point it at any instance, then run `npx prisma generate` and `npx prisma migrate deploy` (see README "Local setup").',
  );
}
