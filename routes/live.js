/**
 * Live status: the till pushes, the owner reads.
 *
 * The write side is **lossy by design**. A heartbeat that fails is not queued
 * and not retried: by the time it could be redelivered a fresher one exists,
 * and a stale drawer figure arriving late is worse than nothing. That is what
 * lets this channel stay alive on a link far too weak to move a day's sales —
 * the sales channel has the opposite contract and never loses a row.
 *
 * The read side's job is to make sure a number is never presented as current
 * when it is not. Freshness is computed here, from when the *server* received
 * the heartbeat, and handed to the dashboard already decided — so a till with a
 * wrong clock shows as skewed rather than as fresh.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/pg');
const { requireBranch } = require('../middleware/branch-auth');
const { requireUser } = require('../middleware/session');

/**
 * Freshness bands.
 *
 * Derived from the 30s push interval: LIVE_MS is three missed beats, so
 * ordinary jitter never flickers the badge. OFFLINE_MS is deliberately short —
 * a 40-minute-old revenue figure must be structurally impossible to render as
 * current, because a stale number invites a decision in a way a blank does not.
 */
const LIVE_MS = 90 * 1000;
const OFFLINE_MS = 5 * 60 * 1000;

function freshnessOf(ageMs) {
  if (ageMs == null) return 'never';
  if (ageMs <= LIVE_MS) return 'live';
  if (ageMs <= OFFLINE_MS) return 'delayed';
  return 'offline';
}

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/**
 * POST /api/live/heartbeat — a till reports its current state.
 *
 * The branch comes from the API key, never from the body.
 */
router.post('/heartbeat', requireBranch, async (req, res) => {
  const body = req.body || {};
  const receivedMs = Date.now();
  const sentMs = num(body.sent_at_ms);

  try {
    /*
     * Ignore a snapshot older than the one already stored.
     *
     * Heartbeats are never retried, but they can still overtake each other: a
     * push that stalls for forty seconds and then completes would otherwise
     * overwrite the fresher one sent behind it, making the dashboard jump
     * backwards. Ordering is decided by the till's own clock, because only that
     * clock ordered the two snapshots.
     */
    if (sentMs != null) {
      const existing = await db.one(
        'SELECT till_sent_ms FROM live_status WHERE branch_id = $1', [req.branch.id]);
      if (existing && existing.till_sent_ms != null && sentMs < Number(existing.till_sent_ms)) {
        return res.json({ ok: true, superseded: true, server_time_ms: receivedMs });
      }
    }

    const shift = body.shift || null;
    const expenses = body.expenses_today || {};

    await db.run(`
      INSERT INTO live_status (
        branch_id, state, shift_local_id, staff_name, opened_at, opening_cash,
        total_orders, total_revenue, cash_revenue, non_cash_revenue,
        drawer_expenses, expense_count, expected_cash,
        expenses_today_total, expenses_today_count, menu_version,
        payload, till_sent_ms, server_received_ms, clock_skew_ms, agent_started_ms
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
      )
      ON CONFLICT (branch_id) DO UPDATE SET
        state                = EXCLUDED.state,
        shift_local_id       = EXCLUDED.shift_local_id,
        staff_name           = EXCLUDED.staff_name,
        opened_at            = EXCLUDED.opened_at,
        opening_cash         = EXCLUDED.opening_cash,
        total_orders         = EXCLUDED.total_orders,
        total_revenue        = EXCLUDED.total_revenue,
        cash_revenue         = EXCLUDED.cash_revenue,
        non_cash_revenue     = EXCLUDED.non_cash_revenue,
        drawer_expenses      = EXCLUDED.drawer_expenses,
        expense_count        = EXCLUDED.expense_count,
        expected_cash        = EXCLUDED.expected_cash,
        expenses_today_total = EXCLUDED.expenses_today_total,
        expenses_today_count = EXCLUDED.expenses_today_count,
        menu_version         = EXCLUDED.menu_version,
        payload              = EXCLUDED.payload,
        till_sent_ms         = EXCLUDED.till_sent_ms,
        server_received_ms   = EXCLUDED.server_received_ms,
        clock_skew_ms        = EXCLUDED.clock_skew_ms,
        agent_started_ms     = EXCLUDED.agent_started_ms
    `, [
      req.branch.id,
      // An explicit state, so the dashboard never has to infer "closed" from a
      // null shift and show "Rs 0" for a till that is simply shut for the night.
      String(body.state || 'unknown'),
      shift ? num(shift.local_id) : null,
      shift ? (shift.staff_name || null) : null,
      shift ? (shift.opened_at || null) : null,
      shift ? num(shift.opening_cash) : null,
      shift ? num(shift.total_orders) : null,
      shift ? num(shift.total_revenue) : null,
      shift ? num(shift.cash_revenue) : null,
      shift ? num(shift.non_cash_revenue) : null,
      shift ? num(shift.drawer_expenses) : null,
      shift ? num(shift.expense_count) : null,
      shift ? num(shift.expected_cash) : null,
      num(expenses.total),
      num(expenses.count),
      num(body.menu_version),
      // The whole snapshot, so a till that starts sending a new field does not
      // need a cloud migration deployed first.
      JSON.stringify(body),
      sentMs,
      receivedMs,
      sentMs != null ? receivedMs - sentMs : null,
      num(body.agent_started_ms),
    ]);

    // The response doubles as the downlink: the till compares menu_version to
    // decide whether to pull a new menu. Kept tiny so it survives a weak link.
    const menu = await db.one('SELECT version FROM menu_version WHERE id = 1');
    const settings = await db.one('SELECT version FROM settings_version WHERE id = 1');
    const staff = await db.one('SELECT version FROM staff_version WHERE id = 1');
    res.json({
      ok: true,
      server_time_ms: receivedMs,
      menu_version: menu ? Number(menu.version) : 0,
      // Carried on the same reply as the menu version, for the same reason:
      // the "nothing changed" case must not cost a request of its own.
      settings_version: settings ? Number(settings.version) : 0,
      staff_version: staff ? Number(staff.version) : 0,
    });
  } catch (err) {
    console.error('Heartbeat ingest failed:', err.message);
    res.status(500).json({ error: 'Could not record heartbeat' });
  }
});

/**
 * GET /api/live — every branch's current state, for the dashboard.
 *
 * `server_time_ms` is returned so the page can measure its *own* staleness. If
 * the dashboard's polling stops, the last response keeps rendering and nothing
 * on screen changes — a failure a per-card badge cannot catch, because every
 * card still believes it is fresh.
 *
 * Columns are listed explicitly rather than using `l.*`: that would re-introduce
 * `live_status.branch_id`, overwriting the `b.id AS branch_id` ahead of it, and
 * for a branch that has never reported the LEFT JOIN makes it NULL — leaving
 * the one branch the owner most needs to identify with no id at all.
 */
router.get('/', requireUser, async (req, res) => {
  try {
    const now = Date.now();

    const rows = await db.q(`
      SELECT
        b.id   AS branch_id,
        b.name AS branch_name,
        l.state,
        l.shift_local_id,
        l.staff_name,
        l.opened_at,
        l.opening_cash,
        l.total_orders,
        l.total_revenue,
        l.cash_revenue,
        l.non_cash_revenue,
        l.drawer_expenses,
        l.expense_count,
        l.expected_cash,
        l.expenses_today_total,
        l.expenses_today_count,
        l.menu_version,
        l.till_sent_ms,
        l.server_received_ms,
        l.clock_skew_ms,
        l.agent_started_ms
      FROM branches b
      LEFT JOIN live_status l ON l.branch_id = b.id
      WHERE b.active = 1
      ORDER BY b.id
    `);

    const branches = rows
      // A per-branch account (none today, but the column exists) sees only its site.
      .filter(row => !req.user.branchId || row.branch_id === req.user.branchId)
      .map(row => {
        // bigint arrives from pg as a string.
        const received = row.server_received_ms == null ? null : Number(row.server_received_ms);
        const ageMs = received == null ? null : now - received;

        return {
          branch_id: row.branch_id,
          branch_name: row.branch_name,
          freshness: freshnessOf(ageMs),
          age_ms: ageMs,
          server_received_ms: received,
          // Positive means the till's clock is behind ours. Surfaced because a
          // skewed clock corrupts every order's timestamp, not just this view.
          clock_skew_ms: row.clock_skew_ms == null ? null : Number(row.clock_skew_ms),
          state: row.state || null,
          shift: row.shift_local_id == null ? null : {
            local_id: row.shift_local_id,
            staff_name: row.staff_name,
            opened_at: row.opened_at,
            opening_cash: row.opening_cash,
            total_orders: row.total_orders,
            total_revenue: row.total_revenue,
            cash_revenue: row.cash_revenue,
            non_cash_revenue: row.non_cash_revenue,
            drawer_expenses: row.drawer_expenses,
            expense_count: row.expense_count,
            expected_cash: row.expected_cash,
          },
          expenses_today: {
            total: row.expenses_today_total,
            count: row.expenses_today_count,
          },
        };
      });

    res.json({
      server_time_ms: now,
      bands: { live_ms: LIVE_MS, offline_ms: OFFLINE_MS },
      branches,
    });
  } catch (err) {
    console.error('Live read failed:', err.message);
    res.status(500).json({ error: 'Could not read live status' });
  }
});

module.exports = router;
