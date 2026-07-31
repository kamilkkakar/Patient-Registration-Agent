// The exact accepted set for the `state` field: 50 states + DC + the five
// inhabited U.S. territories (USPS abbreviations).
//
// Lives in its own module so the Phase 3 voice normalizer ("Texas" -> "TX")
// imports this list rather than defining a second, drifting copy.

export const US_STATES: readonly string[] = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  // District of Columbia
  'DC',
  // Inhabited territories: American Samoa, Guam, Northern Mariana Islands,
  // Puerto Rico, U.S. Virgin Islands.
  'AS', 'GU', 'MP', 'PR', 'VI',
];

/** Membership test in O(1); the array above stays the readable source. */
export const US_STATE_SET: ReadonlySet<string> = new Set(US_STATES);
