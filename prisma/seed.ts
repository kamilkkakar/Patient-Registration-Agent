// Demo seed data.
//
// Challenge § 3: "Optionally include 1-2 seed patient records for
// demonstration." Challenge FAQ: "Do not store real patient data." — every
// value below is obviously fictional, and the phone numbers are drawn from the
// reserved 555-01xx fictional range.
//
// Idempotent: each record is upserted against a fixed, hard-coded patient_id,
// so `npm run db:seed` can be run repeatedly without duplicating rows. Keying on
// phone_number would NOT work — it is deliberately not unique, because
// households share numbers.
//
// One record exercises the optional fields (insurance, emergency contact,
// preferred language); the other uses required fields only. A reviewer hitting
// GET /patients therefore sees both response variants immediately.

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Dates of birth are built with Date.UTC, never `new Date("02/15/1992")` —
 * the latter is LOCAL midnight and stores the wrong day in any non-UTC zone.
 */
function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

const SEED_PATIENTS = [
  {
    patientId: '11111111-1111-4111-8111-111111111111',
    firstName: 'Jane',
    lastName: 'Sample',
    dateOfBirth: utcDate(1992, 2, 15),
    sex: 'FEMALE' as const,
    phoneNumber: '5125550142',
    email: 'jane.sample@example.com',
    addressLine1: '123 Demo Street',
    addressLine2: 'Apt 4B',
    city: 'Austin',
    state: 'TX',
    zipCode: '78701',
    insuranceProvider: 'Example Health Plan',
    insuranceMemberId: 'EX123456789',
    preferredLanguage: 'English',
    emergencyContactName: 'John Sample',
    emergencyContactPhone: '5125550188',
  },
  {
    // Required fields only — every optional column stays null / defaulted.
    patientId: '22222222-2222-4222-8222-222222222222',
    firstName: 'Marcus',
    lastName: 'Example',
    dateOfBirth: utcDate(1978, 7, 4),
    sex: 'MALE' as const,
    phoneNumber: '2125550175',
    addressLine1: '900 Placeholder Avenue',
    city: 'New York',
    state: 'NY',
    zipCode: '10001-2345',
  },
];

async function main(): Promise<void> {
  for (const patient of SEED_PATIENTS) {
    const { patientId, ...fields } = patient;

    await prisma.patient.upsert({
      where: { patientId },
      // Re-running the seed restores a record a reviewer may have edited or
      // soft-deleted while poking at the API.
      update: { ...fields, deletedAt: null },
      create: { patientId, ...fields },
    });

    console.log(`Seeded patient ${patientId} (${patient.firstName} ${patient.lastName})`);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err: unknown) => {
    console.error('Seed failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
