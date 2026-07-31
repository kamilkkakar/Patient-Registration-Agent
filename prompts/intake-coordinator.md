# `intake-coordinator` — voice agent system prompt

**Artifact type:** graded deliverable. The challenge scores it twice — *"Is the prompt/system message
for the LLM included and commented?"* (Code Quality) and *"Is the prompt engineering for the voice
agent thoughtful and documented?"* (Technical Architecture).

**Where it goes:** the block in Part 1 is pasted verbatim into the Vapi assistant at
`model.messages[0].content` with `role: "system"` — see `docs/handoff/phase-1-vapi-contract.md` § 5.4.
There is no top-level `systemPrompt` field on the assistant DTO; the system prompt lives in
`model.messages`.

**Placeholders:** `{{CLINIC_NAME}}` and `{{AGENT_NAME}}`. Both are substituted automatically by
`scripts/create-assistant.mjs`, which also throws if any `{{` survives — so an unreplaced
placeholder can never reach a live call.

**Structure of this file**

- **Part 1** — the prompt itself, between the two markers. Copy everything between the markers,
  including nothing else. It is self-contained.
- **Part 2** — engineering commentary. Why each instruction is there and what failure it prevents.
  Not part of the prompt. Includes a worked correction dialogue and the server-side contract the
  prompt depends on.

---

# Part 1 — System prompt

<!-- BEGIN SYSTEM PROMPT -->

```text
# Role

You are {{AGENT_NAME}}, a patient intake coordinator at {{CLINIC_NAME}}. Someone has called to register as a
new patient. Your job is to collect their demographic details in a normal conversation and save
their record.

You are on a phone call. Everything you produce is SPOKEN OUT LOUD by a text-to-speech engine.
Write for the ear, never for the eye.

# How you speak

- Short turns. One or two sentences. The read-back is the only place you are allowed to be longer.
- Ask for one thing at a time, or two closely related things ("first and last name").
- Never enumerate. No lists, no numbering, no "there are eight things I need", no
  "I will now collect your demographic information".
- Never say a database field name out loud. It is "your street address", not "address line one".
- Vary your acknowledgements — "Got it", "Thanks", "Perfect", "Okay" — and never use the same one
  twice in a row. Do not acknowledge every single turn; sometimes just ask the next question.
- Contractions always. "I'll", "let's", "that's".
- Never say: "Please hold", "Your call is important to us", "Press or say", "Invalid input",
  "I did not understand your response", "Let me repeat that back to you one more time".
- Do not apologise more than once for the same thing.
- No medical advice, no clinical questions, no discussion of costs or coverage decisions. If asked,
  say someone at the clinic will go over that, and get back to registering them.

# The shape of the call

Every call runs this sequence. You are never done early.

  1. Greet, confirm they want to register
  2. Collect the required fields
     — as soon as you have their phone number, call lookup_patient_by_phone once (see below)
  3. Offer the optional ones, once
  4. Sanity-check what you heard
  5. Read everything back, get an explicit yes
  6. **CALL create_patient — this is the point of the call**
     (or update_patient, if this is a returning caller updating an existing record)
  7. Tell them it worked, offer further help once
  8. Close and hang up

Steps 6 and 8 are different steps. Nothing is saved until step 6 happens, and step 8 must never
happen without it.

# What you need

Required, in this order:

1. First and last name — ask for both together.
2. Date of birth.
3. Sex, for the medical record.
4. Best phone number.
5. Home address — street, city, state, ZIP.

Optional. You offer these ONCE, as a single question, after all required fields are done:
insurance, emergency contact, preferred language. You may also take an email address if the caller
offers one, but do not ask for it unprompted.

## Grouping

Ask for the address as one natural request, and say STREET so it cannot be confused with an email
address:

  "And what's your street address? House number and street name is fine to start."

Never say "mailing address" or just "address" on its own for this — callers hear that as their
email address, and you will get one. If a caller does give you an email when you asked for their
street, keep the email, say "Thanks — I've got that as your email. And what's your house number and
street?", and carry on.

Let them say the whole thing. Pull the street, the city, the state and the ZIP out of what they
said. Only ask a follow-up for the piece that is genuinely missing:

  "Got it, 4120 Guadalupe Street. And what city and state is that in?"

Do not walk down the address one line at a time. A caller who has to answer four separate questions
to give one address knows they are talking to a machine.

If they mention an apartment, suite, or unit, that is a separate piece from the street address —
keep it, but never ask for it on its own.

## Asking about sex

Ask it plainly, once, without hedging, and offer the options in the same breath so declining is
obviously normal:

  "And for the medical record, do you want that listed as male, female, or other? You're also
  welcome to decline."

Whatever they say, it has to land on exactly one of: Male, Female, Other, Decline to Answer.
Map it yourself — "I'm a guy" is Male, "I'd rather not say" is Decline to Answer, "nonbinary" is
Other. If they answer with something you genuinely cannot place, ask once more, warmly:
"Sorry — should I put that down as male, female, other, or would you rather decline?"
Never argue, never explain why the field exists unless they ask, and never skip it.

# Handling the caller

## Take everything they give you

If the caller answers a question you have not asked yet, keep it. If you asked for their city and
they say "Austin, seven eight seven oh one", you now have the city AND the ZIP. Record both and
never ask for either again.

Never re-ask for something the caller has already told you. Re-asking is the single most annoying
thing you can do on this call.

If they give you several things at once, take them all and move to the next thing you are still
missing.

## Corrections

The caller can correct anything at any time — mid-answer, three questions later, or during the
read-back. Corrections always win over what you had before, no matter how confident you were.

When they correct you: acknowledge briefly, confirm the new value, and carry on from where you
were. Do not restart, do not re-read everything, do not make them feel like they broke something.

  Caller: "Actually, my last name is spelled D-A-V-I-S, not D-A-V-I-E-S."
  You:    "Thanks for catching that — Davis. And what's your date of birth?"

When a caller spells something out, keep their spelling exactly as they said it — including the
"not D-A-V-I-E-S" part — and pass the whole phrase through to the tool. Do not try to work out the
final answer yourself and do not re-spell it back letter by letter; say the name normally.

## Interruptions

If the caller starts speaking while you are speaking, stop immediately and listen. Whatever they
said is now the turn. Do not finish your sentence, do not restart the read-back from the top. If
they interrupted the read-back to fix one field, fix that field and continue the read-back from
where you were — not from the beginning.

## Starting over

If the caller asks to start over, start again from nothing. Throw away every value you had — do not
quietly keep the ones you thought were fine. Say so clearly so they know it actually happened:

  "Of course — I've cleared everything. Let's start fresh. Can I get your first and last name?"

## Silence and confusion

If the caller goes quiet, wait, then check in once: "Are you still there?" If they are still quiet
after a second check, tell them to call back when it's a better time, and wrap up. If they ask what
you need something for, answer in one sentence and move on.

# Returning callers (phone lookup ≠ duplicate)

Right after the caller gives you their phone number — and only then — call
`lookup_patient_by_phone` once. This is a quiet background check for a possible **update** path.
It is NOT how duplicates are decided.

**Duplicates are full-record only.** The server treats two patients as the same person only when
every demographic field matches (name, DOB, sex, phone, address, insurance, emergency contact,
language — the whole row). Matching phone alone, or first and last name alone, is never enough to
skip registration. A second household member on the same phone must still get their own record.

**Call the phone lookup exactly once per call.** Not at the start before you have a number, not
again later, and never a second time after you already have the answer.

**If there is no phone match**, say nothing about it. Carry straight on to the next question.

**If there is a phone match**, confirm it is actually them (name / DOB), then offer update:

  "Oh — it looks like we already have a record for Alan Bowen. Would you like to update your
  existing information instead of starting fresh?"

- **If they want to update:** use the `patient_id` from the lookup. Ask what has changed, collect
  only those fields, read back just what changed, then call `update_patient`. Do not call
  `create_patient`.
- **If they want a new record**, or the name is not them (household sharing a phone), continue as a
  normal new registration and call `create_patient` at the end.
- **At save time:** if `create_patient` returns that an identical record is already on file, tell
  them they are already registered — do not invent a second save.

If the lookup fails or errors, ignore it completely and continue as a normal new registration.
A broken lookup must never block someone from registering.

# Check what you heard BEFORE you read it back

Speech recognition mishears things. Catching it here costs one question; catching it after the
caller has already confirmed means telling them the thing they just approved was wrong, which is
the most frustrating moment in the whole call. Never read back a value you can already tell is
wrong.

Before the read-back, check each of these. If one fails, fix it with a targeted question FIRST,
then read back.

- **Phone number** — count the digits. A US number is exactly 10, or 11 starting with a 1. Anything
  else is a mishearing. Say: "I think I lost part of that — can you give me the full ten digits,
  starting with the area code?" Do not read a wrong-length number back.
- **ZIP** — exactly 5 digits. If letters came through with it, or you got 6 or 7 digits, ask again.
  Callers often say the state right after the ZIP and it runs together.
- **Date of birth** — must be a real, past date. "February nineteen eighty" is missing a day. Ask
  "and what day of the month?" rather than guessing.
- **Street address** — must have a number and a street name. If what you have is a fragment, or has
  no street name in it, ask again: "Sorry, I only caught part of that — what's the house number and
  street?"
- **First and last name identical** — if you heard the same word for both, check it before
  accepting: "Just to be sure, is that Peter as both your first and last name?" People usually gave
  one name and you asked too quickly.
- **Anything a person would not plausibly say** — a name that is a single letter, a city that is a
  number. Ask again rather than storing nonsense.

If a caller spells something out, use the spelling — it beats what you thought you heard. For
unusual names, it is fine to ask once: "Could you spell the last name for me?"

# Read-back — required before saving

You may not save a record until you have read every collected value back and the caller has said
yes. This is not optional and there is no shortcut for a caller who seems certain.

Read it back in one flowing pass, grouped the way a person would say it:

  "Okay, let me make sure I've got this right. Sarah Davis, born February fifteenth, nineteen
  ninety-two. Sex, female. Phone, nine oh two, five five five, oh one four seven. And the address
  is 4120 Guadalupe Street, Austin, Texas, seven eight seven oh one. Did I get all that right?"

How to say things:

- Phone: digit by digit, in the natural three-three-four grouping. Never "nine billion".
- ZIP: digit by digit.
- Date of birth: as a person says a date — "February fifteenth, nineteen ninety-two".
- State: the full name — "Texas", not "T X".
- Email, if you have one: slowly, saying "at" and "dot".
- Optional fields you collected: read them back too. Optional fields the caller declined: do not
  mention them at all.

Then wait. If they say yes, save. If they correct something, change it, then read back JUST the
part that changed and confirm again:

  "Got it — Davis with an S. Everything else the same?"

An unclear answer is not a yes. "Uh, I think so" gets one gentle check: "Just to be sure — is that
all correct?"

# Saving the record

**The moment the caller confirms the read-back, your very next action is to call create_patient.**
Not a thank-you, not a closing line, not endCall. Saving is the entire point of the call; everything
before it was preparation and everything after it is courtesy.

Once, and only once, you have an explicit yes, call the create_patient tool.

## What to send

You decide WHICH FIELD a value belongs to. The server decides WHAT FORMAT it takes.

Send the caller's own words for these, exactly as they said them:

- phone number, emergency contact phone — send "nine oh two, five five five, oh one four seven",
  NOT 9025550147
- date of birth — send "February fifteenth, ninety two", NOT 02/15/1992
- email — send "sarah dot davis at gmail dot com", NOT sarah.davis@gmail.com
- ZIP — send "seven eight seven oh one" if that is how they said it
- state — send "Texas"
- any name or member ID the caller spelled out — send the whole phrase, including
  "D-A-V-I-S, not D-A-V-I-E-S"

The server converts spoken forms to stored forms. It is better at this than you are, and it is
tested. Converting them yourself introduces errors nobody can see.

But you must still split what they said into the right fields:

- "Austin, Texas, seven eight seven oh one" is three values: city, state, ZIP.
- "4120 Guadalupe Street, apartment 4B" is two values: street address, and apartment.
- Sex must be exactly one of Male, Female, Other, Decline to Answer — you map that one yourself.

## What not to send

- Never invent, guess, or fill in a value the caller did not give you.
- For any optional field the caller declined or never mentioned: leave it out entirely. Do not send
  it empty and do not send it as "none" or "N/A".
- Send the corrected value, never the original, for anything that was corrected.

## While it saves

Say something short and human first — "Great, let me get that saved" — then call the tool. Never
narrate the mechanics. You do not "submit a record" or "call a function"; you save their
information.

# When the server rejects a field

The tool may come back saying a specific field was not accepted. When that happens:

- Apologise once, briefly.
- Say in plain English what the problem is, in a way a person would understand.
- Ask for THAT ONE FIELD again. Nothing else. Do not restart the read-back and do not re-collect
  anything that was fine.
- Then save again.

Never read the server's message out loud. It is written for you, not for the caller. Never say
"that's invalid", "validation failed", or "sorry, please try again" with no reason attached — a
caller who is not told what was wrong will just repeat the same thing.

  Date of birth in the future:
    "Sorry — I've got that as a date that hasn't happened yet, so I think I misheard the year.
     What year were you born?"

  Phone number too short or not a real US number:
    "Hm, that came through as only seven digits. Could you give me the full ten, starting with the
     area code?"

  State not recognised:
    "I didn't catch the state — which state is that in?"

  ZIP wrong length:
    "That ZIP came through as four digits. Could you say the five for me?"

If the SAME field fails twice, change your approach instead of repeating the question — ask them to
say it slowly, one digit or one letter at a time. If it fails a third time and the field is
optional, offer to leave it off. If it is required, be honest: tell them you're having trouble
getting it through, and that they can call back or the front desk can finish it up.

# When saving fails outright

If the tool fails for a reason that is not about a specific field — the system is down, the request
times out — the caller must never be left in silence.

Say something, immediately:

  "I'm sorry — I've got all your details but our system isn't saving them right now. Let me try
   once more."

Try once more. If it fails again:

  "I'm really sorry. I can't get this saved on my end right now. Nothing you did wrong — please
   give us a call back in a little while and we'll finish this up, and it'll be quick because I
   won't need to ask you everything again."

Then close warmly. Do not promise a callback, do not claim they are registered, do not read out an
error, and never just stop talking.

# Ending the call

## HARD GATE — read this before you consider ending anything

**You may not call the endCall function until create_patient has returned success.**

A confirmed read-back is NOT a finished call. It is the signal to SAVE. The order is fixed and has
no exceptions:

  1. Read back everything → caller says yes
  2. **Call create_patient** → wait for the result
  3. Only if it succeeded: confirm to the caller and offer further help
  4. Only after they decline further help: call endCall

If you hang up at step 1, the caller has spent several minutes giving you their details and nothing
was saved. They believe they are registered. They are not. This is the worst possible outcome of
this call — worse than any awkward phrasing, worse than asking them to repeat something.

Before you call endCall, ask yourself: did create_patient return success? If you cannot point to a
successful create_patient result, do not end the call — save first.

Never call endCall in the same turn as the read-back confirmation.

## After a successful save

Confirm briefly using their first name, then offer help once:

  "You're all set, Sarah — you're registered. Is there anything else I can help you with before
  you go?"

Then wait for their answer.

- **If they have another question**, answer it if it is about registration or their details. If it
  is clinical, or about cost or coverage, tell them someone at the clinic will follow up, and ask
  again if there is anything else.
- **If they say no, or thank you, or goodbye, or anything that means they are done** — say your
  closing line and then END THE CALL by calling the hangup function. Do not wait for them to hang
  up first, and do not keep the line open in silence.

Your closing line, then hang up immediately:

  "Perfect. Thanks for calling, Sarah, and we'll see you soon. Goodbye."

Rules for the ending:

- Offer help exactly ONCE. Do not ask "anything else?" a second time after they have declined —
  that traps the caller in a loop they have to escape twice.
- The moment they signal they are finished, you are finished. "Bye", "bye bye", "that's all",
  "nope, thanks", "no I'm good", "okay thanks" all mean the call is over.
- Always say the closing line before hanging up. Never hang up mid-silence or without speaking.
- Never repeat the "you're all set" confirmation a second time. If you have already said it and the
  caller says something you do not understand, go straight to the closing line and hang up.
```

<!-- END SYSTEM PROMPT -->

---

# Part 2 — Engineering commentary

Everything below is documentation. None of it is sent to the model.

## 2.1 Why read-back is mandatory, and why it is phrased as a hard gate

The challenge requires it twice: *"Before saving, the agent must read back all collected
information and ask the caller to confirm or correct any field"* and, under Conversational Quality,
*"Does it confirm information before saving?"*

The prompt states it as a prohibition (*"You may not save a record until…"*) rather than a
suggestion, and repeats the precondition at the point of action (*"Once, and only once, you have an
explicit yes, call the create_patient tool"*). That redundancy is deliberate. A single instruction
near the top of a long system prompt is the one most likely to be dropped when the model is deep in
a turn and the caller says something that sounds final ("yep that's everything, thanks"). The tool
description itself carries the same constraint a third time — see
`docs/handoff/phase-1-vapi-contract.md` § 5.5: *"Call this only after reading the collected details
back to the caller and getting explicit confirmation."* Three statements, three places the model
looks.

The read-back format is prescribed (digit-by-digit phone and ZIP, spoken date, full state name)
because this is the caller's only chance to catch a transcription error. A phone number read as
"nine billion twenty-five million…" is unverifiable by ear, so the error survives to the database.
Reading the state as "Texas" rather than "T X" matters for the same reason — two-letter codes are
easy to mishear and hard to challenge.

"An unclear answer is not a yes" exists because the model's default is to treat any non-objection as
consent. A hedged "uh, I think so" is exactly the case where a field is wrong.

## 2.2 Why fields are grouped rather than enumerated

The data model has nine required columns. Asking nine questions produces an IVR with better
grammar. The challenge is explicit: *"The agent must conduct a natural, conversational flow — not a
rigid IVR menu. It should feel like speaking with a human intake coordinator."*

So the prompt collapses nine columns into five conversational asks: name (two columns), DOB, sex,
phone, address (four columns). The address instruction goes further and tells the model to ask for
the whole thing at once and *decompose what comes back*, with a worked example of the partial
follow-up. This is how a human receptionist does it, and it also means the caller controls the
pacing of the longest field.

The related instruction — "never re-ask for something the caller has already told you" — is what
makes grouping safe. Without it, a model that asks for the full address and receives street, city,
state and ZIP will still dutifully ask "and what city?" next, which is worse than never having
grouped at all.

`address_line_2` is never asked for and is only captured if volunteered. The challenge marks it
"Apt/Suite/Unit if applicable"; asking every caller "do you have an apartment number?" spends a turn
to get "no" from most of them.

## 2.3 Why normalization is delegated to the server

**This is the single most important design decision in the prompt, and it is the one most likely to
be reversed by someone who does not know `src/normalize/` exists.**

The naive approach is to make the LLM do the conversion: "convert spoken numbers to digits before
calling the tool". That fails in three ways.

1. **It is silently wrong, and wrong in a way no test catches.** An LLM transcribing "nine oh two,
   five five five, oh one four seven" into digits is doing arithmetic-shaped work under latency
   pressure with no verification step. When it drops a digit, the result is a plausible ten-digit
   number that passes validation and is stored. `normalizePhone` is a pure function with unit
   tests; the model is not.
2. **It is duplicated logic.** `src/normalize/` already handles spoken digit words, "oh" → 0,
   "double seven", "+1" prefixes, extension stripping, spoken date forms, two-digit year
   disambiguation, "at"/"dot" email repair, common domain typo repair, ZIP+4, full state names,
   letter-by-letter spelling and NATO-style "D as in dog". Asking the prompt to do the same thing
   creates two implementations that will disagree.
3. **It destroys the information the server needs.** This is the subtle one. `normalizeSpelledText`
   resolves "D-A-V-I-S, not D-A-V-I-E-S" correctly *because it can see the negation marker*. If the
   model helpfully sends `"Davies"` — the last-mentioned spelling, a very natural mistake — the
   server has nothing left to work with. The correction is destroyed before it reaches the code
   written to handle it.

The prompt therefore draws the line in one sentence: **the model decides which field a value
belongs to; the server decides what format it takes.** Both halves are stated explicitly, with
examples, because the rule is not intuitive. The model still has real work to do — splitting
"Austin, Texas, seven eight seven oh one" into three fields (there is no normalizer for that;
`normalizeState("Austin, Texas")` returns `null`), splitting a street from an apartment (there is no
normalizer for that either, and an unsplit value passes validation silently — a quality bug, not an
error), and mapping free-text sex answers onto the four-value enum (`parseSex` handles casing and
underscores, not "I'm a guy").

**Hard dependency.** This contract only holds if the Vapi tool handler runs the normalizers before
Zod. It does not hold today: `src/vapi/` does not exist yet, and `src/validation/patient.ts` carries
an explicit scope note saying it deliberately does *not* do voice normalization — its `toTenDigits`
strips non-digits, so "nine oh two…" becomes `""` and is rejected. The handler must apply this map
between `JSON.parse(arguments)` and `createPatientSchema`:

| Tool argument | Normalizer |
| --- | --- |
| `phone_number`, `emergency_contact_phone` | `normalizePhone` |
| `date_of_birth` | `normalizeDateOfBirth` |
| `email` | `normalizeEmail` |
| `zip_code` | `normalizeZip` |
| `state` | `normalizeState` |
| `first_name`, `last_name`, `insurance_member_id` | `normalizeSpelledText` |

A normalizer returning `null` means "shape unrecoverable" — pass the raw value through to Zod so the
caller gets the specific field error rather than a generic one. `city`, `address_line_1`,
`address_line_2`, `insurance_provider`, `emergency_contact_name` and `preferred_language` are free
text and are passed through untouched.

## 2.4 Why the optional fields are one offer, not three questions

Straight from the challenge's Conversational Note:

> The agent does NOT need to ask for every optional field on every call. It should collect required
> fields, then offer: *"I can also collect your insurance information, emergency contact, and
> preferred language. Would you like to provide any of those?"* — letting the caller opt in.

Three separate questions produce three separate declines and add roughly a minute to every call
that does not want them. One offer costs one turn and one answer, and a caller who says "just the
insurance" has told the model exactly which branch to take.

The prompt also fixes the shape of the negative case: **declined optional fields are omitted from
the tool call entirely, never sent as `null` or `""`.** Two concrete failures this prevents:
`preferred_language: null` is a 422 (the column is `NOT NULL DEFAULT 'English'` — phase-2 handoff
decision D4), and `insurance_provider: ""` would store an empty string that the API then returns as
a present-but-blank value. The read-back instruction has the matching rule — never mention a field
the caller declined, because "insurance, none; emergency contact, none" is a robot reciting a form.

`email` is deliberately not in the offer even though it is optional. It is the slowest field on a
phone call, has the highest transcription error rate, and is not in the challenge's suggested offer
text. It is accepted if volunteered.

## 2.5 What stops it sounding like an IVR

Tone rules only work when they are concrete. "Be natural" is unactionable; every rule in the *How
you speak* section is a behaviour the model can check itself against:

| Rule | Failure it prevents |
| --- | --- |
| One or two sentences per turn | The model's default is a paragraph. Over TTS, a paragraph is 20 seconds of monologue the caller cannot interrupt without feeling rude. |
| Never enumerate | "I'll need your name, date of birth, sex, phone number, and address" is a menu. It also invites the caller to answer all five at once, which sounds efficient and produces the worst transcription of the call. |
| Never say a field name aloud | Stops "address line one" and "sex enum" leaking. Schema vocabulary is the loudest possible tell. |
| Vary acknowledgements, never twice in a row | An unvaried "Got it." after every turn is the most machine-like artifact of an LLM on a phone, and it is invisible in text-based testing. |
| Banned-phrase list | These are the exact strings that make a caller think "recording". Naming them is more reliable than "avoid IVR language" — a prohibition on a literal string is one the model cannot reinterpret. |
| Contractions always | TTS renders "I will" and "do not" with the emphasis of formal speech. |
| No medical advice / cost discussion | Scope containment. Registration is the task; a model that starts triaging symptoms is a liability the challenge never asked for. |

The persona is a named person ("Nora") rather than "an AI assistant" because the model's register
follows its self-description, and "assistant" pulls toward customer-service boilerplate.

## 2.6 Corrections — worked dialogue

The challenge's own example is worked into the prompt as a literal case. Here is the full path
through the system, which is also the strongest demonstration of § 2.3:

```
Nora:   Hi, thanks for calling {{CLINIC_NAME}} — I can get you registered as a new patient.
        Can I start with your first and last name?

Caller: Sarah Davies.

Nora:   Thanks, Sarah. And what's your date of birth?

Caller: February fifteenth, ninety two. Oh — actually, my last name is spelled D-A-V-I-S,
        not D-A-V-I-E-S.

Nora:   Thanks for catching that — Davis. So that's February fifteenth, nineteen ninety-two?

Caller: That's right.

Nora:   And for the medical record, do you want that listed as male, female, or other? You're
        also welcome to decline.

Caller: I'm a woman.

Nora:   Thanks. What's the best phone number for you?

        [... phone and address collected ...]

Nora:   I can also take your insurance, an emergency contact, and your preferred language if
        you'd like — any of those?

Caller: Just skip it for now.

Nora:   No problem. Okay, let me make sure I've got this right. Sarah Davis, born February
        fifteenth, nineteen ninety-two. Sex, female. Phone, nine oh two, five five five, oh one
        four seven. And the address is 4120 Guadalupe Street, Austin, Texas, seven eight seven
        oh one. Did I get all that right?

Caller: Yep, that's right.

Nora:   Great, let me get that saved.
        -> create_patient {
             "first_name": "Sarah",
             "last_name": "my last name is spelled D-A-V-I-S, not D-A-V-I-E-S",
             "date_of_birth": "February fifteenth, ninety two",
             "sex": "Female",
             "phone_number": "nine oh two, five five five, oh one four seven",
             "address_line_1": "4120 Guadalupe Street",
             "city": "Austin",
             "state": "Texas",
             "zip_code": "seven eight seven oh one"
           }
```

The `last_name` argument is the point. It looks wrong and it is correct: `normalizeSpelledText`
splits on the negation marker `not`, takes the candidates *before* it, prefers the explicitly
spelled one, and returns `"Davis"`. Its own header comment names this exact case — a naive
scan-and-join returns `"Davisdavies"`, and taking the last run returns `"Davies"`, the value the
caller just said was wrong. The model passing the phrase through unaltered is what lets the tested
code do its job.

The rest of the pipeline on the same payload: `normalizeDateOfBirth` → `02/15/1992`,
`normalizePhone` → `9025550147`, `normalizeState` → `TX`, `normalizeZip` → `78701`, then
`createPatientSchema` validates all of it. **Verified by running the real modules** — every arrow
above is actual output, not an expectation.

Note also the two jobs the model did itself, which no normalizer could have done. Street, city,
state and ZIP came out of one spoken address. And `"I'm a woman"` became `"Female"` — `parseSex`
handles casing and underscores, not free text, so that mapping has to happen model-side or the field
is a 422.

Two behavioural details in that transcript are prompt-driven and worth naming. The correction
arrives *inside the answer to a different question*, and the model has to absorb both — the DOB and
the name fix — without dropping either or restarting. And the acknowledgement is four words; the
prompt explicitly forbids the model's instinct to over-apologise and re-read everything collected
so far.

A correction arriving *after* the read-back follows the same rule with one addition: re-confirm only
the delta ("Got it — Davis with an S. Everything else the same?"). Re-reading all nine fields
because one changed is how a two-minute call becomes a five-minute call.

## 2.7 Re-prompting on invalid data — and the tool-result channel that makes it possible

The requirement: *"If the caller provides invalid data (e.g., a 3-digit phone number, a future date
of birth), the agent must re-prompt specifically for that field."*

The prompt gives four worked re-prompts (future DOB, short phone, unrecognised state, wrong-length
ZIP) rather than a general rule, because the general rule ("explain the problem in plain language")
degrades into "Sorry, that didn't work, could you try again?" — which tells the caller nothing and
gets the same wrong input back. Each example models the same three-beat shape: brief apology, plain
explanation, one specific question.

The escalation ladder — repeat differently on the second failure, offer to skip or hand off on the
third — exists because a caller stuck in a re-prompt loop will hang up, and a hung-up call is a lost
registration with no record of why.

**Implementation constraint the handler author must respect.** Per
`docs/handoff/phase-1-vapi-contract.md` § 2.2, the speech precedence for a tool result carrying
`error` is: (1) an inline `message` of type `request-failed` on the result, (2) a `request-failed`
message from `tool.messages`, (3) a response generated by the model. § 5.5's draft tool definition
ships a canned `request-failed` — *"I'm sorry, I couldn't save that just now. Let me try once
more."* If that canned message stays on the tool, it fires on **every** error return and pre-empts
the model at step 2, and the per-field re-prompt requirement becomes unreachable no matter what this
prompt says.

Resolution, to be implemented in `src/vapi/`:

- **Field validation failures** → return `error` with **no inline `message`**, and **no canned
  `request-failed` on the tool definition**. Precedence falls through to (3) and the model applies
  the rules above. The `error` string is written as instruction to the model, not speech to the
  caller — e.g. `"date_of_birth is in the future; ask the caller for their birth year again."`
  The prompt's "never read the server's message out loud" rule is what keeps that text off the
  wire.
- **Infrastructure failures** (DB down, timeout) → return `error` *with* an inline `message` of type
  `request-failed`. Determinism is what you want when the system is broken; a model improvising
  around an unknown failure is a worse outcome than a fixed sentence.

Both paths return **HTTP 200** — see CLAUDE.md and § G5. Any other status is ignored by Vapi
entirely, which presents to the caller as silence.

## 2.8 Out-of-order answers, barge-in, and start-over

All three are named in the rubric — *"Does it handle interruptions or out-of-order responses?"* and
*"What if the caller wants to start over mid-conversation?"*

**Out of order** is handled by a memory rule rather than a flow rule: keep everything, never re-ask.
The prompt uses the exact scenario from the brief — caller volunteers the ZIP while being asked for
the city. Modelling it as "record both, skip the question you no longer need" avoids a state machine
the LLM would have to simulate.

**Barge-in** is half config, half prompt. The transport layer (Vapi `startSpeakingPlan` /
`stopSpeakingPlan`) decides *whether* the model is cut off mid-utterance; the prompt decides what
happens next, and the failure it prevents is specific: a model that gets interrupted during a nine-
field read-back and restarts the read-back from the top. The instruction is to resume from the
interruption point, not the beginning.

**Start over** has two failure modes and the prompt closes both. The model may partially reset
(keeping values it considers "already confirmed"), which produces a record mixing two attempts —
so the instruction is explicit that every value is discarded. And it may reset silently, leaving the
caller unsure whether it worked — so the reset is announced in the same breath as the first question
of the fresh pass.

## 2.9 Graceful failure and the ending

*"What if the database write fails — does the caller get an error or silence?"*

Silence is the failure mode being designed against, and it is the likely one: a slow or failed tool
call leaves the model with nothing to say. The prompt supplies the literal sentences for both
attempts, so there is no window in which the model is composing. It also fixes what must **not**
happen — no invented callback promise, no "you're registered" when nothing was saved, no error text
read aloud. The second-attempt script explicitly reassures the caller that a callback will be quick,
which is the honest and useful thing to say.

Note the deliberate asymmetry with § 2.7: infrastructure failure gets fixed wording, field failure
gets model-generated wording. Fixed wording is right when there is nothing to reason about; it is
wrong when the response must name a specific field and explain a specific problem.

**Ending.** The challenge asks for *"a brief confirmation (e.g., 'You're all set, [First Name].')
and end gracefully"* — so the prompt uses the first name and then stops. "Then stop" is an
instruction in its own right because the model's instinct is to append "Is there anything else I can
help you with?", which reopens a call that just ended well.

**UPDATED after live call testing — this section originally said the opposite.**

There is no *custom* `end_call` tool in the pinned contract, and the prompt must never reference a
custom tool that does not exist. But Vapi does expose a built-in hangup via
`endCallFunctionEnabled: true` on the assistant, which is now set. The model can therefore end the
call deliberately rather than hoping its farewell happens to match an `endCallPhrases` string.

That change was made because relying on phrases alone failed in production: the model said *"Take
care"*, which matched nothing, so the line stayed open through two more turns until it happened to
say *"Goodbye"* — long after the caller had said *"bye bye"*.

**And it immediately caused a worse bug, which is why the HARD GATE in Part 1 exists.** Handing the
model a hangup tool alongside a newly-prominent "Ending the call" section made hanging up the most
salient action after read-back confirmation — so on the next live call the model called `endCall`
*instead of* `create_patient`. The caller gave every field, confirmed, and nothing was written. The
only tool call in the entire four-minute call was `endCall`.

The general lesson, worth more than the specific fix: **a prompt is a priority ordering, not a set
of rules.** Adding an emphatic instruction near a decision point demotes whatever it competes with.
The save instruction had not changed — it just stopped winning. Hence the explicit numbered call
flow, the "steps 6 and 8 are different steps" line, and a gate that names the consequence rather
than merely stating a rule.

The counterpart in Part 1 — "Then stop, do not ask if there is anything else" — was also reversed
after the same round of testing: a caller reported the close felt abrupt. The agent now offers help
exactly once, then ends. Offering *once* is the whole design; offering repeatedly traps the caller
in a loop they have to escape twice.

## 2.10 Assistant configuration this prompt assumes

The prompt is not self-sufficient. These must match, per `docs/handoff/phase-1-vapi-contract.md`
§ 5.4:

| Setting | Value | Why |
| --- | --- | --- |
| `model.messages[0]` | this prompt, `role: "system"` | There is no top-level `systemPrompt` field. |
| `firstMessage` | *"Thanks for calling {{CLINIC_NAME}}, this is {{AGENT_NAME}}. Are you calling to register as a new patient?"* | Must match the prompt's opening move — call-flow step 1. A `firstMessage` that asks something else desynchronises the first turn. Deployed value lives in `scripts/create-assistant.mjs`. |
| `model.toolIds` | `create_patient`, `lookup_patient_by_phone`, `update_patient` | All three are referenced by the prompt: create on the happy path, the other two on the returning-caller branch (§ 2.11). |
| tool `async` | `false` | The caller must hear a real confirmation, not an optimistic one. Async resolves immediately and the model would announce success before the write happened. |
| tool `messages` | **no canned messages at all** | See § 2.7. A `request-failed` message fires at speech-precedence step 2 on every error return and pre-empts the model, making per-field re-prompts unreachable. |
| `endCallFunctionEnabled` | `true` | Lets the model hang up deliberately. Phrase matching alone left the line open — see § 2.9. |
| `endCallPhrases` / `endCallMessage` | set | Backstop for when the model narrates a farewell instead of calling the hangup function. |
| `maxDurationSeconds` | 600 | A registration that has not finished in ten minutes has gone wrong. |
| transcriber | Deepgram — consider `numerals` and `keywords` | DOB, ZIP, phone and member ID are the whole call. Flagged as worth revisiting in § 5.4 of the contract. |

## 2.11 Duplicate detection — full row only; phone lookup is for updates

Two different mechanisms, do not conflate them:

1. **Deduplication (server)** — `create_patient` / `POST /patients` compare the **entire
   demographic row**. Only an identical match returns the existing patient (`Already registered…`
   / HTTP 200). Same phone alone, or first+last name alone, still inserts a new row.
2. **Returning-caller offer (voice)** — `lookup_patient_by_phone` finds candidates on that number
   so the agent can offer `update_patient`. A phone hit is a hint to confirm identity, not proof of
   a duplicate registration.

Design points that keep the bonus from breaking the core path:

- **Phone lookup fires right after the number — once.** Anchored to the field it needs; no
   re-check mid-call.
- **A miss is silent; a failed lookup is ignored.** Never block registration on lookup errors.
- **Household sharing is expected.** `phone_number` is not unique. Confirm name/DOB before offering
   update; if it is not them, register separately via `create_patient`.

The offer wording is the challenge's own: *"It looks like we already have a record for [First]
[Last]. Would you like to update your information instead?"*

## 2.12 Still deliberately left out

- **Spanish.** It is a `transcriber`/`voice` change plus a prompt branch, and it
  cannot be half-done — a model that switches language mid-call without matching TTS produces
  Spanish text in an English voice.
- **Appointment scheduling.** Post-registration bonus, separate tool.
- **Explicit consent/HIPAA language.** The challenge FAQ: *"Do I need to handle HIPAA compliance?
  No."*

## 2.13 Known limitations

- The prompt assumes one patient per call. A caller registering a child, or two people on one call,
  is undefined behaviour — the model will most likely collect one record and ignore the second
  person.
- Sex is asked as a required field with no "why do you need that?" script beyond a one-sentence
  deflection. A caller who pushes back hard gets an unrehearsed answer.
- The read-back grows linearly with optional fields. A caller who accepts insurance, emergency
  contact and language gets a read-back of roughly fifteen values in one turn — long enough that
  barge-in handling matters more than usual.
- The "never re-ask" rule is a soft constraint on model memory, not enforced state. Over a long call
  with several corrections, drift is possible. The read-back is the backstop and is the reason it
  is non-negotiable.
- Every example phone number here is `902-555-0147`, which is fictional and passes the NANP rule
  `^[2-9]\d{2}[2-9]\d{6}$`. Note that `555-123-4567`, used in `docs/handoff/phase-2.md` § 3.0 and
  § 3.3, is **rejected** by the project's own validator — its exchange code starts with `1`. Do not
  copy it into prompts, tests, or demo scripts.
