// Clinic configuration. Constants, not a database table: there is one clinic,
// and a config row nothing can edit is a table pretending to be a constant.

/** IANA zone. The demo number is a Mississippi area code — Central. */
export const CLINIC_TIMEZONE = 'America/Chicago';

/** Clinic-local minutes past midnight. Last appointment starts at 16:30. */
export const OPEN_MINUTES = 9 * 60;
export const CLOSE_MINUTES = 17 * 60;

export const SLOT_MINUTES = 30;

/**
 * How far ahead availability is searched. A constant, NOT something the model
 * chooses: two weeks is far enough that a fully-booked week still yields an
 * answer, and short enough that one query stays small.
 */
export const SEARCH_WINDOW_DAYS = 14;

/** Never read more than this many times aloud (§ G14 — the token budget). */
export const MAX_OFFERED_SLOTS = 3;
