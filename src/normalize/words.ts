// Number and month vocabulary shared by the date-of-birth parser and the
// appointment "when" parser.
//
// Extracted rather than duplicated: two copies of a spoken-number table drift,
// and the failure would be a caller whose "fifteenth" parses in one place and
// not the other. Moving it is why the DOB suite must pass UNCHANGED.

export const MONTH_WORDS: Record<string, number | undefined> = {
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

export const ORDINAL_WORDS: Record<string, number | undefined> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
};

export const UNIT_WORDS: Record<string, number | undefined> = {
  zero: 0, oh: 0, o: 0,
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9,
};

export const TEEN_WORDS: Record<string, number | undefined> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};

export const TENS_WORDS: Record<string, number | undefined> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

export type NumberItem = { kind: 'num'; value: number; digits: string };
type MonthItem = { kind: 'month'; value: number };
export type Item = NumberItem | MonthItem;

/** Turn cleaned text into an ordered list of month markers and numbers. */
export function tokenize(text: string): Item[] {
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
