// Pure-helper pin for the end-of-call "substantial call, no patient" warn.
// Fastify logger spies are fragile under LOG_LEVEL=silent; the decision rule
// lives in shouldWarnCallWithoutPatient so the thresholds stay testable.

import { describe, expect, it } from 'vitest';
import { shouldWarnCallWithoutPatient } from '../../src/vapi/routes.js';

describe('shouldWarnCallWithoutPatient', () => {
  it('is false when a patient is linked, regardless of length or duration', () => {
    expect(
      shouldWarnCallWithoutPatient({
        patientId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        transcriptLength: 1000,
        durationSeconds: 300,
      }),
    ).toBe(false);
  });

  it('is true when transcript length is >= 400 and patientId is null', () => {
    expect(
      shouldWarnCallWithoutPatient({
        patientId: null,
        transcriptLength: 400,
        durationSeconds: 5,
      }),
    ).toBe(true);
  });

  it('is true when duration is >= 60 and patientId is null', () => {
    expect(
      shouldWarnCallWithoutPatient({
        patientId: null,
        transcriptLength: 10,
        durationSeconds: 60,
      }),
    ).toBe(true);
  });

  it('is false for a short abandoned dial (below both thresholds)', () => {
    expect(
      shouldWarnCallWithoutPatient({
        patientId: null,
        transcriptLength: 399,
        durationSeconds: 59,
      }),
    ).toBe(false);
  });

  it('treats a null duration as zero (not a warn by itself)', () => {
    expect(
      shouldWarnCallWithoutPatient({
        patientId: null,
        transcriptLength: 10,
        durationSeconds: null,
      }),
    ).toBe(false);
  });
});
