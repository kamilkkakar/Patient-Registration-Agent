/**
 * Normalize a spoken or typed U.S. state to its 2-letter USPS code.
 *
 * Callers say the full name ("California"), the code ("C A"), or something in
 * between ("Washington State"). Returns null for anything that is not a real
 * U.S. state, DC, or territory.
 *
 * NOTE for whoever owns `src/validation/`: the phase-2 handoff § 4.2 puts the
 * canonical `US_STATES` const in `src/validation/us-states.ts`. That file does
 * not exist yet and this module may not create it, so the set below is
 * self-contained. It is a superset-equal of § 4.2 (50 + DC + AS GU MP PR VI).
 * Collapse the two into one list once validation lands.
 */

const STATE_NAMES: Record<string, string | undefined> = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',

  // District and territories.
  'district of columbia': 'DC',
  'puerto rico': 'PR',
  'american samoa': 'AS',
  guam: 'GU',
  'northern mariana islands': 'MP',
  'northern marianas': 'MP',
  'virgin islands': 'VI',
  'us virgin islands': 'VI',
  'u s virgin islands': 'VI',
};

const VALID_CODES = new Set<string>(
  Object.values(STATE_NAMES).filter((code): code is string => code !== undefined),
);

/**
 * Spoken forms that mean the District of Columbia. Matched *before* the plain
 * name lookup: "Washington DC" would otherwise fall through to "washington"
 * and silently resolve to WA — a wrong-but-valid state, the worst kind of bug
 * because nothing downstream rejects it.
 */
const DC_FORMS = new Set([
  'dc',
  'd c',
  'washington dc',
  'washington d c',
  'district of columbia',
  'the district of columbia',
  'washington district of columbia',
]);

export function normalizeState(input: string): string | null {
  if (typeof input !== 'string') return null;

  // Periods go first so "D.C." and "Wash." reduce to bare words; commas because
  // callers dictate "Austin, Texas" into a single field.
  let text = input
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length === 0) return null;

  if (DC_FORMS.has(text)) return 'DC';

  // A code read aloud arrives as separated letters ("T X", "N Y"). Join runs of
  // single letters back together; no state *name* is spelled that way, so this
  // cannot swallow a real name.
  if (/^[a-z]( [a-z])+$/.test(text)) text = text.replace(/ /g, '');

  // Already a code. Checked before the trailing-"state" strip so the code "MS"
  // is never confused with a name suffix.
  if (/^[a-z]{2}$/.test(text)) {
    const upper = text.toUpperCase();
    return VALID_CODES.has(upper) ? upper : null;
  }

  // "Washington State" and "State of Washington" both mean the state, as
  // opposed to the city. Strip the qualifier and fall through to the name map.
  text = text.replace(/^state of\s+/, '').replace(/\s+state$/, '').trim();

  if (DC_FORMS.has(text)) return 'DC';

  return STATE_NAMES[text] ?? null;
}
