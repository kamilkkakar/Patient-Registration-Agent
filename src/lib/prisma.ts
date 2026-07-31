// The single PrismaClient for the process.
//
// Guarded against hot-reload / repeated-import duplication: `tsx watch` and
// Vitest can evaluate this module more than once per process, and each fresh
// PrismaClient opens its own connection pool. Stashing it on globalThis keeps
// exactly one pool alive outside production.
//
// This file and `src/services/*` are the ONLY places allowed to touch
// @prisma/client at runtime (docs/handoff/phase-2.md § 7).

import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { __patientRegistrationPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__patientRegistrationPrisma ??
  new PrismaClient({
    // Query logging is intentionally off: query text can contain patient data.
    log: [{ emit: 'stdout', level: 'warn' }, { emit: 'stdout', level: 'error' }],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__patientRegistrationPrisma = prisma;
}
