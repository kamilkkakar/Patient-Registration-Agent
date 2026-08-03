-- One LIVE appointment per instant, enforced by Postgres rather than by a
-- check-then-insert, which would lose the race it exists to prevent.
--
-- Partial on purpose: a CANCELLED or COMPLETED row drops out of the index, so a
-- cancelled booking stops blocking its old time without any code remembering to
-- free it.
--
-- Prisma cannot express a partial index in schema.prisma, which is why this is
-- hand-written SQL. schema.prisma carries a comment pointing here.
CREATE UNIQUE INDEX "appointments_active_slot_unique"
  ON "appointments" ("scheduled_for")
  WHERE "status" IN ('SCHEDULED', 'CONFIRMED');
