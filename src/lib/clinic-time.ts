// Civil wall-clock time in one IANA zone <-> UTC instants.
//
// `Intl` is used HERE and only here, and only to obtain a UTC offset — never to
// produce user-visible text. The anti-ICU rule in src/services/appointment.ts
// exists because ICU's month and weekday NAMES vary by Node build and are
// asserted in tests and read aloud on a live call. Numeric offsets do not vary,
// so this is a different question with a different answer.

/** A civil date: no time, no zone. Month is 1-indexed. */
export interface ClinicDate {
  year: number;
  month: number;
  day: number;
}

/**
 * The zone's UTC offset, in minutes, at a given instant.
 *
 * Works by asking Intl what the instant looks like on the wall in that zone,
 * reassembling those parts as if they were UTC, and taking the difference.
 */
function offsetMinutesAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  // `hour` can render as 24 for midnight on some ICU builds; % 24 normalises it.
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );

  return (asIfUtc - instant.getTime()) / 60_000;
}

/**
 * A clinic-local wall time -> the UTC instant it denotes.
 *
 * Two passes on purpose. The offset depends on the instant, and the instant is
 * what we are solving for, so the first pass guesses with the offset at the
 * naive time and the second corrects it. That second pass is what makes the
 * DST switch days come out right.
 */
export function zonedWallTimeToUtc(
  date: ClinicDate,
  minutesOfDay: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day, 0, minutesOfDay);

  const firstOffset = offsetMinutesAt(new Date(naive), timeZone);
  const firstGuess = new Date(naive - firstOffset * 60_000);

  const secondOffset = offsetMinutesAt(firstGuess, timeZone);
  return secondOffset === firstOffset
    ? firstGuess
    : new Date(naive - secondOffset * 60_000);
}

/** The clinic-local calendar day an instant falls on. */
export function utcToClinicDate(instant: Date, timeZone: string): ClinicDate {
  const shifted = new Date(instant.getTime() + offsetMinutesAt(instant, timeZone) * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** Clinic-local minutes past midnight for an instant. */
export function utcToClinicMinutes(instant: Date, timeZone: string): number {
  const shifted = new Date(instant.getTime() + offsetMinutesAt(instant, timeZone) * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/**
 * Day of week for a CIVIL date, 0 = Sunday.
 *
 * Read at UTC midnight deliberately: a civil date has no zone, and treating it
 * as UTC keeps the weekday independent of where the reader is.
 */
export function clinicWeekday(date: ClinicDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** Civil date arithmetic. Rolls over month and year ends. */
export function addClinicDays(date: ClinicDate, days: number): ClinicDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}
