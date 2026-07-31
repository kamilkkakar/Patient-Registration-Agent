# Voice AI Patient Registration

A voice agent that answers a real US phone number, collects standard U.S. patient demographics
through natural conversation, validates and persists them to Postgres, and exposes the records
through a REST API.

---

## Live demo

| | |
| --- | --- |
| **Phone number** | **+1 (662) 443-8181** — call it and register |
| **Dashboard** | **https://api-production-10c0.up.railway.app/dashboard** — the fastest way to see the whole system |
| **API base URL** | **https://api-production-10c0.up.railway.app** |
| **Health check** | https://api-production-10c0.up.railway.app/health |
| **Patient list** | https://api-production-10c0.up.railway.app/patients |

All live. Try it:

```bash
curl https://api-production-10c0.up.railway.app/health
curl https://api-production-10c0.up.railway.app/patients
```

Call the number, then open the dashboard — the record you just created by voice is in the table.

---

## Architecture

```
   PSTN                  Vapi                    This service              Postgres
┌──────────┐      ┌────────────────┐      ┌──────────────────────┐      ┌──────────┐
│  Caller  │◄────►│  STT · LLM ·   │◄────►│  /vapi/tool          │      │          │
│          │      │  TTS · barge-in│      │  /vapi/events        │─────►│ patients │
└──────────┘      └────────────────┘      │  ────────────────    │      │ call_    │
                                          │  normalize → validate│      │ transcr. │
                                          │        ↓             │      │ appoint. │
   Reviewer                               │  service layer       │      │          │
┌──────────┐                              │        ↓             │      └──────────┘
│  curl /  │─────────────────────────────►│  /patients (REST)    │
│  browser │                              └──────────────────────┘
└──────────┘
```

**Layer boundaries are enforced, not aspirational:**

- `src/routes/` — HTTP only. May not import Prisma.
- `src/services/` — business logic. The **only** layer that touches the database.
- `src/validation/` — Zod schemas. Never imports services.
- `src/normalize/` — pure functions turning spoken text into canonical values. No I/O.
- `src/vapi/` — the voice ingress. Normalizes, then calls the same service layer the REST API uses.
- `src/lib/serialize.ts` — the sole owner of the database→wire transform.

### Why the voice path and the REST path are separate ingresses

Both end at the same service layer, but they normalize differently on purpose.

A REST client sends `"5125550142"`. A caller says *"five one two, five five five, oh one four two."*
Normalization belongs at the voice boundary — pushing it into the REST layer would mean the public
API silently accepted sloppy input, and pushing it into the prompt would mean asking the LLM to be a
parser, which it does non-deterministically. See [Prompt engineering](#prompt-engineering).

---

## Tech stack, and the trade-offs behind it

| Layer | Choice | Why — and what it costs |
| --- | --- | --- |
| Telephony + voice | **Vapi** | Handles STT, TTS, turn-taking and barge-in. The challenge explicitly encourages this. **Cost:** vendor lock-in on the voice path, and the tool-call contract is theirs to change. |
| LLM | **GPT-4o** via Vapi | Voice is latency-dominated; 4o is the quality/latency balance. **Cost:** `gpt-4o-mini` would be faster and cheaper. The switch is one config field if live testing shows latency hurting. |
| Backend | **Fastify + TypeScript** | One service serves both the REST API and the Vapi webhooks. Strict TS end to end. **Cost:** none material at this size. |
| Database | **Postgres + Prisma** | The challenge grades schema design; Postgres gives real enums, `date` vs `timestamptz`, and check-able constraints. **Cost:** heavier than SQLite for a demo. Worth it — `date_of_birth` as a true `DATE` prevents an entire class of timezone bug. |
| Hosting | **Railway** | App + managed Postgres in one provider, no cold starts. **Cost:** not free. Chosen over Render/Fly free tiers *specifically because those sleep* — a reviewer dialling the number would hit a cold start mid-call. |
| Tests | **Vitest + Supertest** | Runs against real Postgres, not mocks. |

---

## Data model

All 19 fields from the challenge specification, with the validation rules enforced **server-side** —
the voice agent is never the only line of defence.

Three decisions worth flagging, because a reviewer would otherwise assume they were accidents:

**`sex` enum.** The challenge specifies `Decline to Answer`, which contains a space and cannot be a
Postgres enum member. Stored as `DECLINE_TO_ANSWER`; the API accepts either form case-insensitively
and always returns the display form.

**`preferred_language`.** The challenge marks it optional but also specifies "Default: English".
Stored `NOT NULL DEFAULT 'English'` — optional *from the caller*, never null *in storage*. A client
sending explicit `null` gets a 422. Making it nullable *and* defaulted would create three states
where the domain has two.

**Phone validation is strict NANP** (`^[2-9]\d{2}[2-9]\d{6}$`), not merely ten digits. This means
`555-123-4567` is rejected — exchange code `123` is not legal. Examples throughout this README use
`(512) 555-0142`, which is valid.

### Soft delete

`DELETE /patients/:id` sets `deleted_at` and bumps `updated_at`. It never hard-deletes.

Every read path excludes tombstoned rows: the list endpoint, all three query filters, and
`GET /patients/:id` (404). A soft-deleted id and a nonexistent id return **byte-identical** bodies,
so deletion is not observable through response differences.

---

## API

Every response — success and error alike — uses the envelope `{ "data": ..., "error": null }`.
There are no bare bodies and no `204`s, since a 204 has no body and would break the invariant.

Two deliberate carve-outs, neither of which weakens it: `GET /` and `/dashboard` return HTML because
they are a web page, not an API resource — but a 404 or 405 against those paths is still enveloped
JSON. And `/vapi/*` returns **HTTP 200 for every outcome including errors**, because Vapi discards
any other status code entirely; the error travels in the tool result instead. That is why the Vapi
routes are registered in their own encapsulation context with their own error handler.

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/patients` | Filters: `?last_name=` `?date_of_birth=` `?phone_number=` |
| `GET` | `/patients/:id` | 404 on unknown **or** soft-deleted |
| `POST` | `/patients` | 201 with the created record |
| `PUT` | `/patients/:id` | Partial updates allowed |
| `DELETE` | `/patients/:id` | Soft delete; returns the tombstoned record |
| `GET` | `/patients/:id/transcripts` | Call transcripts linked to this patient. 404 on unknown or soft-deleted |
| `GET` | `/health` | Deep check — 503 if Postgres is unreachable |
| `GET` | `/` and `/dashboard` | The patients dashboard (HTML) — see below |

**Status codes.** `400` malformed (bad JSON, invalid UUID) · `422` well-formed but invalid
(validation) · `404` not found · `500` unexpected. The 400/422 split is deliberate so "malformed
UUID" and "unknown UUID" remain distinguishable.

```bash
curl -X POST "$API/patients" -H 'Content-Type: application/json' -d '{
  "first_name": "Sarah", "last_name": "Davis",
  "date_of_birth": "02/15/1992", "sex": "Female",
  "phone_number": "5125550142",
  "address_line_1": "1100 Congress Ave", "city": "Austin",
  "state": "TX", "zip_code": "78701"
}'
```

---

## Dashboard (bonus — delivered)

**https://api-production-10c0.up.railway.app/dashboard**

A read-only view of the registry: filterable table, click a row for the full record including the
optional fields, insurance and emergency contact. It is the fastest way to watch a phone call turn
into a database row.

It is **one static HTML file** — [`public/dashboard.html`](public/dashboard.html) — served by
`@fastify/static` from the same origin as the API. No build step, no framework, no npm runtime
dependency, and **no external request of any kind**: no CDN, no web font, no remote image. It renders
identically on a machine with no internet access.

| Decision | Why |
| --- | --- |
| No second build pipeline | A React app would need bundling, a dev server and a deploy step to render one table. The whole page is 26 KB. |
| Same origin as the API | `fetch('/patients')` needs no CORS layer, no base URL to configure, and no drift between two copies of the patient shape. |
| `@fastify/static` with `serve: false` | The default mount installs a catch-all `GET /*` that would sit in front of every unmatched path and take over the envelope 404. With `serve: false` the plugin registers **no** routes — only `reply.sendFile` — so `/patients` cannot be shadowed by construction. |
| Filters gated client-side | `?phone_number=` 400s unless the value normalizes to ten digits. A 300 ms debounce alone would still fire on `512` and replace the table with an error banner en route to a valid query, so a partial value is held back and explained inline. |
| `textContent`, never `innerHTML` | `city` and `address_line_1` accept arbitrary characters server-side. String-concatenated HTML here would be a stored-XSS path through our own `POST /patients`. Enforced by a test. |
| Dates formatted by string surgery | `toLocaleDateString()` emits `DD/MM/YYYY` under a non-US locale. Same UTC discipline as `src/lib/serialize.ts` — no value is ever passed through `new Date()`. |

Legible in both light and dark browser themes (`color-scheme: light dark` plus a full dark palette),
and the table collapses to labelled cards below 780 px so it is usable on a phone.

---

## Prompt engineering

The system prompt is a first-class, versioned artifact: **[`prompts/intake-coordinator.md`](prompts/intake-coordinator.md)**

It contains the prompt itself plus engineering commentary explaining *why* each instruction exists
and what failure it prevents. Highlights:

- **Fields are grouped, not enumerated.** "Can I get your first and last name?" — not one question
  per database column. Enumeration is what makes an agent sound like an IVR.
- **Read-back before saving is a hard gate.** Nothing is written until the caller confirms.
- **Normalization is delegated to the server.** The prompt tells the model to pass through what the
  caller actually said. The model picks the *field*; the server picks the *format*.
- **Re-prompts are field-specific.** On rejection the agent asks for that one field and explains why
  in plain language — never "sorry, try again", never a raw error string.
- **One opt-in offer** covers insurance, emergency contact, and language, per the challenge's
  conversational note — instead of interrogating the caller field by field.

---

## Voice input normalization

The hardest sub-problem in this build, and the reason the agent doesn't ask people to repeat
themselves. 72 unit tests in `tests/normalize/`.

| Input | Becomes |
| --- | --- |
| `"nine oh two, five five five, oh one four seven"` | `9025550147` |
| `"February fifteenth, ninety two"` | `02/15/1992` |
| `"sarah dot davis at gmail dot com"` | `sarah.davis@gmail.com` |
| `"seven eight seven oh one"` | `78701` |
| `"Texas"` | `TX` |
| `"my last name is spelled D-A-V-I-S, not D-A-V-I-E-S"` | `Davis` |

When a normalizer can't produce a valid value it returns `null` and the **raw** input is passed to
validation — so the caller gets a specific error about that field rather than a silent drop.

---

## Setup

**Prerequisites:** Node ≥ 20, Docker, a Vapi account.

```bash
git clone <repo> && cd patient_registration_voice_agent
npm install
cp .env.example .env          # then fill in the values below
npm run db:up                 # Postgres 16 in Docker
npx prisma migrate deploy
npm run db:seed               # 2 fictional demo patients
npm run dev
```

> **Port note:** the container maps host **55432**, not 5432. A native Postgres on 5432 will
> otherwise shadow it — during this build that silently swallowed a migration, with Prisma
> reporting success the whole time.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection. Railway injects its own. |
| `PORT` / `HOST` | no | Defaults `3000` / `0.0.0.0`. Keep `0.0.0.0` on Railway. |
| `NODE_ENV` / `LOG_LEVEL` | no | `LOG_LEVEL` is a pino level (`silent` / `info` / …). |
| `PUBLIC_BASE_URL` | for voice | Public HTTPS URL registered as the Vapi tool webhook. |
| `VAPI_API_KEY` | for voice | Server-side only. Never commit. |
| `VAPI_WEBHOOK_SECRET` | for voice | Shared secret sent via `server.headers` and compared on every `/vapi/*` request. |

Secrets live only in `.env`, which is gitignored. Verified: no credential appears in any tracked
file or in git history.

### Tests

Local Postgres (Docker) must be up on port **55432** (`npm run db:up`).

```bash
npm test          # Vitest + Supertest — API + Vapi tool contracts
npm run typecheck
```

What belongs in this repo vs what does not is listed in [`REQUIRED_CONTENTS.md`](REQUIRED_CONTENTS.md).

---

## Known limitations

Honest list. These are choices and gaps, not surprises.

1. **`GET /patients` is unpaginated.** Fine at demo scale, wrong at real scale.
2. **No authentication on the REST API — and that now includes call transcripts.** Anyone with a
   patient UUID can read `GET /patients/:id/transcripts` and get the full recorded conversation and
   recording URL. Out of scope for the assessment (the FAQ waives HIPAA and says not to store real
   patient data), but it is the most sensitive surface in the system and a real deployment needs
   auth on `/patients` before anything else. The Vapi webhook *is* secret-protected.
3. **Webhook auth is a shared secret, not a signature.** Replayable within TLS. Vapi removed
   `server.secret` from its schema; a Custom Credential is the stronger upgrade.
4. **Transcript persistence lags the hangup.** Vapi's end-of-call report fires after
   post-processing. Its summary step has a 5-second default timeout that fails *silently* to an
   empty summary.
5. **Emoji are rejected in names but accepted in `city` and `address_line_1`** — the challenge
   specifies a charset for names only.
6. **No HIPAA anything.** Explicitly out of scope per the challenge FAQ. Do not put real patient
   data in this system.

---

## Next steps

In priority order, if the window continued:

**Bonuses delivered:**

- **[Patients dashboard](#dashboard-bonus--delivered)** — filterable read-only registry view.
- **Duplicate detection** — the server treats two patients as the same only when the **entire
  demographic row** matches (not phone alone, not first+last name alone). A second create with
  identical fields returns the existing record. Phone lookup is separate: it only powers the
  returning-caller *update* offer; households on one number still get distinct registrations.
- **Call transcripts** — stored per call and linked to the patient the call registered, via
  `GET /patients/:id/transcripts`.
**Still open, in priority order:**

1. Appointment scheduling after registration (schema already supports it).
2. Spanish language switching.
3. Pagination, and auth on the REST layer. The dashboard renders the whole list in one request,
   which is the same unpaginated limitation the API has.
4. Write access from the dashboard — it is deliberately read-only today, because an unauthenticated
   page that can edit patient records is worse than no page at all.
5. Have the agent spell the street name back for confirmation. A phone number has 10 digits and a
   ZIP has 5, so a mishearing is detectable; a street address has no such checksum, and live testing
   produced `"232 felt liver street"` from a real caller with no way to catch it.

---

## Engineering note

**A green exit code is not verification.** After any state-changing operation, confirm the change
through a channel independent of the tool that made it. Build process logs and coding-agent harness
files are intentionally not in this repository (see `REQUIRED_CONTENTS.md`).
