// Spoken appointment preferences -> structured, timezone-free values.
//
// Returns CIVIL values, never Date objects. A Date is an instant, and an
// instant cannot be expressed without a timezone this module is deliberately
// not allowed to know — that belongs to the availability layer.

import { CLOSE_MINUTES, OPEN_MINUTES } from '../config/clinic.js';
import { addClinicDays, clinicWeekday, type ClinicDate } from '../lib/clinic-time.js';
import { MONTH_WORDS, ORDINAL_WORDS, TEEN_WORDS, TENS_WORDS, UNIT_WORDS } from './words.js';

const HOUR_WORDS: Record<string, number | undefined> = {
  ...UNIT_WORDS,
  ...TEEN_WORDS,
  twelve: 12,
};

/**
 * Words that make the number before them a quantity, never an hour.
 *
 * "In two weeks" is the caller changing the subject to a horizon, not naming
 * 2 PM. Note "second" is deliberately absent: it is an ORDINAL_WORDS entry
 * ("the second") and the calendar-date reading is far likelier than someone
 * timing an appointment in seconds.
 */
const DURATION_WORDS = new Set([
  'week', 'weeks', 'day', 'days', 'month', 'months', 'year', 'years',
  'hour', 'hours', 'minute', 'minutes',
]);

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

  // "one thirty", "nine fifteen", "four forty five", "eighteen thirty"
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const hour = wordFor(tokens[i]);
    if (hour === undefined || hour < 1 || hour > 23) continue;

    const nextToken = tokens[i + 1];
    const tens = nextToken === undefined ? undefined : TENS_WORDS[nextToken];
    let minute = nextToken === undefined ? undefined : tens ?? TEEN_WORDS[nextToken];
    if (minute === undefined || minute >= 60) continue;

    // "four forty five" is 4:45, not 4:40 — the unit word trailing a tens word
    // belongs to the minutes. Without this the minute silently truncates and
    // the caller is offered a time they did not say.
    if (tens !== undefined) {
      const unit = UNIT_WORDS[tokens[i + 2] ?? ''];
      if (unit !== undefined && unit > 0 && tens + unit < 60) minute = tens + unit;
    }

    // A 24-hour hour word ("eighteen thirty") already names one hour, so there
    // is no meridiem to resolve — same as digital 24-hour input above.
    if (hour > 12) return hour * 60 + minute;
    return resolveMeridiem(hour, minute, explicit);
  }

  // A bare hour: "one", "9", "nine o clock", "eighteen" (HOUR_WORDS includes
  // TEEN_WORDS, so plain 24-hour words reach here too — same as digital
  // 24-hour input above, already unambiguous and reported as-is).
  //
  // A number on its own is NOT evidence of a time. "In two weeks" and "in
  // three days" are quantities; reading them as 2 PM and 3 PM converts "I did
  // not understand you" into a confident wrong answer, and this module's null
  // return — the model's cue to ask again in its own words — is the only
  // safety valve the design has. So a number counts as an hour only when the
  // utterance supports it: a stated meridiem, an "o'clock", a preceding "at",
  // or nothing else numeric to compete with it. That last clause is what
  // keeps the ambiguity rule's headline case, a bare "three", working.
  const spokenNumbers = tokens.filter((token) => {
    const value = wordFor(token);
    return value !== undefined && value >= 1 && value <= 23;
  });

  for (let i = 0; i < tokens.length; i += 1) {
    const hour = wordFor(tokens[i]);
    if (hour === undefined || hour < 1 || hour > 23) continue;

    const next = tokens[i + 1];
    if (next !== undefined && DURATION_WORDS.has(next)) continue;

    const timeLike =
      explicit !== null ||
      next === 'oclock' ||
      (next === 'o' && tokens[i + 2] === 'clock') ||
      tokens[i - 1] === 'at' ||
      spokenNumbers.length === 1;
    if (!timeLike) continue;

    if (hour > 12) return hour * 60;
    return resolveMeridiem(hour, 0, explicit);
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

/** Does this civil date exist? Date.UTC rolls Feb 30 into March rather than failing. */
function isRealDate(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCMonth() + 1 === month && probe.getUTCDate() === day;
}

/**
 * A day-of-month spoken at `tokens[i]`, and how many tokens it used.
 *
 * `bareDigits` is off unless a month word is sitting next to the number:
 * "the twentieth" is a date, a naked "20" is an hour. The twenty-first through
 * thirty-first are compounds — ORDINAL_WORDS stops at "twentieth" — and
 * missing that would read "the twenty first" as the FIRST, a wrong date rather
 * than an unparsed one.
 */
function dayOfMonthAt(
  tokens: string[],
  i: number,
  bareDigits: boolean,
): { day: number; length: number } | null {
  const token = tokens[i];
  if (token === undefined) return null;

  const tens = TENS_WORDS[token];
  if (tens === 20 || tens === 30) {
    const unit = ORDINAL_WORDS[tokens[i + 1] ?? ''];
    if (unit !== undefined && unit <= 9) return { day: tens + unit, length: 2 };
  }

  const ordinal = ORDINAL_WORDS[token];
  if (ordinal !== undefined) return { day: ordinal, length: 1 };

  const suffixed = /^(\d{1,2})(st|nd|rd|th)$/.exec(token);
  if (suffixed !== null) return { day: Number(suffixed[1]), length: 1 };

  if (bareDigits && /^\d{1,2}$/.test(token)) return { day: Number(token), length: 1 };

  return null;
}

/**
 * Words that may follow a spoken day-of-month, plus end-of-utterance.
 *
 * An ordinal on its own is not evidence of a date — "first thing in the
 * morning", "in the second week" and "second opinion" all put an ordinal in
 * front of a noun it modifies. Without this gate those read as the 1st, the 2nd
 * and the 2nd, and the caller hears a date they never said. This is the same
 * positive-evidence shape `DURATION_WORDS` gives the bare-hour scan.
 *
 * Deliberately an allow-list, not a list of nouns to reject. The two failures
 * are not symmetric: a follower we forgot to allow returns null and the caller
 * is offered the next open times, while a noun we forgot to reject books them
 * into a month they never mentioned.
 */
const DAY_OF_MONTH_FOLLOWERS = new Set([
  'at', 'in', 'of', 'or', 'around',
  'morning', 'afternoon', 'evening', 'night',
  'am', 'pm',
  'please', 'works', 'then',
]);

/**
 * Is the ordinal at `i`, spanning `length` tokens, being used as a date?
 *
 * Only the IMMEDIATE next token is consulted. Scanning further would allow
 * "first thing in the morning" on the strength of its "in", which is exactly
 * the phrase this rejects.
 */
function readsAsDayOfMonth(tokens: string[], i: number, length: number): boolean {
  const next = tokens[i + length];
  return next === undefined || DAY_OF_MONTH_FOLLOWERS.has(next);
}

/** The soonest occurrence of a bare day-of-month: this month, else a later one. */
function nextDayOfMonth(today: ClinicDate, day: number): ClinicDate | null {
  for (let ahead = 0; ahead <= 12; ahead += 1) {
    const month = ((today.month - 1 + ahead) % 12) + 1;
    const year = today.year + Math.floor((today.month - 1 + ahead) / 12);
    if (ahead === 0 && day < today.day) continue;
    if (isRealDate(year, month, day)) return { year, month, day };
  }
  return null;
}

/** A named month and day within the coming year. */
function nextMonthDay(today: ClinicDate, month: number, day: number): ClinicDate | null {
  for (const year of [today.year, today.year + 1]) {
    if (year === today.year && month * 100 + day < today.month * 100 + today.day) continue;
    if (isRealDate(year, month, day)) return { year, month, day };
  }
  return null;
}

/**
 * A spoken calendar date, plus the token indexes it consumed.
 *
 * The consumption is the point. "August 20" must not also be read as 8 PM by
 * the time parser, and stripping the tokens a date has already claimed is a
 * cheaper guarantee than teaching the time parser about months.
 */
function parseCalendarDate(
  tokens: string[],
  today: ClinicDate,
): { date: ClinicDate; used: Set<number> } | null {
  const found = (from: number, day: { day: number; length: number }, monthIndex?: number) => {
    const used = new Set<number>();
    for (let n = 0; n < day.length; n += 1) used.add(from + n);
    if (monthIndex !== undefined) used.add(monthIndex);
    return used;
  };

  let namedAMonth = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const month = MONTH_WORDS[tokens[i] ?? ''];
    if (month === undefined) continue;
    namedAMonth = true;

    // "august 20", "august twentieth", "august twenty first".
    const adjacent = dayOfMonthAt(tokens, i + 1, true);
    if (adjacent !== null) {
      const date = nextMonthDay(today, month, adjacent.day);
      if (date !== null) return { date, used: found(i + 1, adjacent, i) };
      continue;
    }

    // "the twentieth of august" — bare digits are NOT accepted at a distance,
    // or "the fifth of august at 2" would read the 2 as the day.
    for (let j = 0; j < tokens.length; j += 1) {
      if (j === i) continue;
      const spelled = dayOfMonthAt(tokens, j, false);
      if (spelled === null) continue;
      // Naming a month is not licence to read every ordinal in the sentence:
      // "the second week of august" would otherwise resolve to August 2nd.
      if (!readsAsDayOfMonth(tokens, j, spelled.length)) continue;
      const date = nextMonthDay(today, month, spelled.day);
      if (date !== null) return { date, used: found(j, spelled, i) };
    }
  }

  // "the fifteenth" with no month at all. Skipped once a month HAS been named
  // and did not resolve: "February thirtieth" is a caller misspeaking, and
  // answering it with August 30th is worse than asking them again.
  if (namedAMonth) return null;

  for (let i = 0; i < tokens.length; i += 1) {
    const spelled = dayOfMonthAt(tokens, i, false);
    if (spelled === null) continue;
    if (!readsAsDayOfMonth(tokens, i, spelled.length)) continue;
    const date = nextDayOfMonth(today, spelled.day);
    if (date !== null) return { date, used: found(i, spelled) };
  }

  return null;
}

/** Spoken preference -> structured query, or null if nothing is recognisable. */
export function parseWhen(text: string, today: ClinicDate): WhenQuery | null {
  const t = clean(text);
  if (t.length === 0) return null;

  if (OPEN_REQUEST.test(t)) return { kind: 'any' };

  let date: ClinicDate | null = null;
  const tokens = t.split(' ');
  // What is left after a calendar date has claimed its words. A token cannot
  // be both the day of the month and the hour.
  let remaining = t;

  if (/\btomorrow\b/.test(t)) {
    date = addClinicDays(today, 1);
  } else if (/\btoday\b/.test(t)) {
    date = today;
  } else {
    for (const token of tokens) {
      const weekday = WEEKDAY_WORDS[token];
      if (weekday !== undefined) {
        // "next Tuesday" is the soonest Tuesday — see the test for why.
        date = nextWeekday(today, weekday);
        break;
      }
    }

    // A named weekday wins over a calendar date on purpose: "Monday the tenth"
    // said in a week whose tenth is a Thursday is a caller misremembering, and
    // the weekday is the part they are surer of.
    if (date === null) {
      const calendar = parseCalendarDate(tokens, today);
      if (calendar !== null) {
        date = calendar.date;
        remaining = tokens.filter((_, i) => !calendar.used.has(i)).join(' ');
      }
    }
  }

  const minutesOfDay = parseSpokenTime(remaining);
  if (minutesOfDay !== null) return { kind: 'time', date, minutesOfDay };

  // A daypart only counts when no specific time was found — "1 in the
  // afternoon" is a time, not a daypart.
  if (/\bmorning\b/.test(t)) return { kind: 'daypart', date, part: 'morning' };
  if (/\bafternoon\b|\bevening\b/.test(t)) return { kind: 'daypart', date, part: 'afternoon' };

  if (date !== null) return { kind: 'day', date };

  return null;
}
