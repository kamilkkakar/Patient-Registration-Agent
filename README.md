# Patient Registration Agent

A real U.S. phone number, answered by a voice agent. Speak naturally. Walk away with a validated patient record in Postgres — queryable over REST and visible on a live dashboard.

**Nora** (Savannah voice) is a warm intake coordinator: she greets you clearly, collects demographics including email, confirms them out loud, handles corrections, and only then saves. Optional insurance, emergency contact, and language are offered once — never forced.

---

## Trying it

**The demo phone number is not published.** Placing a call costs money and the line is not open to
the public. There are two ways to exercise the voice path:

1. **Ask for access.** Contact the author (see [License](#license)) and the number can be shared for
   a scheduled evaluation.
2. **Bring your own.** Point the service at your own Vapi account and phone number — see
   [Local setup](#local-setup), then run `scripts/create-tools.mjs` and `scripts/create-assistant.mjs`
   to provision an assistant against your own deployment. No credentials of the author's are needed
   or included.

The REST surface and dashboard can be exercised without any telephony at all — see [API](#api).

Voice path verified end-to-end on a live inbound call (lookup → create → hangup, with transcript linked).

---

## What it does

- **Natural voice intake** over a real PSTN number (not a rigid IVR menu)
- **Friendly registration flow** — clear hello, light-hearted tone, email asked on every call (skippable)
- **Confirm-before-save** with field-specific re-prompts when data is invalid
- **Spoken-input normalization** — *“nine oh two…”* → `9025550147`, *“February fifteenth, ninety two”* → `02/15/1992`
- **Full REST API** for list / get / create / update / soft-delete, with consistent JSON envelopes
- **Full-row deduplication** — identical demographics reuse the existing patient; shared household phones still get separate records
- **Returning-caller update offer** via phone lookup (separate from dedupe)
- **Call transcripts** linked to the patient when the call registered one
- **Mock appointment scheduling** offered after a successful save — three computed weekday slots, booked by id
- **Read-only dashboard** for reviewers — one static HTML page, same origin as the API

---

## Architecture

```
Caller ──► Vapi (STT · LLM · TTS) ──► Fastify API ──► Postgres
                                         │
                    Reviewer (curl / browser / dashboard)
```

One service handles both public REST and Vapi tool webhooks. Layers stay strict:

| Layer | Responsibility |
| --- | --- |
| `src/routes/` | HTTP only — no Prisma |
| `src/services/` | Business logic — **only** layer that touches the database |
| `src/validation/` | Zod schemas |
| `src/normalize/` | Spoken text → canonical values (pure, no I/O) |
| `src/vapi/` | Voice ingress → normalize → same services as REST |
| `prompts/intake-coordinator.md` | Versioned system prompt + engineering commentary |

Voice and REST share the service layer but normalize differently on purpose: a REST client sends `"5125550142"`; a caller says *“five one two, five five five, oh one four two.”* Parsing belongs on the voice boundary, not in the LLM and not in the public API.

---

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Telephony + voice | **Vapi** | STT, TTS, turn-taking, barge-in without building a media stack |
| Speech-to-text | **Deepgram nova-3** (numerals on) | Better phone / ZIP / DOB digit capture |
| LLM | **GPT-4.1 mini** (via Vapi) | Fast intake with a warm tone; strong enough for corrections |
| Backend | **Node.js · TypeScript · Fastify** | One process for REST + webhooks |
| Database | **Postgres · Prisma** | Real types (`DATE` for DOB, enums, soft-delete) |
| Hosting | **Railway** | App + DB together; no free-tier cold starts mid-call |
| Tests | **Vitest · Supertest** | Against real Postgres |

---

## API

Every JSON response uses `{ "data": ..., "error": null }` — including errors.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/patients` | Filters: `last_name`, `date_of_birth`, `phone_number` |
| `GET` | `/patients/:id` | `404` if missing or soft-deleted |
| `POST` | `/patients` | `201` new · `200` identical full-row already exists |
| `PUT` | `/patients/:id` | Partial updates |
| `DELETE` | `/patients/:id` | Soft-delete; returns the tombstoned record |
| `GET` | `/patients/:id/transcripts` | Call transcripts for that patient |
| `GET` | `/patients/:id/appointments` | Appointments for that patient; `404` if unknown or soft-deleted |
| `GET` | `/health` | `503` if the database is down |
| `GET` | `/` · `/dashboard` | Patients dashboard (HTML) |

**Vapi note:** `/vapi/*` always answers **HTTP 200** (including tool errors). Vapi ignores other status codes; errors travel in the tool result body.

```bash
export API=https://api-production-10c0.up.railway.app

curl -X POST "$API/patients" -H 'Content-Type: application/json' -d '{
  "first_name": "Sarah",
  "last_name": "Davis",
  "date_of_birth": "02/15/1992",
  "sex": "Female",
  "phone_number": "5125550142",
  "address_line_1": "1100 Congress Ave",
  "city": "Austin",
  "state": "TX",
  "zip_code": "78701"
}'
```

### Data model highlights

- All standard U.S. patient demographic fields, validated **server-side**
- `sex` stored as `DECLINE_TO_ANSWER` etc.; API accepts either form and returns display labels
- `preferred_language` defaults to `English`
- Phones are strict NANP (`5125550142` style) — not “any 10 digits”
- Soft-delete is invisible on all read paths

---

## Prompt & normalization

The graded system prompt lives in [`prompts/intake-coordinator.md`](prompts/intake-coordinator.md) — instructions plus commentary on why each rule exists.

Spoken forms are normalized in `src/normalize/` (covered by unit tests):

| Caller says | Stored as |
| --- | --- |
| `nine oh two, five five five, oh one four seven` | `9025550147` |
| `February fifteenth, ninety two` | `02/15/1992` |
| `sarah dot davis at gmail dot com` | `sarah.davis@gmail.com` |
| `Texas` | `TX` |
| `D-A-V-I-S, not D-A-V-I-E-S` | `Davis` |

---

## Local setup

**Needs:** Node ≥ 20, a reachable Postgres, and a [Vapi](https://vapi.ai) account (for the phone path).

```bash
git clone https://github.com/kamilkkakar/Patient-Registration-Agent.git
cd Patient-Registration-Agent

npm ci --ignore-scripts
npx prisma generate           # required: --ignore-scripts skips Prisma's postinstall
cp .env.example .env          # set DATABASE_URL (and Vapi vars for the phone path)
npx prisma migrate deploy
npm run db:seed               # two fictional demo patients
npm run dev
```

> Point `DATABASE_URL` at any Postgres instance. Production uses Railway’s managed database.

### Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres URL (Railway injects this in production) |
| `PORT` / `HOST` | no | Defaults `3000` / `0.0.0.0` |
| `PUBLIC_BASE_URL` | for voice | Public HTTPS base for Vapi webhooks |
| `VAPI_API_KEY` | for voice | Server-side only |
| `VAPI_WEBHOOK_SECRET` | for voice | Compared on every `/vapi/*` request |
| `VAPI_ASSISTANT_ID` | for voice scripts | Existing assistant to update in place |
| `VAPI_PHONE_NUMBER_ID` | for voice scripts | Number to attach inbound routing |

### Deploying

The Railway service is deployed from the CLI, **not** from a GitHub connection — pushing to the
repository does not deploy it. `railway.json` supplies the build and start commands (the start
command runs `prisma migrate deploy` before booting, so migrations apply on every deploy).

```bash
railway up                    # builds and deploys the current working directory
curl "$API/health"            # confirm uptime_seconds reset — that is the proof it redeployed
```

> If you add a GitHub integration to the service later, delete this note — two deploy paths that
> disagree is worse than one that is documented.

### Provisioning the voice agent

Once the API is publicly reachable, point Vapi at it. Re-running these is safe:
`scripts/create-tools.mjs` deletes its own previously-created tools first, so re-runs replace rather
than accumulate.

```bash
node scripts/create-tools.mjs        # creates the five tools, attaches them to the assistant
node scripts/create-assistant.mjs    # pushes the system prompt, voice and transcriber settings
```

**Deploy before you provision.** Attaching a tool the running API does not implement means a caller
who triggers it hears the agent stall mid-call — the API answers `Unknown tool`.

### Tests

```bash
# Requires DATABASE_URL pointing at a real Postgres, with `npx prisma generate`
# and `npx prisma migrate deploy` already run (see Local setup above).
npm test
npm run typecheck
```

---

## Edge cases & resilience

Each named scenario has a *decided* behavior, not an accidental one. Rows that are only voice-verified say so, and rows still waiting on a dedicated dial say that too.

| Scenario | Behavior | Evidence |
| --- | --- | --- |
| **Invalid DOB — future date** | Rejected server-side, never stored — `422` naming `date_of_birth` over REST. Over voice the tool returns a bare `error` naming the field and the word *future*, with **no** inline `request-failed` message, so Vapi's speech precedence falls to the model and Nora re-prompts that one field (*“I've got that as a date that hasn't happened yet…”*). | `tests/api/patients.create.test.ts` — *rejects a date of birth in the future with 422 naming date_of_birth*; `tests/vapi/tool.route.test.ts` — *validation failures carry NO inline request-failed message*. Live re-prompt **PENDING** a dial. |
| **Invalid DOB — impossible date** | `02/30/1992` fails the calendar check, including the full leap-year rule. On the voice path `normalizeDateOfBirth` returns `null` and the raw value is passed through to Zod, so the caller gets the field-specific error rather than a generic “Required”. | `tests/api/patients.create.test.ts` — *rejects a impossible calendar date with 422 naming date_of_birth*; `tests/normalize/date.test.ts` — *rejects impossible calendar dates* and *applies the full leap-year rule*; pass-through pinned by `tests/vapi/tool.route.test.ts` — *a normalizer returning null yields a FIELD-SPECIFIC error, not “required”*. |
| **Telephony drops mid-call** | **Decided: partial data is discarded, never persisted.** No draft row, no session state — the single patient write happens inside `create_patient` after the confirmed read-back, so a drop before that means the row never existed. The transcript still lands, with `patient_id` NULL. A substantial call (≥ 400 transcript chars **or** ≥ 60s) that registered nobody logs `vapi_call_completed_without_patient`, so a lost registration stays distinguishable from an abandoned dial. | `tests/vapi/events.test.ts` — *persists a long transcript that registered nobody…* (asserts `patient_id` NULL); `tests/vapi/events.without-patient.test.ts` — five threshold cases on `shouldWarnCallWithoutPatient`. |
| **DB write fails** | The caller never gets silence. The handler answers **HTTP 200** with an `error` *plus* an inline `request-failed` message — fixed wording, because a model improvising around an outage is worse than one sentence: *“I'm sorry — I've got all your details but our system isn't saving them right now. Let me try once more.”* The prompt retries once, then closes honestly rather than claiming the caller is registered. Logged with the server-generated `reqId` (`src/app.ts` sets `requestIdHeader: false` — ours, never the client's). | `tests/vapi/tool.infra-failure.test.ts` — create / lookup / update each → 200, error text, exact `INFRA_SPEECH`. |
| **Caller wants to start over** | Every collected value is thrown away and the reset is announced in the same breath as the first fresh question — no quiet partial reset that mixes two attempts. **Prompt-only by construction:** the server holds no state between tool calls, so there is nothing server-side to reset; the only state is the model's context. | `prompts/intake-coordinator.md` § “Starting over” and § 2.8. **PENDING** live proof — needs a dedicated dial. |

### Secondary cases

| Scenario | Behavior | Evidence |
| --- | --- | --- |
| **3-digit phone number** | `422` over REST; over voice a field-specific error with no inline message, so Nora asks for the full ten digits starting with the area code. Strict NANP — not “any 10 digits”. | `tests/api/patients.create.test.ts` — *rejects a three-digit phone number with 422 naming phone_number*; `tests/vapi/tool.route.test.ts` — *validation failures carry NO inline request-failed message* (uses `"five five five"`). **Voice-verified** on a live call — an incomplete first attempt drew a re-prompt for all ten digits. |
| **Gibberish input** | Junk never reaches storage. Digits, markup, emoji, underscores and the U+202E bidi override are all rejected on name fields; unparseable ZIP/phone/DOB return the field error rather than a silent drop. | `tests/api/patients.names.test.ts` — the ten cases under `describe('rejected names')`; `tests/vapi/tool.route.test.ts` — *a normalizer returning null yields a FIELD-SPECIFIC error*. |
| **Out-of-order answers** | Anything the caller volunteers early is kept and never asked for again; the model records both values and skips the question it no longer needs. Memory rule, not a state machine. | `prompts/intake-coordinator.md` § “Take everything they give you”, § 2.8. **Voice-verified** on a live call — the caller added an email after the read-back; Nora collected it and saved. |
| **Barge-in mid read-back** | Nora stops, takes the interruption as the turn, fixes that field and resumes the read-back from where she was — never from the top. Half transport config (`startSpeakingPlan` / `stopSpeakingPlan`), half prompt. | `prompts/intake-coordinator.md` § “Interruptions and listening”, § 2.8. **PENDING** live proof — needs a dedicated dial. |
| **Duplicate submission on retry** | Deduplication is **full-row**: an identical demographic record returns the existing patient (`200`, same id) rather than inserting a second, so a retried save is safe. A shared household phone or a matching name alone still creates a new record. End-of-call reports are idempotent on `vapi_call_id`. | `tests/api/patients.dedupe.test.ts` — *returns 201 on the first create and 200 with the same id on an identical second create*; `tests/vapi/events.test.ts` — *is IDEMPOTENT — the same vapi_call_id twice yields exactly one row*. |
| **Caller silence / timeout** | Nora waits, checks in once (*“Are you still there?”*), and after a second silence tells the caller to ring back and wraps up. `maxDurationSeconds: 600` is the hard backstop. **Unverified** — no automated test and no live-call evidence; the behavior is defined in the prompt and assistant config only. | `prompts/intake-coordinator.md` § “Silence and confusion”, § 2.10 (`maxDurationSeconds`). No test. |

---

## Known limitations

1. `GET /patients` is unpaginated (fine for demo scale).
2. REST (including transcripts) is unauthenticated — webhook auth protects `/vapi/*` only. Do not store real patient data.
3. Webhook auth is a shared header secret, not a cryptographic signature.
4. End-of-call summaries can arrive empty if Vapi’s summary step times out.
5. Not HIPAA-compliant — technical demo only.

### Nice-to-haves not built yet

Spanish language switch · rescheduling and cancelling appointments (booking only, for now) · real
clinic availability instead of computed mock slots · REST auth + pagination · editable dashboard ·
street-name spell-back for STT mishears.

Appointment scheduling is built and tested, but the offer has **not yet been exercised on a live
call** — the tool path is covered by the suite; the conversational half is not.

---

## License

**Proprietary — all rights reserved.** This is not open source. See [LICENSE](LICENSE) for the full
terms.

In short: you may read the code and run it locally on your own infrastructure to evaluate the work.
You may not use it in production or commerce, redistribute or republish it, create derivative works,
host it as a service, or use it (including its system prompt and normalization logic) as training
data for any AI model — without prior written permission.

No API keys, telephone numbers, or hosted infrastructure are licensed with it. Run it against your
own Vapi, model provider, database, and hosting accounts.

Not a medical device and not HIPAA-compliant. **Do not enter real patient data.** Use fictional data
only.

Permission requests, licensing enquiries, and demo access: **kamilkakar@gmail.com**
