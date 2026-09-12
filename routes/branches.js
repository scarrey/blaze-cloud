/**
 * Branches, and how complete each one's data is.
 *
 * The completeness half matters more than it looks. A report that silently
 * omits the last three hours of a branch whose internet dropped is worse than
 * no report — it is a plausible number the owner will act on. So the dashboard
 * is told, alongside every report, how current each branch's data actually is,
 * and says so on screen.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/pg');
const { requireUser } = require('../middleware/session');

const BRANCHES_SQL = 'SELECT id, name, active FROM branches WHERE active = 1 ORDER BY id';

/*
 * The newest sale each branch has actually delivered.
 *
 * Taken from the data itself rather than from the sync cursor: the cursor says
 * when a batch last arrived, which is not the same as how recent the sales in
 * it were. A till that reconnects and sends yesterday's backlog has a very
 * recent sync and still-stale figures.
 */
const LATEST_SQL = `
  SELECT
    (SELECT MAX(created_at) FROM orders   WHERE branch_id = ?) AS latest_order_at,
    (SELECT MAX(created_at) FROM expenses WHERE branch_id = ?) AS latest_expense_at,
    (SELECT COUNT(*)::int   FROM orders   WHERE branch_id = ?) AS order_count
`;

const CURSOR_SQL =
  'SELECT table_name, rows_received, last_synced_ms FROM sync_cursor WHERE branch_id = ?';

const LIVE_SQL = 'SELECT server_received_ms FROM live_status WHERE branch_id = ?';

router.get('/', requireUser, async (req, res) => {
  try {
    const rows = (await db.q(BRANCHES_SQL))
      // A per-branch login, when one exists, sees only its own site.
      .filter(b => !req.user.branchId || b.id === req.user.branchId);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/branches/completeness — how far each branch's data actually reaches.
 */
router.get('/completeness', requireUser, async (req, res) => {
  try {
    const now = Date.now();
    const rows = (await db.q(BRANCHES_SQL))
      .filter(b => !req.user.branchId || b.id === req.user.branchId);

    const branches = await Promise.all(rows.map(async (b) => {
        const latest = await db.one(LATEST_SQL, [b.id, b.id, b.id]);
        const cursors = await db.q(CURSOR_SQL, [b.id]);
        // bigint arrives from pg as a string.
        const lastSyncMs = cursors.reduce(
          (max, c) => Math.max(max, Number(c.last_synced_ms) || 0), 0) || null;
        const live = await db.one(LIVE_SQL, [b.id]);

        return {
          branch_id: b.id,
          branch_name: b.name,
          order_count: latest.order_count,
          // The till's local wall-clock stamp on its most recent sale — what
          // the owner should compare against the clock on the wall.
          latest_order_at: latest.latest_order_at,
          latest_expense_at: latest.latest_expense_at,
          last_sync_ms: lastSyncMs,
          last_sync_age_ms: lastSyncMs ? now - lastSyncMs : null,
          // Present separately because a till can be heartbeating happily while
          // its sales backlog is still draining — the two channels are
          // independent by design.
          last_heartbeat_age_ms: live ? now - Number(live.server_received_ms) : null,
        };
    }));

    res.json({ server_time_ms: now, branches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
