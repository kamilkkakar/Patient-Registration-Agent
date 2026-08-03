// Availability: the clinic-hours grid, minus whatever is already booked.
//
// Derived at query time rather than materialised. The appointments table stays
// the only state, so there is nothing to sync, nothing to backfill, and no way
// for a slot's status to disagree with reality.

import {
  CLINIC_TIMEZONE,
  CLOSE_MINUTES,
  OPEN_MINUTES,
  SLOT_MINUTES,
} from '../config/clinic.js';
import { clinicWeekday, zonedWallTimeToUtc, type ClinicDate } from '../lib/clinic-time.js';

/**
 * Every instant one clinic day offers. Empty for a weekend.
 *
 * Pure — no clock, no database — so daylight saving is testable by passing a
 * date rather than by waiting for November.
 */
export function clinicDayGrid(date: ClinicDate): Date[] {
  const weekday = clinicWeekday(date);
  if (weekday === 0 || weekday === 6) return [];

  const slots: Date[] = [];
  for (let minutes = OPEN_MINUTES; minutes < CLOSE_MINUTES; minutes += SLOT_MINUTES) {
    slots.push(zonedWallTimeToUtc(date, minutes, CLINIC_TIMEZONE));
  }
  return slots;
}
