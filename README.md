# Call Voice Agent for Patient Registration

Dial a real U.S. number. Speak naturally. Walk away with a validated patient record in Postgres — queryable over REST and visible on a live dashboard.

**Nora** answers as an intake coordinator: she collects demographics, confirms them out loud, handles corrections, and only then saves. Optional insurance, emergency contact, and language are offered once — never forced.

---

## Try it live

| | |
| --- | --- |
| **Phone** | **[+1 (662) 443-8181](tel:+16624438181)** |
| **Dashboard** | [Open the patient registry](https://api-production-10c0.up.railway.app/dashboard) |
| **API** | `https://api-production-10c0.up.railway.app` |

```bash
curl https://api-production-10c0.up.railway.app/health
curl https://api-production-10c0.up.railway.app/patients
```

Call the number, finish registration, then refresh the dashboard — your row should be there.

Voice path verified end-to-end on a live inbound call (lookup → create → hangup, with transcript linked). See [`SUBMISSION.md`](SUBMISSION.md) for the review pack.

---

## What it does

- **Natural voice intake** over a real PSTN number (not a rigid IVR menu)
- **Confirm-before-save** with field-specific re-prompts when data is invalid
- **Spoken-input normalization** — *“nine oh two…”* → `9025550147`, *“February fifteenth, ninety two”* → `02/15/1992`
- **Full REST API** for list / get / create / update / soft-delete, with consistent JSON envelopes
- **Full-row deduplication** — identical demographics reuse the existing patient; shared household phones still get separate records
- **Returning-caller update offer** via phone lookup (separate from dedupe)
- **Call transcripts** linked to the patient when the call registered one
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
| LLM | **GPT-4o** (via Vapi) | Strong enough for corrections and confirmations; latency-aware |
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

**Needs:** Node ≥ 20, Docker, a [Vapi](https://vapi.ai) account (for the phone path).

```bash
git clone https://github.com/kamilkkakar/Call-Voice-Agent-for-Patient-Registration.git
cd Call-Voice-Agent-for-Patient-Registration

npm ci --ignore-scripts
cp .env.example .env          # fill in values (never commit .env)
npm run db:up                 # Postgres on host port 55432
npx prisma migrate deploy
npm run db:seed               # two fictional demo patients
npm run dev
```

> Local Postgres is on **55432**, not 5432, so a native Postgres on the default port cannot shadow the container.

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

After the API is public:

```bash
node scripts/create-tools.mjs
node scripts/create-assistant.mjs
```

### Tests

```bash
npm run db:up
npm test
npm run typecheck
```

Repo contents inventory: [`REQUIRED_CONTENTS.md`](REQUIRED_CONTENTS.md).

---

## Known limitations

1. `GET /patients` is unpaginated (fine for demo scale).
2. REST (including transcripts) is unauthenticated — webhook auth protects `/vapi/*` only. Do not store real patient data.
3. Webhook auth is a shared header secret, not a cryptographic signature.
4. End-of-call summaries can arrive empty if Vapi’s summary step times out.
5. Not HIPAA-compliant — technical demo only.

### Nice-to-haves not built yet

Appointment scheduling after registration · Spanish language switch · REST auth + pagination · editable dashboard · street-name spell-back for STT mishears.

---

## License

Private assessment / demo project. Not for production clinical use.
