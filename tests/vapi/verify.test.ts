// Webhook authentication. `server.secret` is gone from the API schema (§ G7),
// so this is a shared secret carried in a custom header via `server.headers`.

import { afterEach, describe, expect, it } from 'vitest';
import {
  LEGACY_WEBHOOK_SECRET_HEADER,
  WEBHOOK_SECRET_HEADER,
  verifyWebhookSecret,
} from '../../src/vapi/verify.js';

const ORIGINAL = process.env.VAPI_WEBHOOK_SECRET;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.VAPI_WEBHOOK_SECRET;
  else process.env.VAPI_WEBHOOK_SECRET = ORIGINAL;
});

describe('verifyWebhookSecret', () => {
  it('accepts the correct secret', () => {
    process.env.VAPI_WEBHOOK_SECRET = 'super-secret-value';

    expect(verifyWebhookSecret({ [WEBHOOK_SECRET_HEADER]: 'super-secret-value' })).toEqual({
      ok: true,
      reason: 'match',
    });
  });

  it('accepts the legacy X-Vapi-Secret header name', () => {
    process.env.VAPI_WEBHOOK_SECRET = 'super-secret-value';

    expect(verifyWebhookSecret({ [LEGACY_WEBHOOK_SECRET_HEADER]: 'super-secret-value' })).toEqual({
      ok: true,
      reason: 'match',
    });
  });

  it('rejects the wrong secret', () => {
    process.env.VAPI_WEBHOOK_SECRET = 'super-secret-value';

    expect(verifyWebhookSecret({ [WEBHOOK_SECRET_HEADER]: 'wrong' })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('rejects a missing header', () => {
    process.env.VAPI_WEBHOOK_SECRET = 'super-secret-value';

    expect(verifyWebhookSecret({})).toEqual({ ok: false, reason: 'missing' });
  });

  it('does not throw on a length mismatch (timingSafeEqual would)', () => {
    process.env.VAPI_WEBHOOK_SECRET = 'short';

    expect(() =>
      verifyWebhookSecret({ [WEBHOOK_SECRET_HEADER]: 'a-much-much-longer-presented-value' }),
    ).not.toThrow();
  });

  it.each(['', '   '])('allows with reason "unconfigured" when the env var is %p', (value) => {
    process.env.VAPI_WEBHOOK_SECRET = value;

    // ALLOW, so local development is never blocked — the route logs a loud
    // warning on every such request so production cannot be silently open.
    expect(verifyWebhookSecret({})).toEqual({ ok: true, reason: 'unconfigured' });
  });

  it('allows with reason "unconfigured" when the env var is absent entirely', () => {
    delete process.env.VAPI_WEBHOOK_SECRET;

    expect(verifyWebhookSecret({})).toEqual({ ok: true, reason: 'unconfigured' });
  });

  it('reads the env var at call time, not at module load', () => {
    delete process.env.VAPI_WEBHOOK_SECRET;
    expect(verifyWebhookSecret({}).reason).toBe('unconfigured');

    process.env.VAPI_WEBHOOK_SECRET = 'set-later';
    expect(verifyWebhookSecret({})).toEqual({ ok: false, reason: 'missing' });
  });
});
