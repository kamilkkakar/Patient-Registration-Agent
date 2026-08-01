// Pure helpers shared by the dashboard page and its unit tests.
//
// Split out of dashboard.html deliberately. Every other dashboard test is a
// source-regex assertion, which can only prove that the TEXT of a change is
// present — and `nextAppointmentFor` is real logic whose bug (counting a
// cancelled booking as "next") a regex could never catch. Extracting it buys a
// test that executes, with no jsdom and no new dependency.
//
// The cost, taken knowingly: the dashboard is no longer a single self-contained
// file. Everything here stays free of DOM and network access so it loads under
// Node as readily as in the browser.
//
// ES5 idiom (var / function) to match the page — there is no build step, so an
// arrow function or template literal would ship untranspiled.

(function (root) {
  'use strict';

  var EMPTY = '—'; // em dash, used wherever a value is absent

  /**
   * The statuses that count as a live booking.
   *
   * A WHITELIST, not a blacklist of CANCELLED. COMPLETED is equally not-upcoming
   * and equally unreachable today, so a blacklist would have shipped the same
   * bug a second time. Mirrors ACTIVE_APPOINTMENT_STATUSES in
   * src/services/appointment.ts, so the voice path and this page agree on what
   * "upcoming" means.
   */
  var ACTIVE_STATUSES = { SCHEDULED: true, CONFIRMED: true };

  /**
   * MM/DD/YYYY from the UTC date part of an ISO instant.
   *
   * Read with a regex rather than `new Date()`: the page renders in the viewer's
   * timezone, and a local-time reading of a 09:00Z slot lands on the previous
   * calendar day for anyone west of UTC.
   */
  function formatIsoDate(value) {
    if (typeof value !== 'string') return EMPTY;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    return m ? m[2] + '/' + m[3] + '/' + m[1] : value;
  }

  /** Flat API list -> patient_id -> appointment[]. Order is preserved. */
  function groupAppointments(rows) {
    var byPatient = Object.create(null);
    if (!rows || typeof rows.length !== 'number') return byPatient;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      // One malformed row must not blank the whole registry: this runs in a
      // browser against live data and the page has no error boundary.
      if (!row || typeof row.patient_id !== 'string') continue;
      if (!byPatient[row.patient_id]) byPatient[row.patient_id] = [];
      byPatient[row.patient_id].push(row);
    }

    return byPatient;
  }

  /**
   * The soonest LIVE booking still ahead of `nowIso`, as MM/DD/YYYY.
   *
   * Compared as STRINGS: both sides are fixed-width ISO 8601 UTC, so a
   * lexicographic compare is a chronological one — and no value that arrived
   * from the API is ever handed to `new Date()`.
   *
   * The status check is the fix: without it a cancelled slot displays as the
   * patient's next appointment.
   */
  function nextAppointmentFor(list, nowIso) {
    if (!list || typeof list.length !== 'number') return EMPTY;

    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      if (!row || typeof row.scheduled_for !== 'string') continue;
      if (!ACTIVE_STATUSES[row.status]) continue;
      if (row.scheduled_for > nowIso) return formatIsoDate(row.scheduled_for);
    }

    return EMPTY;
  }

  // One global, assigned the same way in both worlds. `globalThis` is `window`
  // in the browser and the module global under Node, so the page loads this with
  // a plain <script src> and the unit test imports it for its side effect — no
  // CommonJS branch, and nothing to get wrong now that package.json is
  // "type": "module" and a .js file here is ESM.
  root.DashboardHelpers = {
    EMPTY: EMPTY,
    formatIsoDate: formatIsoDate,
    groupAppointments: groupAppointments,
    nextAppointmentFor: nextAppointmentFor
  };
})(globalThis);
