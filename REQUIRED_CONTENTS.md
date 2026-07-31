# Repository contents — mandatory vs not necessary

Scope: what must stay in git for the **Voice AI patient registration agent** (API + Vapi tools + Postgres + deploy) to build, run, stay operable, and stay regression-tested.

## Mandatory (keep in git)

| Path | Why |
| --- | --- |
| `src/` | Runtime service: REST, Vapi webhooks, normalize, validation, services |
| `prisma/schema.prisma` | Database model |
| `prisma/migrations/` | Schema applied on deploy (`prisma migrate deploy`) |
| `prisma/seed.ts` | Demo patients for setup |
| `public/dashboard.html` | Dashboard served by the API |
| `prompts/intake-coordinator.md` | Source of the live Vapi system prompt (`scripts/create-assistant.mjs` reads it) |
| `scripts/create-assistant.mjs` | Create/update the Vapi assistant from the prompt |
| `scripts/create-tools.mjs` | Create/wire Vapi tools + webhook URLs |
| `package.json` | Dependencies and npm scripts |
| `package-lock.json` | Locked installs (`npm ci`) |
| `tsconfig.json` | Typecheck |
| `tsconfig.build.json` | Production compile |
| `railway.json` | Railway build/start/healthcheck |
| `.env.example` | Required env var **names** (never values) |
| `.gitignore` | Keeps secrets and junk out of git |
| `README.md` | Setup, live URLs, architecture (challenge submission requirement) |
| `REQUIRED_CONTENTS.md` | This inventory |
| `SUBMISSION.md` | Reviewer pack: repo, phone, API, verification steps |
| `tests/` | Voice + API regression suite — pins contracts the phone agent depends on |
| `vitest.config.ts` | Test runner (`npm test`) |
| `docker-compose.yml` | Local Postgres for tests (`localhost:55432`) |

## Not necessary for the agent to function

These may exist locally for humans or AI coding sessions. They are **not** loaded by the running service.

| Path | Why not necessary |
| --- | --- |
| `.claude/` | Claude Code agents, hooks, settings — coding harness only |
| `.cursor/` | Cursor agents, skills, rules, plans — coding harness only |
| `session-logs/` | Build process logs / warden state — not runtime |
| `docs/` | Execution plans, handoffs, voice-QA notes — process docs |
| `CLAUDE.md` | Instructions for AI coding assistants — not runtime |
| `voice-ai-agent-challenge.md` | Challenge brief copy — reference only |
| `*.pdf` | Challenge PDF — reference only |

## Never commit (secrets / generated)

| Path | Why |
| --- | --- |
| `.env` | Secrets |
| `node_modules/` | Install from lockfile |
| `dist/` | Build output |
