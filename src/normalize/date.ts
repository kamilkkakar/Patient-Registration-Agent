/**
 * Normalize a spoken or typed date of birth to "MM/DD/YYYY".
 *
 * Deliberately does NOT reject future dates. "Not in the future" is a
 * *validation* rule (phase-2 handoff § 4.1) and belongs in the Zod schema; if
 * this layer swallowed it, a caller who misspoke their year would get a generic
 * "I didn't catch that" instead of a specific "that date is in the future".
 * Normalization canonicalizes shape; validation judges meaning.
 *
 * No `Date` object is constructed while parsing. Building a Date from local
 * components and reading it back in a negative-offset zone shifts the day —
 * the phase-2 handoff calls that "the highest-risk latent bug in the phase".
 * Everything here is string and integer arithmetic.
 *
 * Pure: no I/O. The only ambient read is the current date, needed to
 * disambiguate 2-digit years (see resolveYear).
 */

const MONTH_WORDS: Record<string, number | undefined> = {
  january: 1, jan: 1,
  february: 2, feb: 2, febuary: 2, // "febuary" is a common STT spelling
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sept: 9, sep: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const ORDINAL_WORDS: Record<string, number | undefined> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
};

const UNIT_WORDS: Record<string, number | undefined> = {
  zero: 0, oh: 0, o: 0,
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9,
};

const TEEN_WORDS: Record<string, number | undefined> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};

const TENS_WORDS: Record<string, number | undefined> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

// Conversational filler around a date. "of" is load-bearing: dropping it turns
// "the fifth of March" into "fifth March", which the day/month resolver reads.
const FILLER_WORDS =
  /\b(?:my|the|of|on|i|was|were|born|birthday|birthdate|date|birth|dob|is|are|in|it'?s|its|year|uh|um|like|about|around)\b/g;

const TENS_ALTERNATION = 'twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety';
const UNIT_ALTERNATION = 'one|two|three|four|five|six|seven|eight|nine';
const TEEN_ALTERNATION =
  'ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen';

// "nineteen eighty five" / "twenty oh five" — a year spoken as century + remainder.
const SPOKEN_YEAR = new RegExp(
  `\\b(nineteen|twenty)\\s+(` +
    `(?:oh|o|zero)\\s+(?:${UNIT_ALTERNATION})` +
    `|(?:${TENS_ALTERNATION})(?:\\s+(?:${UNIT_ALTERNATION}))?` +
    `|(?:${TEEN_ALTERNATION})` +
  `)\\b`,
  'g',
);

type NumberItem = { kind: 'num'; value: number; digits: string };
type MonthItem = { kind: 'month'; value: number };
type Item = NumberItem | MonthItem;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Days in month, with the full Gregorian leap rule (not just `% 4`). */
function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;

  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const max = daysInMonth[month - 1];
  if (max === undefined) return false;

  return day <= max;
}

/** Component-wise comparison against today's UTC date — no Date arithmetic. */
function isFutureDate(year: number, month: number, day: number): boolean {
  const now = new Date();
  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth() + 1;
  const nowDay = now.getUTCDate();

  if (year !== nowYear) return year > nowYear;
  if (month !== nowMonth) return month > nowMonth;
  return day > nowDay;
}

/**
 * Expand a 2-digit year. Four-digit years pass through untouched, including
 * future ones — rejecting those is validation's job, not ours.
 *
 * A 2-digit year is genuinely ambiguous: "eighty five" could be 1985 or 2085.
 * For a *date of birth* it cannot be 2085, because nobody has been born yet in
 * 2085. So we prefer the current century and roll back one century whenever
 * that reading lands in the future. In 2026 this maps 85 → 1985 and 25 → 2025,
 * which is what a caller means in both cases.
 */
function resolveYear(raw: number, month: number, day: number): number | null {
  if (raw >= 1000) return raw <= 9999 ? raw : null;
  if (raw < 0 || raw > 99) return null;

  const currentCentury = 2000 + raw;
  return isFutureDate(currentCentury, month, day) ? 1900 + raw : currentCentury;
}

function finalize(year: number, month: number, day: number): string | null {
  const resolvedYear = resolveYear(year, month, day);
  if (resolvedYear === null) return null;
  if (!isValidCalendarDate(resolvedYear, month, day)) return null;

  return `${pad2(month)}/${pad2(day)}/${String(resolvedYear).padStart(4, '0')}`;
}

/** Turn cleaned text into an ordered list of month markers and numbers. */
function tokenize(text: string): Item[] {
  const tokens = text.split(/[^a-z0-9]+/).filter((token) => token.length > 0);
  const items: Item[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;

    const month = MONTH_WORDS[token];
    if (month !== undefined) {
      items.push({ kind: 'month', value: month });
      continue;
    }

    if (/^\d+$/.test(token)) {
      // `digits` keeps the written width, which is how "0305" is told apart
      // from "35" further down. Number() alone would lose the leading zero.
      items.push({ kind: 'num', value: Number(token), digits: token });
      continue;
    }

    const teen = TEEN_WORDS[token];
    if (teen !== undefined) {
      items.push({ kind: 'num', value: teen, digits: String(teen) });
      continue;
    }

    const tens = TENS_WORDS[token];
    if (tens !== undefined) {
      // "eighty five" is 85, not 80 then 5.
      const next = tokens[i + 1];
      const unit = next === undefined ? undefined : UNIT_WORDS[next];
      if (unit !== undefined && unit !== 0) {
        items.push({ kind: 'num', value: tens + unit, digits: String(tens + unit) });
        i += 1;
      } else {
        items.push({ kind: 'num', value: tens, digits: String(tens) });
      }
      continue;
    }

    const unit = UNIT_WORDS[token];
    if (unit !== undefined) {
      items.push({ kind: 'num', value: unit, digits: String(unit) });
      continue;
    }

    // Unrecognised word — filler. Ignore it rather than failing the parse.
  }

  return items;
}

export function normalizeDateOfBirth(input: string): string | null {
  if (typeof input !== 'string') return null;

  const raw = input.trim();
  if (raw.length === 0) return null;

  // ISO fast path. Accepted because a reviewer curling the API reaches for it
  // first, and because slashes need percent-encoding in a query string.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (iso) {
    const [, isoYear, isoMonth, isoDay] = iso;
    if (isoYear === undefined || isoMonth === undefined || isoDay === undefined) return null;
    return finalize(Number(isoYear), Number(isoMonth), Number(isoDay));
  }

  let text = raw.toLowerCase();
  text = text.replace(/[,]/g, ' ');
  text = text.replace(FILLER_WORDS, ' ');

  // "5th" → "5", before word ordinals so both spellings converge.
  text = text.replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/g, '$1');

  // Compound ordinals ("twenty third", "thirty-first") must fold to one number
  // before the single-word pass, which would otherwise leave "twenty 3" — two
  // numbers where the caller said one, breaking the field count downstream.
  text = text.replace(
    /\b(twenty|thirty)[\s-]+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)\b/g,
    (_match, tensWord: string, unitWord: string) => {
      const tens = TENS_WORDS[tensWord];
      const unit = ORDINAL_WORDS[unitWord];
      if (tens === undefined || unit === undefined) return _match;
      return ` ${tens + unit} `;
    },
  );

  // "fifth" → "5".
  text = text.replace(/\b[a-z]+\b/g, (word) => {
    const ordinal = ORDINAL_WORDS[word];
    return ordinal === undefined ? word : String(ordinal);
  });

  // "nineteen eighty five" → "1985". Applied before tokenizing so the year
  // arrives as one 4-digit number instead of the pair (19, 85), which would be
  // indistinguishable from "day 19, year 85". The year reading is chosen because
  // it is overwhelmingly the more common thing a caller means.
  text = text.replace(SPOKEN_YEAR, (_match, century: string, remainder: string) => {
    const centuryValue = century === 'nineteen' ? 19 : 20;
    const rest = remainder.trim().split(/\s+/);

    let value = 0;
    for (const part of rest) {
      const teen = TEEN_WORDS[part];
      if (teen !== undefined) { value += teen; continue; }
      const tens = TENS_WORDS[part];
      if (tens !== undefined) { value += tens; continue; }
      const unit = UNIT_WORDS[part];
      if (unit !== undefined) value += unit;
    }

    return ` ${centuryValue * 100 + value} `;
  });

  const items = tokenize(text);
  const numbers: NumberItem[] = [];
  let month: number | null = null;

  for (const item of items) {
    if (item.kind === 'month') {
      if (month === null) month = item.value;
    } else {
      numbers.push(item);
    }
  }

  // --- Path A: an explicit month name is present ---
  if (month !== null) {
    if (numbers.length !== 2) return null;
    const [first, second] = numbers;
    if (first === undefined || second === undefined) return null;

    // Whichever number cannot be a day-of-month is the year. Covers
    // "March 5 1985", "5 March 1985" ("the fifth of March..."), and "March 5 85".
    let day: number;
    let year: number;
    if (first.digits.length === 4 || first.value > 31) {
      year = first.value;
      day = second.value;
    } else {
      day = first.value;
      year = second.value;
    }

    return finalize(year, month, day);
  }

  // --- Path B: three separate numbers, e.g. "3 5 85" or "02/15/1992" ---
  if (numbers.length === 3) {
    const [first, second, third] = numbers;
    if (first === undefined || second === undefined || third === undefined) return null;

    if (first.digits.length === 4 || first.value > 31) {
      // Year-first ordering (YYYY MM DD).
      return finalize(first.value, second.value, third.value);
    }

    // US MM/DD ordering only. Day-first input ("15/03/85") is deliberately NOT
    // re-ordered into 03/15/85: silently reinterpreting a date yields a
    // plausible-looking but wrong DOB in a medical record, which is strictly
    // worse than returning null and having the agent ask once more.
    return finalize(third.value, first.value, second.value);
  }

  // --- Path C: a run of digits with no separators the parser can trust ---
  // "oh three oh five eighty five" arrives as 0,3,0,5,85 — five numbers, not
  // three — so the fields are recovered by width instead of by position.
  const joined = numbers.map((n) => n.digits).join('');
  if (joined.length === 6 || joined.length === 8) {
    return finalize(
      Number(joined.slice(4)),
      Number(joined.slice(0, 2)),
      Number(joined.slice(2, 4)),
    );
  }

  return null;
}

/**
 * Parse a SPOKEN date of birth to a UTC-midnight `Date`, the form Prisma wants
 * for a `@db.Date` column.
 *
 * `Date.UTC` is mandatory here: `new Date(1992, 1, 15)` is local midnight, which
 * serializes to the previous day in any negative-offset zone.
 *
 * This is the VOICE ingress parser and it is deliberately permissive — it takes
 * "the fifth of March nineteen eighty five" and "2/15/1992" alike. The REST
 * boundary must NOT use it: a typed API client sending "2/15/1992" is required
 * to get a 422, so `src/validation/patient.ts` imports `parseDobStrict` from
 * `src/lib/serialize.ts` instead.
 *
 * Both functions were once called `parseDobInput`. They are named apart now
 * precisely so this import can never be made by accident.
 */
export function parseSpokenDob(input: string): Date | null {
  const normalized = normalizeDateOfBirth(input);
  if (normalized === null) return null;

  const parts = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(normalized);
  if (!parts) return null;

  const [, month, day, year] = parts;
  if (month === undefined || day === undefined || year === undefined) return null;

  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

/**
 * Format a stored date back to the wire format "MM/DD/YYYY", reading UTC parts.
 *
 * Re-exported, not reimplemented. `src/lib/serialize.ts` owns the DB <-> wire
 * transform, and a second copy here is how the two halves drift apart.
 *
 * This module stays pure despite the new import: serialize.ts takes nothing
 * from @prisma/client but a type, which is erased at compile time, so no
 * runtime dependency is pulled in.
 */
export { formatDob } from '../lib/serialize.js';
