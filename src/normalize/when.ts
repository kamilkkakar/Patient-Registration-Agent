// Spoken appointment preferences -> structured, timezone-free values.
//
// Returns CIVIL values, never Date objects. A Date is an instant, and an
// instant cannot be expressed without a timezone this module is deliberately
// not allowed to know — that belongs to the availability layer.

import { CLOSE_MINUTES, OPEN_MINUTES } from '../config/clinic.js';
import { addClinicDays, clinicWeekday, type ClinicDate } from '../lib/clinic-time.js';
import { TEEN_WORDS, TENS_WORDS, UNIT_WORDS } from './words.js';

const HOUR_WORDS: Record<string, number | undefined> = {
  ...UNIT_WORDS,
  ...TEEN_WORDS,
  twelve: 12,
};

function clean(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9: ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Clinic-open check used only to pick between two readings of a bare,
 * meridiem-less hour — never to reject a reading outright. Owner ruling
 * (round-1 fix): this module reports the time it understood, even one the
 * clinic doesn't offer. The availability layer has an `outsideClinicHours`
 * flag whose entire purpose is to say "we're open 9 to 5 — nearest I have is
 * 4:30"; nulling those times here makes that message unreachable and the
 * caller hears the generic "sorry, what day were you thinking?" instead.
 */
function inHours(minutes: number): boolean {
  return minutes >= OPEN_MINUTES && minutes < CLOSE_MINUTES;
}

/**
 * Resolve an hour/minute pair to minutes past midnight.
 *
 * Explicit AM/PM ("seven PM") is reported as-is, unconditionally — it is not
 * ambiguous, so there is nothing for clinic hours to decide. Only a bare hour
 * with no stated meridiem ("seven") is genuinely ambiguous, and clinic hours
 * break the tie: the reading that falls inside 9-5 wins ("one" -> 1 PM,
 * "nine" -> 9 AM). That preference is the feature this module exists for and
 * must not be diluted.
 *
 * If NEITHER reading of a bare hour is inside clinic hours (e.g. "seven": 7
 * AM and 7 PM are both outside 9-5), a reading is still returned rather than
 * null — per the same owner ruling above, this is a time we understood, just
 * one the availability layer will flag. The fallback is PM, chosen because it
 * is the same afternoon-leaning preference already encoded by checking
 * morning before afternoon above: when both are shut, keep the code and the
 * caller's intuition pointed the same direction. Which side of the coin flip
 * a doubly-closed hour lands on has no real-world effect — availability
 * reports outsideClinicHours and offers the nearest open slot regardless.
 */
function resolveMeridiem(hour: number, minute: number, explicit: 'am' | 'pm' | null): number {
  if (explicit === 'am') return hour === 12 ? minute : hour * 60 + minute;
  if (explicit === 'pm') return (hour === 12 ? 12 : hour + 12) * 60 + minute;

  const morning = hour * 60 + minute;
  const afternoon = (hour < 12 ? hour + 12 : hour) * 60 + minute;

  if (inHours(morning)) return morning;
  return afternoon; // in-hours if open, else the documented tie-break
}

/** A spoken time -> clinic-local minutes past midnight, or null. */
export function parseSpokenTime(text: string): number | null {
  const t = clean(text);
  if (t.length === 0) return null;

  if (/\bnoon\b|\bmidday\b/.test(t)) return 12 * 60;

  // "night" is a standalone day-part word here, distinct from "tonight" (kept
  // separately since \bnight\b does not match inside it — no word boundary
  // between the "o" of "to" and the "n" of "night").
  const explicit: 'am' | 'pm' | null = /\bp\s?m\b|\bafternoon\b|\bevening\b|\btonight\b|\bnight\b/.test(t)
    ? 'pm'
    : /\ba\s?m\b|\bmorning\b/.test(t)
      ? 'am'
      : null;

  // 13:30 / 1:30
  const digital = /\b(\d{1,2}):(\d{2})\b/.exec(t);
  if (digital !== null) {
    const hour = Number(digital[1]);
    const minute = Number(digital[2]);
    if (hour > 23 || minute > 59) return null;
    // 24-hour input ("20:30") already names one specific hour — there is no
    // AM/PM to disambiguate, so it bypasses resolveMeridiem and reports as-is
    // like everything else, in or out of clinic hours.
    if (hour > 12) return hour * 60 + minute;
    return resolveMeridiem(hour, minute, explicit);
  }

  const wordFor = (token: string | undefined): number | undefined =>
    token === undefined ? undefined : HOUR_WORDS[token] ?? (/^\d{1,2}$/.test(token) ? Number(token) : undefined);

  const tokens = t.split(' ');

  // "half past two", "quarter past nine", "quarter to three"
  const fraction = /\b(half|quarter)\s+(past|to)\s+([a-z0-9]+)\b/.exec(t);
  if (fraction !== null) {
    const base = wordFor(fraction[3]);
    if (base === undefined || base > 12) return null;
    const offset = fraction[1] === 'half' ? 30 : 15;
    if (fraction[2] === 'past') return resolveMeridiem(base, offset, explicit);
    const prevHour = base === 1 ? 12 : base - 1;
    return resolveMeridiem(prevHour, 60 - offset, explicit);
  }

  // "one thirty", "nine fifteen"
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const hour = wordFor(tokens[i]);
    const nextToken = tokens[i + 1];
    const minute = nextToken === undefined ? undefined : TENS_WORDS[nextToken] ?? TEEN_WORDS[nextToken];
    if (hour !== undefined && hour <= 12 && minute !== undefined && minute < 60) {
      return resolveMeridiem(hour, minute, explicit);
    }
  }

  // A bare hour: "one", "9", "nine o clock", "eighteen" (HOUR_WORDS includes
  // TEEN_WORDS, so plain 24-hour words reach here too — same as digital
  // 24-hour input above, already unambiguous and reported as-is).
  for (const token of tokens) {
    const hour = wordFor(token);
    if (hour !== undefined && hour >= 1 && hour <= 23) {
      if (hour > 12) return hour * 60;
      return resolveMeridiem(hour, 0, explicit);
    }
  }

  return null;
}

export type WhenQuery =
  | { kind: 'any' }
  | { kind: 'day'; date: ClinicDate }
  | { kind: 'daypart'; date: ClinicDate | null; part: 'morning' | 'afternoon' }
  | { kind: 'time'; date: ClinicDate | null; minutesOfDay: number };

const WEEKDAY_WORDS: Record<string, number | undefined> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const OPEN_REQUEST = /\banything\b|\bany time\b|\bwhenever\b|\bsoonest\b|\bas soon as possible\b|\basap\b|\bearliest\b|\bfirst available\b/;

/**
 * The soonest date on or after `today` falling on `weekday`.
 *
 * "Monday" said on a Monday means today. The availability layer then filters
 * out times that have already passed, so a late-afternoon caller naturally
 * rolls to next week without this function needing to know the clock.
 */
function nextWeekday(today: ClinicDate, weekday: number): ClinicDate {
  const delta = (weekday - clinicWeekday(today) + 7) % 7;
  return addClinicDays(today, delta);
}

/** Spoken preference -> structured query, or null if nothing is recognisable. */
export function parseWhen(text: string, today: ClinicDate): WhenQuery | null {
  const t = clean(text);
  if (t.length === 0) return null;

  if (OPEN_REQUEST.test(t)) return { kind: 'any' };

  let date: ClinicDate | null = null;

  if (/\btomorrow\b/.test(t)) {
    date = addClinicDays(today, 1);
  } else if (/\btoday\b/.test(t)) {
    date = today;
  } else {
    for (const token of t.split(' ')) {
      const weekday = WEEKDAY_WORDS[token];
      if (weekday !== undefined) {
        // "next Tuesday" is the soonest Tuesday — see the test for why.
        date = nextWeekday(today, weekday);
        break;
      }
    }
  }

  const minutesOfDay = parseSpokenTime(t);
  if (minutesOfDay !== null) return { kind: 'time', date, minutesOfDay };

  // A daypart only counts when no specific time was found — "1 in the
  // afternoon" is a time, not a daypart.
  if (/\bmorning\b/.test(t)) return { kind: 'daypart', date, part: 'morning' };
  if (/\bafternoon\b|\bevening\b/.test(t)) return { kind: 'daypart', date, part: 'afternoon' };

  if (date !== null) return { kind: 'day', date };

  return null;
}
