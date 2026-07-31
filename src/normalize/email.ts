/**
 * Normalize a spoken email address.
 *
 * Nobody says "@" out loud, so STT gives us "kamil at gmail dot com". Callers
 * also spell the local part letter by letter ("k a m i l at gmail dot com"),
 * which arrives as space-separated single characters.
 *
 * Returns null when no plausibly-shaped address results. Deliverability is not
 * checked — that is not knowable offline, and validation applies its own rule.
 */

// Lead-ins a caller uses before the address itself.
const LEAD_IN = /^\s*(?:(?:my|the)\s+)?(?:e[-\s]?mail(?:\s+address)?\s*(?:is|:)?\s*|it'?s\s+|its\s+|address\s+is\s+)/i;

/**
 * Repairs for the four domains that account for nearly all consumer email, in
 * the shapes STT actually produces. The dominant failure is a dropped "dot"
 * ("kamil at gmail com" → "gmailcom"); the rest are phonetic near-misses.
 *
 * Applied to the domain only. Repairing the whole string would corrupt a local
 * part that legitimately contains one of these substrings (e.g. "gmailteam@…").
 */
const DOMAIN_REPAIRS: Record<string, string | undefined> = {
  gmailcom: 'gmail.com',
  'gmai.com': 'gmail.com',
  'gmial.com': 'gmail.com',
  'gmal.com': 'gmail.com',
  'gmail.co': 'gmail.com',
  'gmail.comm': 'gmail.com',
  'gemail.com': 'gmail.com',
  'googlemail.com': 'gmail.com',
  'g-mail.com': 'gmail.com',

  hotmailcom: 'hotmail.com',
  'hotmale.com': 'hotmail.com',
  'hotmial.com': 'hotmail.com',
  'hotmil.com': 'hotmail.com',
  'hotmail.co': 'hotmail.com',

  yahoocom: 'yahoo.com',
  'yaho.com': 'yahoo.com',
  'yahu.com': 'yahoo.com',
  'yahoo.co': 'yahoo.com',
  'ya-hoo.com': 'yahoo.com',

  outlookcom: 'outlook.com',
  'outlok.com': 'outlook.com',
  'outllok.com': 'outlook.com',
  'outlook.co': 'outlook.com',
  'out-look.com': 'outlook.com',
};

// Local part, then a domain that must contain a dot and end in a >=2 letter TLD.
const EMAIL_SHAPE =
  /^[a-z0-9](?:[a-z0-9._%+-]*[a-z0-9])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

export function normalizeEmail(input: string): string | null {
  if (typeof input !== 'string') return null;

  let text = input.toLowerCase().trim();
  if (text.length === 0) return null;

  text = text.replace(LEAD_IN, '');

  // Spoken punctuation → real punctuation. Each replacement is padded with
  // spaces so tokens stay separated; all whitespace is stripped afterwards,
  // which is also what re-joins letter-by-letter spelling ("k a m i l" →
  // "kamil") and split-up domains ("g mail" → "gmail") with no extra logic.
  // \b guards keep these from firing inside words: "dotty" keeps its "dot",
  // "format" keeps its "at".
  text = text.replace(/\b(?:at\s+sign|at\s+symbol|atsign|at)\b/g, ' @ ');
  text = text.replace(/\b(?:dot|period|point|full\s+stop)\b/g, ' . ');
  text = text.replace(/\b(?:underscore|under\s+score)\b/g, ' _ ');
  text = text.replace(/\b(?:dash|hyphen|minus)\b/g, ' - ');
  text = text.replace(/\bplus\b/g, ' + ');

  // Strip whitespace and any leftover characters an address cannot contain
  // (stray commas, quotes, terminal question marks from the transcript).
  let joined = text.replace(/\s+/g, '').replace(/[^a-z0-9@._%+-]/g, '');

  // Sentence-final punctuation clings to the TLD: "…gmail.com." → "…gmail.com".
  joined = joined.replace(/^[.]+/, '').replace(/[.]+$/, '');

  const parts = joined.split('@');
  if (parts.length !== 2) return null;

  const local = parts[0];
  const domain = parts[1];
  if (local === undefined || domain === undefined) return null;
  if (local.length === 0 || domain.length === 0) return null;

  const repairedDomain = DOMAIN_REPAIRS[domain] ?? domain;
  const candidate = `${local}@${repairedDomain}`;

  return EMAIL_SHAPE.test(candidate) ? candidate : null;
}
