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

/**
 * Why what the caller asked for could not be given to them.
 *
 * One field rather than a bag of booleans because the message layer has to
 * pick exactly ONE sentence, and picking it from several overlapping flags is
 * how "That exact time is taken" came to be said to callers who had named no
 * time. The precedence between overlapping causes is decided HERE, where the
 * facts are, not re-derived by every reader.
 */
export type UnmetReason =
  | 'closed'
  | 'beyond-horizon'
  | 'fully-booked'
  | 'day-over'
  | 'time-passed'
  | 'time-taken';

export interface AvailabilityResult {
  /** The exact time asked for, if it is open. */
  matched: Slot | null;
  /** Nearest open times, ranked by proximity. Never more than MAX_OFFERED_SLOTS. */
  alternatives: Slot[];
  /** The requested day exists and is a working day, but nothing is left on it. */
  dayFullyBooked: boolean;
  /** The requested time is outside opening hours or on a weekend. */
  outsideClinicHours: boolean;
  /**
   * Null when there was nothing to miss: either the exact time was open, or
   * the caller named no specific day/time and the offered slots ARE the
   * answer. Never null merely because `matched` is null.
   */
  unmetReason: UnmetReason | null;
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

/** Civil dates as a comparable integer: 2026-08-20 -> 20260820. */
function clinicDateKey(date: ClinicDate): number {
  return date.year * 10_000 + date.month * 100 + date.day;
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
      // Nothing was asked for, so nothing was missed. These slots are the
      // answer, not a substitute for one.
      unmetReason: null,
    };
  }

  const date = preference.date ?? utcToClinicDate(open[0] ?? now, CLINIC_TIMEZONE);

  // Checked BEFORE the day's grid is counted, not patched onto the flags
  // afterwards. A date past the booking window has a full, untouched grid and
  // no open instants inside `open`, which reads as "every remaining slot is
  // taken" — the agent would say "that day is completely booked" when the
  // truth is "we are not booking that far ahead yet". Short-circuiting is what
  // makes that state unreachable rather than merely currently-unreached.
  const lastBookableDay = addClinicDays(utcToClinicDate(now, CLINIC_TIMEZONE), SEARCH_WINDOW_DAYS);
  if (clinicDateKey(date) > clinicDateKey(lastBookableDay)) {
    return {
      matched: null,
      alternatives: open.slice(0, MAX_OFFERED_SLOTS).map(toSlot),
      dayFullyBooked: false,
      outsideClinicHours: false,
      unmetReason: 'beyond-horizon',
    };
  }

  const onDay = open.filter((instant) => sameClinicDay(instant, date));
  const grid = clinicDayGrid(date);
  const isWorkingDay = grid.length > 0;

  // "Fully booked" and "closed / already over" are different sentences and
  // must not collapse into the same boolean. `onDay` only ever contains
  // FUTURE open instants (openInstants already filtered on `now`), so once
  // today's last slot has passed, `onDay` is empty whether or not anything
  // was ever booked — that emptiness alone cannot mean "booked out". A day is
  // only genuinely full if it still has grid slots ahead of `now` and every
  // one of them is taken. Reviewed and confirmed in fix round 2: `now` at
  // 17:00 Central on a Monday, asking about that Monday, used to report
  // dayFullyBooked: true ("Monday is completely booked up") when the clinic
  // had simply closed for the day.
  const remainingOnDay = grid.filter((instant) => instant.getTime() > now.getTime());
  const dayFullyBooked = remainingOnDay.length > 0 && onDay.length === 0;

  // The third way a working day can be empty, and the reason the two flags
  // above are not enough on their own: the day simply ran out. Nothing was
  // booked out and the clinic is not shut — it is 5 PM.
  const dayOver = isWorkingDay && remainingOnDay.length === 0;

  // A requested time outside opening hours, or a weekend.
  const requestedMinutes = preference.minutesOfDay;
  const outsideClinicHours =
    !isWorkingDay ||
    (requestedMinutes !== undefined &&
      (requestedMinutes < OPEN_MINUTES || requestedMinutes >= CLOSE_MINUTES));

  // A day or daypart names no time, so there is no time to be "taken". Either
  // the day yielded slots — a plain success — or it yielded none for one of
  // three distinguishable reasons.
  const dayReason: UnmetReason | null = !isWorkingDay
    ? 'closed'
    : dayFullyBooked
      ? 'fully-booked'
      : dayOver
        ? 'day-over'
        : null;

  if (preference.kind === 'day') {
    return {
      matched: null,
      alternatives: (onDay.length > 0 ? onDay : open).slice(0, MAX_OFFERED_SLOTS).map(toSlot),
      dayFullyBooked,
      outsideClinicHours: !isWorkingDay,
      unmetReason: dayReason,
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
      dayFullyBooked,
      outsideClinicHours: !isWorkingDay,
      unmetReason: dayReason,
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

  // "Three o'clock" asked for at 4:45 has not been TAKEN by anyone — it has
  // gone by. Same empty result, and the caller hears a different sentence.
  const requestedPassed =
    zonedWallTimeToUtc(date, target, CLINIC_TIMEZONE).getTime() <= now.getTime();

  return {
    matched: exact === undefined ? null : toSlot(exact),
    alternatives: ranked
      .filter((instant) => instant.getTime() !== exact?.getTime())
      .slice(0, MAX_OFFERED_SLOTS)
      .map(toSlot),
    dayFullyBooked,
    outsideClinicHours,
    // Ordered most-specific first: a time that has already gone answers the
    // caller's actual question better than "that day is booked out", and both
    // beat the generic "taken".
    unmetReason:
      exact !== undefined
        ? null
        : outsideClinicHours
          ? 'closed'
          : requestedPassed
            ? 'time-passed'
            : dayFullyBooked
              ? 'fully-booked'
              : dayOver
                ? 'day-over'
                : 'time-taken',
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
