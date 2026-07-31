// The dashboard's pure helpers, EXECUTED rather than grepped.
//
// Every other dashboard test is a source-regex assertion, which can only prove
// that the text of a fix is present. `nextAppointmentFor` picking a cancelled
// booking is a logic bug: before cancellation existed no row could carry a
// non-default status, so the omission was invisible and harmless — and would
// have become visible on a live dashboard the day the first caller cancelled.
//
// These functions are deliberately free of DOM and network access so they load
// under Node with no jsdom and no new dependency (Rule 13).

import { describe, expect, it } from 'vitest';

// Imported for its side effect, exactly as the browser loads it: the file
// assigns one object onto globalThis. `globalThis` is `window` in the page and
// the module global here, so the SAME file serves both with no build step.
import '../../public/dashboard-helpers.js';

interface Helpers {
  EMPTY: string;
  formatIsoDate: (value: unknown) => string;
  groupAppointments: (rows: unknown) => Record<string, { scheduled_for: string; status: string }[]>;
  nextAppointmentFor: (list: unknown, nowIso: string) => string;
}

const helpers = (globalThis as unknown as { DashboardHelpers: Helpers }).DashboardHelpers;

const NOW = '2026-08-01T00:00:00.000Z';
const EMPTY = '—';

describe('nextAppointmentFor', () => {
  it('ignores a CANCELLED booking', () => {
    // The bug this fix exists for.
    expect(
      helpers.nextAppointmentFor([{ scheduled_for: '2026-08-03T09:00:00.000Z', status: 'CANCELLED' }], NOW),
    ).toBe(EMPTY);
  });

  it('ignores a COMPLETED booking', () => {
    // WHY a whitelist and not "not CANCELLED": COMPLETED is equally not-upcoming
    // and equally unreachable today. A blacklist would have shipped this bug
    // twice.
    expect(
      helpers.nextAppointmentFor([{ scheduled_for: '2026-08-03T09:00:00.000Z', status: 'COMPLETED' }], NOW),
    ).toBe(EMPTY);
  });

  it('counts CONFIRMED as upcoming', () => {
    expect(
      helpers.nextAppointmentFor([{ scheduled_for: '2026-08-03T09:00:00.000Z', status: 'CONFIRMED' }], NOW),
    ).toBe('08/03/2026');
  });

  it('returns the soonest FUTURE booking, not merely the first in the list', () => {
    expect(
      helpers.nextAppointmentFor(
        [
          { scheduled_for: '2026-07-10T09:00:00.000Z', status: 'SCHEDULED' },
          { scheduled_for: '2026-08-05T09:00:00.000Z', status: 'SCHEDULED' },
        ],
        NOW,
      ),
    ).toBe('08/05/2026');
  });

  it('skips a cancelled booking to reach the live one behind it', () => {
    // The realistic shape after a caller reschedules by cancelling and rebooking:
    // the dead row sorts first and must not mask the live one.
    expect(
      helpers.nextAppointmentFor(
        [
          { scheduled_for: '2026-08-03T09:00:00.000Z', status: 'CANCELLED' },
          { scheduled_for: '2026-08-07T09:00:00.000Z', status: 'SCHEDULED' },
        ],
        NOW,
      ),
    ).toBe('08/07/2026');
  });

  it('returns the em-dash for an empty or unusable list', () => {
    expect(helpers.nextAppointmentFor([], NOW)).toBe(EMPTY);
    expect(helpers.nextAppointmentFor(undefined, NOW)).toBe(EMPTY);
  });
});

describe('groupAppointments', () => {
  it('skips malformed rows instead of throwing', () => {
    // WHY: this runs in a browser against live API data. One bad row must not
    // blank the entire registry — the page has no error boundary.
    const grouped = helpers.groupAppointments([
      null,
      { patient_id: 5 },
      { patient_id: 'a', status: 'SCHEDULED' },
    ]);

    expect(Object.keys(grouped)).toEqual(['a']);
  });

  it('preserves the ascending order the API returned, within a patient', () => {
    const grouped = helpers.groupAppointments([
      { patient_id: 'a', scheduled_for: '2026-08-03T09:00:00.000Z', status: 'SCHEDULED' },
      { patient_id: 'a', scheduled_for: '2026-08-10T09:00:00.000Z', status: 'SCHEDULED' },
    ]);

    expect(grouped['a']?.map((row) => row.scheduled_for)).toEqual([
      '2026-08-03T09:00:00.000Z',
      '2026-08-10T09:00:00.000Z',
    ]);
  });
});

describe('formatIsoDate', () => {
  it('renders MM/DD/YYYY from the UTC date part, never via new Date()', () => {
    // WHY: the suite runs at TZ=America/Los_Angeles. A local-time reading of this
    // instant lands on the previous calendar day.
    expect(helpers.formatIsoDate('2026-08-03T09:00:00.000Z')).toBe('08/03/2026');
  });

  it('returns the em-dash for a non-string', () => {
    expect(helpers.formatIsoDate(null)).toBe(EMPTY);
  });
});
