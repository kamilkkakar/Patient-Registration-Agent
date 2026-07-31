// The `{ data, error }` response envelope.
//
// Challenge § 4: "Return JSON responses with consistent envelope:
// { "data": {...}, "error": null }".
//
// EVERY response body in this service goes through `ok()` or `fail()` —
// successes, validation failures, 404s and 500s alike. There are no bare bodies
// and no 204s (a 204 has no body and would break the invariant); see
// docs/handoff/phase-2.md § 2.

import type { ZodIssue } from 'zod';
import type { ErrorDetail } from './errors.js';

export const ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface EnvelopeError {
  code: ErrorCode;
  message: string;
  details: ErrorDetail[] | null;
}

export interface SuccessEnvelope<T> {
  data: T;
  error: null;
}

export interface ErrorEnvelope {
  data: null;
  error: EnvelopeError;
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

/** Success body. The HTTP status (200 vs 201) is chosen by the route. */
export function ok<T>(data: T): SuccessEnvelope<T> {
  return { data, error: null };
}

/** Error body. `data` is always null; `details` only for VALIDATION_ERROR. */
export function fail(
  code: ErrorCode,
  message: string,
  details: ErrorDetail[] | null = null,
): ErrorEnvelope {
  return { data: null, error: { code, message, details } };
}

/**
 * Map a Zod issue list onto `details[]`.
 *
 * Two issue shapes need explicit handling (handoff § 7.4):
 *   - normal field failures: `issue.path` is already the snake_case wire name,
 *     because the schemas are declared with wire keys.
 *   - `unrecognized_keys` (what `.strict()` throws): `issue.path` is `[]` and
 *     the offending keys live in `issue.keys`. One detail entry per key,
 *     otherwise the client sending `patient_id` is told nothing useful.
 *
 * Every issue is mapped, never just the first.
 */
export function zodIssuesToDetails(issues: readonly ZodIssue[]): ErrorDetail[] {
  const details: ErrorDetail[] = [];

  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        details.push({ field: key, message: 'Unknown field.' });
      }
      continue;
    }

    // A whole-object refinement (e.g. "at least one field") has an empty path.
    const field = issue.path.length > 0 ? issue.path.join('.') : 'body';
    details.push({ field, message: issue.message });
  }

  return details;
}
