/**
 * Voice-input normalization layer.
 *
 * Speech-to-text produces text a human said out loud, not clean form input.
 * Every function here takes a loose spoken string and returns either the
 * canonical stored form or null. They are pure — no I/O, no Prisma, no HTTP —
 * and they normalize *shape* only. Judging whether a normalized value is
 * acceptable (future DOB, non-NANP area code) belongs to `src/validation/`.
 */

export { normalizePhone } from './phone.js';
// `parseSpokenDob`, not `parseDobInput`: the strict REST-boundary parser in
// `src/lib/serialize.ts` is `parseDobStrict`. The two used to share a name.
export { normalizeDateOfBirth, parseSpokenDob, formatDob } from './date.js';
export { normalizeEmail } from './email.js';
export { normalizeZip } from './zip.js';
export { normalizeState } from './state.js';
export { normalizeSpelledText } from './spelled.js';
