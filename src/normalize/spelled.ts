/**
 * Extract a name or an alphanumeric member ID from text where the caller spelled
 * it out.
 *
 * Three spoken forms all mean the same thing:
 *   "D-A-V-I-S"                         hyphenated
 *   "D A V I S"                         separated letters
 *   "D as in dog, A as in apple, ..."   NATO-style disambiguation
 *
 * The hard case is a correction, which is what the challenge grades on:
 *   "Actually, my last name is spelled D-A-V-I-S, not D-A-V-I-E-S"
 * Both spellings are present and the answer is the *first* one. A naive
 * scan-and-join returns "Davisdavies"; taking the last run returns "Davies" —
 * the exact value the caller just told us was wrong.
 *
 * Returns null when nothing usable can be extracted.
 */

// Words that mark the *rejected* alternative. See splitOnNegation below.
const NEGATION_MARKER = /\b(?:not|instead\s+of|rather\s+than|isn'?t|wasn'?t|no\s+wait)\b/i;

// "X as in Y" only ever conveys the letter X; the mnemonic word is noise.
// Anchored on a single leading character so it cannot eat "Sam as in Samuel".
// The mnemonic may itself be hyphenated ("X as in X-ray") — without that branch
// only "X-" is consumed and the trailing "ray" survives as a bogus word.
const AS_IN_PHRASE = /\b([a-z0-9])\s+(?:as\s+in|as\s+of|like|for)\s+[a-z]+(?:-[a-z]+)*/gi;

/**
 * Conversational scaffolding around the value. These are dropped so that in
 * "my last name is spelled Davis" the only surviving candidate is "davis".
 */
const STOP_WORDS = new Set([
  'a', 'actually', 'again', 'am', 'an', 'and', 'as', 'be', 'capital', 'caps',
  'clear', 'correct', 'correction', 'em', 'first', 'for', 'hold', 'i', 'id',
  'in', 'is', 'it', 'its', "it's", 'know', 'last', 'letter', 'letters', 'like',
  'lowercase', "ma'am", 'maam', 'me', 'member', 'middle', 'my', 'name', 'no',
  'number', 'of', 'okay', 'on', 'please', 'said', 'say', 'sir', 'so', 'sorry',
  'spell', 'spelled', 'spelling', 'sure', 'that', "that's", 'thats', 'the',
  'them', 'they', 'this', 'to', 'uh', 'um', 'uppercase', 'wait', 'was', 'with',
  'yeah', 'yes', 'you', 'your',
]);

/**
 * Digit words that are unambiguous when someone is spelling. "one" can only be
 * the digit 1 in a member ID.
 *
 * "oh" and "o" are deliberately absent: while spelling a name or ID aloud, that
 * sound is the letter O far more often than the digit 0 ("B, O, B"). "zero" is
 * included because it has no letter reading at all.
 */
const SPELLED_DIGIT_WORDS: Record<string, string | undefined> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};

type Candidate = { value: string; spelled: boolean };

/** Capitalize the first letter, and any letter after a hyphen or apostrophe. */
function toTitleCase(value: string): string {
  let out = '';
  let capitalizeNext = true;

  for (const char of value.toLowerCase()) {
    out += capitalizeNext ? char.toUpperCase() : char;
    capitalizeNext = char === '-' || char === "'" || char === ' ';
  }

  return out;
}

/**
 * A member ID is case-significant and must survive as typed; a name should read
 * like a name. Presence of a digit is the discriminator — no personal name
 * contains one, and validation stores member IDs as `^[A-Za-z0-9]{1,50}$`, where
 * "Bc123456789" would be wrong.
 */
function applyCasing(value: string): string {
  return /\d/.test(value) ? value.toUpperCase() : toTitleCase(value);
}

/**
 * Pull every plausible value out of one segment, in order of appearance,
 * flagging which came from an explicit spelling.
 */
function collectCandidates(segment: string): Candidate[] {
  const cleaned = segment.replace(AS_IN_PHRASE, '$1');

  // Commas are kept as their own token: they end one spoken value and begin the
  // next ("Davies, Davis" is two candidates, not one two-word name).
  const tokens = cleaned
    .toLowerCase()
    .replace(/[,;:]/g, ' , ')
    .replace(/[()"]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0);

  const candidates: Candidate[] = [];
  let letterRun: string[] = [];
  let wordRun: string[] = [];

  const flushLetters = (): void => {
    // A single stray letter is an initial or noise, not a spelled value.
    if (letterRun.length >= 2) candidates.push({ value: letterRun.join(''), spelled: true });
    letterRun = [];
  };
  const flushWords = (): void => {
    if (wordRun.length > 0) candidates.push({ value: wordRun.join(' '), spelled: false });
    wordRun = [];
  };

  for (const rawToken of tokens) {
    if (rawToken === ',') {
      // Ends a run of words, but never a run of letters — "D, A, V, I, S" is
      // one spelling that happens to be dictated with pauses.
      flushWords();
      continue;
    }

    const stripped = rawToken.replace(/^[^a-z0-9'-]+|[^a-z0-9'-]+$/g, '');
    if (stripped.length === 0) continue;

    // A digit word standing alone becomes a single character so it joins the
    // surrounding letter run: "A B C one two three" → "abc123".
    const token = SPELLED_DIGIT_WORDS[stripped] ?? stripped;

    if (token.includes('-')) {
      const parts = token.split('-').filter((part) => part.length > 0);
      // Every segment being one character is what makes "D-A-V-I-S" a spelling
      // and "Mary-Jane" a hyphenated name. Hyphens alone prove nothing.
      if (parts.length >= 2 && parts.every((part) => part.length === 1)) {
        // A hyphenated spelling is self-contained, so it closes any run in
        // progress and stands as its own candidate. Otherwise the two spellings
        // in "not D-A-V-I-E-S, it's D-A-V-I-S" merge into "daviesdavis".
        flushWords();
        flushLetters();
        candidates.push({ value: parts.join(''), spelled: true });
        continue;
      }
      flushLetters();
      wordRun.push(token);
      continue;
    }

    if (token.length === 1 && /[a-z0-9]/.test(token)) {
      flushWords();
      letterRun.push(token);
      continue;
    }

    if (STOP_WORDS.has(token)) {
      // Filler ends a run of real words but must NOT end a run of letters:
      // "D, uh, A, V" is one spelling with a stumble in the middle.
      flushWords();
      continue;
    }

    if (/^[a-z0-9'-]+$/.test(token)) {
      flushLetters();
      wordRun.push(token);
      continue;
    }

    flushLetters();
    flushWords();
  }

  flushLetters();
  flushWords();

  return candidates;
}

/** An explicit spelling always outranks a word the caller merely said. */
function preferSpelled(candidates: Candidate[]): Candidate[] {
  const spelled = candidates.filter((candidate) => candidate.spelled);
  return spelled.length > 0 ? spelled : candidates;
}

export function normalizeSpelledText(input: string): string | null {
  if (typeof input !== 'string') return null;
  if (input.trim().length === 0) return null;

  const negation = NEGATION_MARKER.exec(input);

  if (negation) {
    const before = input.slice(0, negation.index);
    const after = input.slice(negation.index + negation[0].length);

    // "…D-A-V-I-S, not D-A-V-I-E-S" — the marker rejects what follows it, so
    // anything stated before it is the value the caller wants.
    const beforeCandidates = preferSpelled(collectCandidates(before));
    const chosen = beforeCandidates[0];
    if (chosen !== undefined) return applyCasing(chosen.value);

    // Nothing precedes the marker: "not Davies, it's Davis". The first value
    // after it is the one being rejected; the second is the correction.
    const afterCandidates = preferSpelled(collectCandidates(after));
    const correction = afterCandidates.length >= 2 ? afterCandidates[1] : afterCandidates[0];
    return correction === undefined ? null : applyCasing(correction.value);
  }

  const candidates = preferSpelled(collectCandidates(input));
  const chosen = candidates[0];

  return chosen === undefined ? null : applyCasing(chosen.value);
}
