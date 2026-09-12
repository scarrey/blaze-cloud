/**
 * Today's date as the shop experiences it.
 *
 * `new Date().toISOString()` is UTC, so at UTC+5 it names yesterday for the
 * first five hours of every trading day — which silently dropped the early
 * morning's takings and payouts out of a "today" default. Everything else in
 * this codebase already writes local wall-clock time (see db/database.js), and
 * this is the read-side counterpart.
 */
function localToday() {
  // en-CA formats as YYYY-MM-DD, which is what SQLite's DATE() compares.
  return new Date().toLocaleDateString('en-CA');
}

module.exports = { localToday };
