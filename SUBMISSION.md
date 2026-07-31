# Submission pack — Call Voice Agent for Patient Registration

## Links

| Item | Value |
| --- | --- |
| **Repository** | https://github.com/kamilkkakar/Call-Voice-Agent-for-Patient-Registration |
| **Phone number** | **+1 (662) 443-8181** |
| **API base URL** | https://api-production-10c0.up.railway.app |
| **Dashboard** | https://api-production-10c0.up.railway.app/dashboard |
| **Health** | https://api-production-10c0.up.railway.app/health |

Private repo — grant reviewer GitHub access as needed (`kamilkkakar`).

## How to verify (2 minutes)

1. Dial **+1 (662) 443-8181** and complete a registration (confirm the read-back).
2. Open the [dashboard](https://api-production-10c0.up.railway.app/dashboard) or:

```bash
curl https://api-production-10c0.up.railway.app/patients
```

3. Confirm the new row appears (newest first).

## Voice proof (SHIP-1)

| Call | Outcome |
| --- | --- |
| Call 1 | Saved imperfect STT data (prompt/hangup issues later fixed) |
| Call 2 | Confirmed but hung up without `create_patient` (fixed) |
| Call 3 (2026-07-31) | **PASS** — `lookup_patient_by_phone` → `create_patient` → `endCall`. Patient **James Jonathan** (`ee750726-4863-4eb2-92af-baab4579d35b`). Transcript + recording linked. |

## Stack

Vapi + GPT-4o · Fastify/TypeScript · Postgres/Prisma · Railway · Vitest.

## Notes for reviewers

- Do **not** use real patient data (demo / assessment only).
- REST is unauthenticated by design for this demo; `/vapi/*` is secret-protected.
- Full-row dedupe: identical demographics reuse the existing record; shared phones can still create separate patients.
- System prompt: `prompts/intake-coordinator.md`.
