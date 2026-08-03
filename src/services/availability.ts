// Availability: the clinic-hours grid, minus whatever is already booked.
//
// Derived at query time rather than materialised. The appointments table stays
// the only state, so there is nothing to sync, nothing to backfill, and no way
// for a slot's status to disagree with reality.

import {
  CLINIC_TIMEZONE,
  CLOSE_MINUTES,
  MAX_OFFERED_SLOTS,
  OPEN_MINUTES,
  SEARCH_WINDOW_DAYS,
  SLOT_MINUTES,
} from '../config/clinic.js';
import {
  addClinicDays,
  clinicWeekday,
  utcToClinicDate,
  utcToClinicMinutes,
  zonedWallTimeToUtc,
  type ClinicDate,
} from '../lib/clinic-time.js';
import { prisma } from '../lib/prisma.js';
import { ACTIVE_APPOINTMENT_STATUSES, formatSpokenTime } from './appointment.js';

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

export interface Slot {
  slotId: string;
  scheduledFor: Date;
  spokenTime: string;
}

export interface AvailabilityPreference {
  kind: 'any' | 'day' | 'daypart' | 'time';
  date?: ClinicDate | null;
  part?: 'morning' | 'afternoon';
  minutesOfDay?: number;
}

export interface AvailabilityResult {
  /** The exact time asked for, if it is open. */
  matched: Slot | null;
  /** Nearest open times, ranked by proximity. Never more than MAX_OFFERED_SLOTS. */
  alternatives: Slot[];
  /** The requested day exists and is a working day, but nothing is left on it. */
  dayFullyBooked: boolean;
  /** The requested time is outside opening hours or on a weekend. */
  outsideClinicHours: boolean;
}

const SLOT_ID = /^slot-(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})Z$/;

function toSlot(scheduledFor: Date): Slot {
  return {
    slotId: `slot-${scheduledFor.toISOString().slice(0, 16)}Z`,
    scheduledFor,
    spokenTime: formatSpokenTime(scheduledFor),
  };
}

/**
 * A slot id -> the instant it denotes, or null.
 *
 * Rebuilt with Date.UTC from the captured groups. The string is NEVER handed to
 * `new Date()` — see src/lib/serialize.ts:97-107.
 */
export function parseSlotId(slotId: string): Date | null {
  const m = SLOT_ID.exec(slotId);
  if (m === null) return null;

  const [, y, mo, d, h, mi] = m.map(Number) as unknown as number[];
  const instant = new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!));

  // Date.UTC rolls impossible values over (month 13 becomes January). Reject
  // rather than silently accept a different day than the caller was offered.
  if (
    instant.getUTCFullYear() !== y ||
    instant.getUTCMonth() + 1 !== mo ||
    instant.getUTCDate() !== d ||
    instant.getUTCHours() !== h ||
    instant.getUTCMinutes() !== mi
  ) {
    return null;
  }

  return instant;
}

/** Live appointments occupying instants inside a window. */
async function bookedInstants(from: Date, to: Date): Promise<Set<number>> {
  const rows = await prisma.appointment.findMany({
    where: {
      status: { in: [...ACTIVE_APPOINTMENT_STATUSES] },
      scheduledFor: { gte: from, lte: to },
    },
    select: { scheduledFor: true },
  });
  return new Set(rows.map((row) => row.scheduledFor.getTime()));
}

/** Every open instant in the search window, ascending. */
async function openInstants(now: Date): Promise<Date[]> {
  const startDate = utcToClinicDate(now, CLINIC_TIMEZONE);
  const days: Date[] = [];

  for (let offset = 0; offset <= SEARCH_WINDOW_DAYS; offset += 1) {
    days.push(...clinicDayGrid(addClinicDays(startDate, offset)));
  }

  const future = days.filter((instant) => instant.getTime() > now.getTime());
  if (future.length === 0) return [];

  const taken = await bookedInstants(future[0]!, future[future.length - 1]!);
  return future.filter((instant) => !taken.has(instant.getTime()));
}

function sameClinicDay(instant: Date, date: ClinicDate): boolean {
  const d = utcToClinicDate(instant, CLINIC_TIMEZONE);
  return d.year === date.year && d.month === date.month && d.day === date.day;
}

/**
 * Open times, ranked by how close they are to what the caller asked for.
 *
 * The ranking is the feature. An unranked list cannot answer "not at one, but I
 * could do half past one".
 */
export async function findAvailability(opts: {
  now: Date;
  preference: AvailabilityPreference;
}): Promise<AvailabilityResult> {
  const { now, preference } = opts;
  const open = await openInstants(now);

  // No day or time asked for: the soonest openings, in order.
  if (preference.kind === 'any' || (preference.date == null && preference.kind === 'day')) {
    return {
      matched: null,
      alternatives: open.slice(0, MAX_OFFERED_SLOTS).map(toSlot),
      dayFullyBooked: false,
      outsideClinicHours: false,
    };
  }

  const date = preference.date ?? utcToClinicDate(open[0] ?? now, CLINIC_TIMEZONE);
  const onDay = open.filter((instant) => sameClinicDay(instant, date));
  const isWorkingDay = clinicDayGrid(date).length > 0;

  // A requested time outside opening hours, or a weekend.
  const requestedMinutes = preference.minutesOfDay;
  const outsideClinicHours =
    !isWorkingDay ||
    (requestedMinutes !== undefined &&
      (requestedMinutes < OPEN_MINUTES || requestedMinutes >= CLOSE_MINUTES));

  if (preference.kind === 'day') {
    return {
      matched: null,
      alternatives: (onDay.length > 0 ? onDay : open).slice(0, MAX_OFFERED_SLOTS).map(toSlot),
      dayFullyBooked: isWorkingDay && onDay.length === 0,
      outsideClinicHours: !isWorkingDay,
    };
  }

  if (preference.kind === 'daypart') {
    const part = preference.part ?? 'morning';
    const inPart = onDay.filter((instant) => {
      const minutes = utcToClinicMinutes(instant, CLINIC_TIMEZONE);
      return part === 'morning' ? minutes < 12 * 60 : minutes >= 12 * 60;
    });
    return {
      matched: null,
      alternatives: (inPart.length > 0 ? inPart : onDay.length > 0 ? onDay : open)
        .slice(0, MAX_OFFERED_SLOTS)
        .map(toSlot),
      dayFullyBooked: isWorkingDay && onDay.length === 0,
      outsideClinicHours: !isWorkingDay,
    };
  }

  // kind === 'time'
  const target = requestedMinutes ?? OPEN_MINUTES;
  const exact = onDay.find(
    (instant) => utcToClinicMinutes(instant, CLINIC_TIMEZONE) === target,
  );

  // Ranked by distance from what they asked for, that day first, then anywhere.
  const ranked = [...(onDay.length > 0 ? onDay : open)].sort((a, b) => {
    const da = Math.abs(utcToClinicMinutes(a, CLINIC_TIMEZONE) - target);
    const db = Math.abs(utcToClinicMinutes(b, CLINIC_TIMEZONE) - target);
    return da === db ? a.getTime() - b.getTime() : da - db;
  });

  return {
    matched: exact === undefined ? null : toSlot(exact),
    alternatives: ranked
      .filter((instant) => instant.getTime() !== exact?.getTime())
      .slice(0, MAX_OFFERED_SLOTS)
      .map(toSlot),
    dayFullyBooked: isWorkingDay && onDay.length === 0,
    outsideClinicHours,
  };
}

/**
 * A slot id -> a bookable Slot, or null.
 *
 * Structural, not membership of a just-offered set: that set now depends on the
 * query window, and the booking call may have used a different one. Checked
 * against the grid, the clock, and the database instead. The partial unique
 * index is the backstop if this is ever fooled.
 */
export async function resolveOpenSlot(slotId: string, now: Date): Promise<Slot | null> {
  const instant = parseSlotId(slotId);
  if (instant === null) return null;
  if (instant.getTime() <= now.getTime()) return null;

  const date = utcToClinicDate(instant, CLINIC_TIMEZONE);
  const onGrid = clinicDayGrid(date).some((slot) => slot.getTime() === instant.getTime());
  if (!onGrid) return null;

  const taken = await bookedInstants(instant, instant);
  if (taken.has(instant.getTime())) return null;

  return toSlot(instant);
}
