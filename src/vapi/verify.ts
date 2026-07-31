// Webhook authentication for the /vapi/* routes.
//
// `server.secret` NO LONGER EXISTS in the Vapi API schema — the string
// `X-Vapi-Secret` appears zero times in the whole OpenAPI document
// (docs/handoff/phase-1-vapi-contract.md § G7, § 4). The supported mechanism at
// this phase is `server.headers`, a plain key/value map Vapi sends verbatim on
// every request (§ 4.3). So this is a shared-secret header check, not a
// signature: sufficient under TLS for SHIP-1, upgraded to a Custom Credential
// (Bearer or HMAC) in Phase 7.
//
// The secret is read from `process.env` on EVERY call, never captured at module
// load. Tests need to vary it, and a module-load capture would freeze whatever
// was set when the first import happened.

import { createHash, timingSafeEqual } from 'node:crypto';

/** What we configure in `assistant.server.headers` and `tool.server.headers`. */
export const WEBHOOK_SECRET_HEADER = 'x-vapi-webhook-secret';

/**
 * The legacy header the old inline `server.secret` produced. Accepted as a
 * fallback so a migration to a Bearer-Token Custom Credential with
 * `Header Name: X-Vapi-Secret` (§ 4.2) needs no code change here.
 */
export const LEGACY_WEBHOOK_SECRET_HEADER = 'x-vapi-secret';

export type VerifyResult =
  | { ok: true; reason: 'match' | 'unconfigured' }
  | { ok: false; reason: 'missing' | 'mismatch' };

/**
 * Constant-time compare.
 *
 * `timingSafeEqual` THROWS on unequal-length buffers, which would both leak the
 * secret's length and turn a bad header into a 500. Hashing both sides to a
 * fixed 32 bytes removes the length branch entirely.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Fastify gives `string | string[] | undefined`; only a single value counts. */
function headerValue(headers: Record<string, unknown>, name: string): string | null {
  const raw = headers[name];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return null;
}

/**
 * Verify an inbound webhook request.
 *
 * `reason: 'unconfigured'` is an ALLOW with a loud warning at the call site:
 * an unset `VAPI_WEBHOOK_SECRET` must not block local development or an ngrok
 * smoke test, but it must never be silent in production either. The route logs
 * it at `warn` on every request precisely so it is impossible to miss in a
 * deployed log stream.
 */
export function verifyWebhookSecret(headers: Record<string, unknown>): VerifyResult {
  const expected = process.env.VAPI_WEBHOOK_SECRET;

  if (expected === undefined || expected.trim().length === 0) {
    return { ok: true, reason: 'unconfigured' };
  }

  const presented =
    headerValue(headers, WEBHOOK_SECRET_HEADER) ??
    headerValue(headers, LEGACY_WEBHOOK_SECRET_HEADER);

  if (presented === null) return { ok: false, reason: 'missing' };
  if (!secretsMatch(presented, expected)) return { ok: false, reason: 'mismatch' };

  return { ok: true, reason: 'match' };
}
