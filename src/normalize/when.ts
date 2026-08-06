// Spoken appointment preferences -> structured, timezone-free values.
//
// Returns CIVIL values, never Date objects. A Date is an instant, and an
// instant cannot be expressed without a timezone this module is deliberately
// not allowed to know — that belongs to the availability layer.

import { CLOSE_MINUTES, OPEN_MINUTES } from '../config/clinic.js';
import { TEEN_WORDS, TENS_WORDS, UNIT_WORDS } from './words.js';

const HOUR_WORDS: Record<string, number | undefined> = {
  ...UNIT_WORDS,
  ...TEEN_WORDS,
  twelve: 12,
};

function clean(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9: ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Clinic-open check shared by every return path below — see resolveMeridiem. */
function inHours(minutes: number): boolean {
  return minutes >= OPEN_MINUTES && minutes < CLOSE_MINUTES;
}

/**
 * Both readings of a bare hour, preferring the one inside clinic hours.
 *
 * The clinic-hours check applies even when the meridiem is explicit. A caller
 * who says "eight PM" has given an unambiguous reading, but it is still not a
 * time the clinic offers — returning it anyway would be handing the booking
 * layer a start time it has to reject, when this layer already knows better.
 */
function resolveMeridiem(hour: number, minute: number, explicit: 'am' | 'pm' | null): number | null {
  if (explicit === 'am') {
    const value = hour === 12 ? minute : hour * 60 + minute;
    return inHours(value) ? value : null;
  }
  if (explicit === 'pm') {
    const value = (hour === 12 ? 12 : hour + 12) * 60 + minute;
    return inHours(value) ? value : null;
  }

  const morning = hour * 60 + minute;
  const afternoon = (hour < 12 ? hour + 12 : hour) * 60 + minute;

  if (inHours(morning)) return morning;
  if (inHours(afternoon)) return afternoon;
  return null;
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

  // A bare hour: "one", "9", "nine o clock"
  for (const token of tokens) {
    const hour = wordFor(token);
    if (hour !== undefined && hour >= 1 && hour <= 23) {
      if (hour > 12) return hour * 60;
      return resolveMeridiem(hour, 0, explicit);
    }
  }

  return null;
}
